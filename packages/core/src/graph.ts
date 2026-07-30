// グラフストア。すべての変更は操作ログ（ops.jsonl）を通り、snapshot.json は
// その適用結果にすぎない（docs/design.md 3.2）。snapshot 直接編集は禁止。
import path from "node:path";
import {
  ActorSchema,
  type Actor,
  type Node,
  type NodeBranch,
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

  /** frontier: status が done/dropped/skipped 以外で、parents が全て done または skipped のノード。
   *  「skipped も充足扱い」により、分岐(3.9)で片方の枝が skipped でも合流ノードは着火する
   *  （skipped でない親が全て done、と同値）。skipped 自体はもう通らないと決着済みなので除外する */
  frontier(): Node[] {
    return [...this.nodes.values()].filter(
      (n) =>
        n.status !== "done" &&
        n.status !== "dropped" &&
        n.status !== "skipped" &&
        n.parents.every((p) => {
          const s = this.nodes.get(p)?.status;
          return s === "done" || s === "skipped";
        }),
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
    this.validateGroup(null, parsed.group);
    this.validateBranches(parsed.kind, parsed.branches);
    this.validateParentOptions(parsed.parents, parsed.parentOptions);
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
    const current = this.get(id);
    const parsed = NodePatchSchema.parse(patch);
    if (parsed.parents) this.validateParents(id, parsed.parents);
    if (parsed.group !== undefined) this.validateGroup(id, parsed.group ?? null);
    if (parsed.kind !== undefined || parsed.branches !== undefined) {
      const kind = parsed.kind ?? current.kind;
      const branches = parsed.branches !== undefined ? parsed.branches : current.branches;
      this.validateBranches(kind, branches);
    }
    if (parsed.parentOptions !== undefined || parsed.parents !== undefined) {
      const parents = parsed.parents ?? current.parents;
      const parentOptions =
        parsed.parentOptions !== undefined ? parsed.parentOptions : current.parentOptions;
      this.validateParentOptions(parents, parentOptions);
    }
    this.commit({ op: "node.patch", payload: { nodeId: id, patch: parsed } }, meta);
    return this.get(id);
  }

  /**
   * 分岐ノード(kind=decision)の choice を確定する（docs/design.md 3.9）。
   * 1) choice をセット + status を done にする
   * 2) 直接規則: parentOptions[decisionId] を持つ子のうち、choice と不一致な枝は skipped
   * 3) 連鎖規則: 「全ての親」が skipped になったノードも skipped（再帰。done/dropped は触らない）
   * 複数の patch/commit の連続として行う（1つの巨大トランザクションopは持たない。undo は
   * 「1opずつ戻る」ことで整合を保つ設計 — docs/agent-contracts.md の帰属規約どおり）。
   */
  applyDecision(nodeId: string, choice: string, meta: OpMeta = {}): Node {
    const node = this.get(nodeId);
    if (node.kind !== "decision") {
      throw new GraphError(`node ${nodeId} is not a decision (kind=${node.kind})`);
    }
    if (!node.branches || !node.branches.some((b) => b.id === choice)) {
      throw new GraphError(`unknown choice: ${choice}`);
    }

    this.patchNode(nodeId, { choice, status: "done" }, meta);

    // 直接規則: このdecisionを親に持ち、選ばれなかった枝の子をskippedにする
    for (const n of [...this.nodes.values()]) {
      if (n.status === "done" || n.status === "dropped" || n.status === "skipped") continue;
      const branchId = n.parentOptions[nodeId];
      if (branchId !== undefined && branchId !== choice) {
        this.patchNode(n.id, { status: "skipped" }, meta);
      }
    }

    this.propagateSkipChain(meta);
    return this.get(nodeId);
  }

  /** 連鎖規則: 全ての親が skipped なノードを skipped にする（不動点まで繰り返す） */
  private propagateSkipChain(meta: OpMeta): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of [...this.nodes.values()]) {
        if (n.status === "done" || n.status === "dropped" || n.status === "skipped") continue;
        if (n.parents.length === 0) continue; // ルートは連鎖規則の対象外（親なし=空配列の空虚な真を避ける）
        const allSkipped = n.parents.every((pid) => this.nodes.get(pid)?.status === "skipped");
        if (allSkipped) {
          this.patchNode(n.id, { status: "skipped" }, meta);
          changed = true;
        }
      }
    }
  }

  /** MVP: 子（依存の後続）またはメンバー（group で自分を指すノード）を持つノードは消せない */
  removeNode(id: string, meta: OpMeta = {}): void {
    this.get(id);
    const children = [...this.nodes.values()].filter((n) => n.parents.includes(id));
    if (children.length > 0) {
      throw new GraphError(
        `node ${id} has ${children.length} children; remove or reparent them first`,
      );
    }
    const members = [...this.nodes.values()].filter((n) => n.group === id);
    if (members.length > 0) {
      throw new GraphError(
        `node ${id} has ${members.length} members; ungroup or remove them first`,
      );
    }
    this.commit({ op: "node.remove", payload: { nodeId: id } }, meta);
  }

  // ---- 内部 ----

  /** group の検証: 実在すること・包含の循環（自分自身/自分のメンバー子孫）を作らないこと */
  private validateGroup(selfId: string | null, group: string | null): void {
    if (group === null) return;
    if (!this.nodes.has(group)) throw new GraphError(`group not found: ${group}`);
    if (selfId) {
      let cur: string | null = group;
      const seen = new Set<string>();
      while (cur !== null) {
        if (cur === selfId) {
          throw new GraphError(`containment cycle: ${group} is inside ${selfId}`);
        }
        if (seen.has(cur)) break;
        seen.add(cur);
        cur = this.nodes.get(cur)?.group ?? null;
      }
    }
  }

  /** kind=decision のノードは branches が最低2個必要（elseなし・単一選択。docs/design.md 3.9）。
   *  それ以外の kind では branches の中身は問わない */
  private validateBranches(kind: Node["kind"], branches: NodeBranch[] | null): void {
    if (kind !== "decision") return;
    if (!branches || branches.length < 2) {
      throw new GraphError("decision ノードには branches が最低2つ必要です");
    }
  }

  /** parentOptions の検証: キーが parents に含まれ、その親が kind=decision であること。
   *  値がその親の branches に存在すること（docs/design.md 3.9） */
  private validateParentOptions(parents: string[], parentOptions: Record<string, string>): void {
    for (const [decisionId, branchId] of Object.entries(parentOptions)) {
      if (!parents.includes(decisionId)) {
        throw new GraphError(`parentOptions のキー ${decisionId} は parents に含まれていません`);
      }
      const decisionNode = this.nodes.get(decisionId);
      if (!decisionNode || decisionNode.kind !== "decision") {
        throw new GraphError(`parentOptions のキー ${decisionId} は decision ノードではありません`);
      }
      if (!decisionNode.branches?.some((b) => b.id === branchId)) {
        throw new GraphError(`parentOptions の値 ${branchId} は ${decisionId} の branches に存在しません`);
      }
    }
  }

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

  private commit(
    op: Omit<OpRecord, "id" | "ts" | "actor" | "via">,
    meta: OpMeta,
    undoes?: string,
  ): void {
    const record: OpRecord = OpRecordSchema.parse({
      id: nextId("op", []) + "-" + Math.random().toString(36).slice(2, 8),
      ts: nowIso(),
      actor: ActorSchema.parse(meta.actor ?? { kind: "human" }),
      via: meta.via ?? "ui",
      ...(undoes ? { undoes } : {}),
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
    const records = readJsonl<OpRecord>(path.join(dataDir, "ops.jsonl"));
    return GraphStore.replayRecords(records);
  }

  private static replayRecords(records: OpRecord[]): Map<string, Node> {
    const store = Object.create(GraphStore.prototype) as GraphStore;
    (store as unknown as { nodes: Map<string, Node> }).nodes = new Map();
    for (const raw of records) {
      store.apply(OpRecordSchema.parse(raw));
    }
    return (store as unknown as { nodes: Map<string, Node> }).nodes;
  }

  /**
   * 直近の操作を1つ元に戻す。過去行は書き換えず、**逆操作を追記**する
   * （undoes に対象 op の id を刻む）。補償操作（undoes 付き）は undo の対象から
   * 外すので、連続 undo は時系列を遡る。取り消しの取り消しは redoLast。
   */
  undoLast(meta: OpMeta = {}): OpRecord | null {
    return this.compensate(meta, (r, isUndone) => !r.undoes && !isUndone(r.id));
  }

  /** 直近の undo を1つやり直す（有効な補償操作を打ち消す = redo） */
  redoLast(meta: OpMeta = {}): OpRecord | null {
    return this.compensate(meta, (r, isUndone) => Boolean(r.undoes) && !isUndone(r.id));
  }

  private compensate(
    meta: OpMeta,
    pick: (r: OpRecord, isUndone: (id: string) => boolean) => boolean,
  ): OpRecord | null {
    const records = readJsonl<OpRecord>(this.opsPath);
    // 「効果的に打ち消されているか」= 自分への補償のうち、それ自身が打ち消されて
    // いないものが1つでもあるか（undo→redo→undo… のチェーンの偶奇を正しく見る）
    const compsOf = new Map<string, OpRecord[]>();
    for (const r of records) {
      const t = (r as { undoes?: string }).undoes;
      if (t) {
        const list = compsOf.get(t) ?? [];
        list.push(r);
        compsOf.set(t, list);
      }
    }
    const memo = new Map<string, boolean>();
    const isUndone = (id: string): boolean => {
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      const result = (compsOf.get(id) ?? []).some((c) => !isUndone(c.id));
      memo.set(id, result);
      return result;
    };
    let targetIndex = -1;
    for (let i = records.length - 1; i >= 0; i--) {
      if (pick(records[i], isUndone)) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex < 0) return null;
    const target = records[targetIndex];
    const before = GraphStore.replayRecords(records.slice(0, targetIndex));

    switch (target.op) {
      case "node.add": {
        const id = target.payload.node.id;
        const children = [...this.nodes.values()].filter((n) => n.parents.includes(id));
        const members = [...this.nodes.values()].filter((n) => n.group === id);
        if (children.length || members.length) {
          throw new GraphError(
            `undo できません: ${id} には後続ノードやメンバーが追加されています`,
            409,
          );
        }
        if (!this.nodes.has(id)) {
          throw new GraphError(`undo できません: ${id} は既に存在しません`, 409);
        }
        this.commit({ op: "node.remove", payload: { nodeId: id } }, meta, target.id);
        break;
      }
      case "node.patch": {
        const id = target.payload.nodeId;
        const prev = before.get(id);
        const cur = this.nodes.get(id);
        if (!prev || !cur) {
          throw new GraphError(`undo できません: ${id} が現存しません`, 409);
        }
        // patch されたキーだけを、patch 前の値へ戻す
        const inverse: Record<string, unknown> = {};
        for (const key of Object.keys(target.payload.patch)) {
          inverse[key] = (prev as unknown as Record<string, unknown>)[key];
        }
        this.commit(
          { op: "node.patch", payload: { nodeId: id, patch: NodePatchSchema.parse(inverse) } },
          meta,
          target.id,
        );
        break;
      }
      case "node.remove": {
        const id = target.payload.nodeId;
        const prev = before.get(id);
        if (!prev) throw new GraphError(`undo できません: ${id} の削除前の状態が不明です`, 409);
        if (this.nodes.has(id)) {
          throw new GraphError(`undo できません: ${id} は既に再作成されています`, 409);
        }
        this.commit({ op: "node.add", payload: { node: prev } }, meta, target.id);
        break;
      }
    }
    return target;
  }
}
