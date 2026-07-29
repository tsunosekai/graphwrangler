// グラフストア。すべての変更は操作ログ（ops.jsonl）を通り、snapshot.json は
// その適用結果にすぎない（docs/design.md 3.2）。snapshot 直接編集は禁止。
import path from "node:path";
import {
  ActorSchema,
  type Actor,
  type Node,
  NodeInputSchema,
  type NodeInput,
  NodePatchSchema,
  type NodePatch,
  type OpRecord,
  OpRecordSchema,
} from "./schema.js";
import { nextId, nowIso } from "./ids.js";
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from "./storage.js";

/** 操作の帰属メタデータ。省略時は human/ui（desk の actor 既定と同じ思想） */
export interface OpMeta {
  actor?: Actor;
  via?: string;
}

export class GraphError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
  }
}

interface Snapshot {
  nodes: Node[];
}

export class GraphStore {
  private nodes = new Map<string, Node>();
  private opsPath: string;
  private snapshotPath: string;

  constructor(private dataDir: string) {
    this.opsPath = path.join(dataDir, "ops.jsonl");
    this.snapshotPath = path.join(dataDir, "snapshot.json");
    const snap = readJson<Snapshot>(this.snapshotPath);
    if (snap) {
      for (const n of snap.nodes) this.nodes.set(n.id, n);
    }
  }

  // ---- 読み取り ----

  state(): { nodes: Node[] } {
    return { nodes: [...this.nodes.values()] };
  }

  get(id: string): Node {
    const n = this.nodes.get(id);
    if (!n) throw new GraphError(`node not found: ${id}`, 404);
    return n;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  /** frontier: status が done/dropped 以外で、parents が全て done のノード */
  frontier(): Node[] {
    return [...this.nodes.values()].filter(
      (n) =>
        n.status !== "done" &&
        n.status !== "dropped" &&
        n.parents.every((p) => this.nodes.get(p)?.status === "done"),
    );
  }

  /** id とその子孫すべて */
  collectDescendants(id: string): Set<string> {
    const childrenOf = new Map<string, string[]>();
    for (const n of this.nodes.values()) {
      for (const p of n.parents) {
        const list = childrenOf.get(p) ?? [];
        list.push(n.id);
        childrenOf.set(p, list);
      }
    }
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const c of childrenOf.get(cur) ?? []) {
        if (!seen.has(c)) {
          seen.add(c);
          stack.push(c);
        }
      }
    }
    return seen;
  }

  // ---- 書き込み（すべて操作ログ経由） ----

  addNode(input: NodeInput, meta: OpMeta = {}): Node {
    const parsed = NodeInputSchema.parse(input);
    this.validateParents(null, parsed.parents);
    const ts = nowIso();
    const node: Node = {
      ...parsed,
      id: nextId("n", this.nodes.keys()),
      pendingRequest: null,
      created: ts,
      updated: ts,
    };
    this.commit({ op: "node.add", payload: { node } }, meta);
    return node;
  }

  patchNode(id: string, patch: NodePatch, meta: OpMeta = {}): Node {
    this.get(id);
    const parsed = NodePatchSchema.parse(patch);
    if (parsed.parents) this.validateParents(id, parsed.parents);
    this.commit({ op: "node.patch", payload: { nodeId: id, patch: parsed } }, meta);
    return this.get(id);
  }

  /** MVP: 子を持つノードは消せない（先に子を消すか繋ぎ替える） */
  removeNode(id: string, meta: OpMeta = {}): void {
    this.get(id);
    const children = [...this.nodes.values()].filter((n) => n.parents.includes(id));
    if (children.length > 0) {
      throw new GraphError(
        `node ${id} has ${children.length} children; remove or reparent them first`,
      );
    }
    this.commit({ op: "node.remove", payload: { nodeId: id } }, meta);
  }

  // ---- 内部 ----

  private validateParents(selfId: string | null, parents: string[]): void {
    for (const p of parents) {
      if (!this.nodes.has(p)) throw new GraphError(`parent not found: ${p}`);
    }
    if (selfId) {
      if (parents.includes(selfId)) {
        throw new GraphError("node cannot be its own parent");
      }
      const descendants = this.collectDescendants(selfId);
      for (const p of parents) {
        if (descendants.has(p)) {
          throw new GraphError(`cycle: ${p} is a descendant of ${selfId}`);
        }
      }
    }
  }

  private commit(op: Omit<OpRecord, "id" | "ts" | "actor" | "via">, meta: OpMeta): void {
    const record: OpRecord = OpRecordSchema.parse({
      id: nextId("op", []) + "-" + Math.random().toString(36).slice(2, 8),
      ts: nowIso(),
      actor: ActorSchema.parse(meta.actor ?? { kind: "human" }),
      via: meta.via ?? "ui",
      ...op,
    });
    this.apply(record);
    appendJsonl(this.opsPath, record);
    writeJsonAtomic(this.snapshotPath, { nodes: [...this.nodes.values()] });
  }

  private apply(record: OpRecord): void {
    switch (record.op) {
      case "node.add": {
        this.nodes.set(record.payload.node.id, record.payload.node);
        break;
      }
      case "node.patch": {
        const cur = this.nodes.get(record.payload.nodeId);
        if (!cur) throw new GraphError(`node not found: ${record.payload.nodeId}`, 404);
        this.nodes.set(cur.id, { ...cur, ...record.payload.patch, updated: record.ts });
        break;
      }
      case "node.remove": {
        this.nodes.delete(record.payload.nodeId);
        break;
      }
    }
  }

  /** ops.jsonl だけから状態を再構築する（snapshot 消失時の復元・整合性テスト用） */
  static replay(dataDir: string): Map<string, Node> {
    const store = Object.create(GraphStore.prototype) as GraphStore;
    (store as unknown as { nodes: Map<string, Node> }).nodes = new Map();
    const records = readJsonl<OpRecord>(path.join(dataDir, "ops.jsonl"));
    for (const raw of records) {
      store.apply(OpRecordSchema.parse(raw));
    }
    return (store as unknown as { nodes: Map<string, Node> }).nodes;
  }
}
