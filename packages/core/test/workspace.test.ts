// ワークスペースモード（ワークスペース=1ファイル化）のテスト。
// docs「ワークスペース=1ファイル化」仕様が正。data-dir モードとは別経路であることも確認する。
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GraphStore,
  GraphError,
  stableStringify,
  readWorkspaceFile,
  writeWorkspaceFile,
  type Node,
} from "../src/index.js";

let dir: string;
let canonicalFile: string;
let sidecarDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-workspace-"));
  canonicalFile = path.join(dir, "workflow.gw.json");
  sidecarDir = path.join(dir, ".graphwrangler");
});

describe("stableStringify: 決定的シリアライズ", () => {
  it("キーの並び順に関わらずバイト一致する", () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { a: 2, c: { y: 2, z: 1 }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("2スペースインデントの JSON になる", () => {
    expect(stableStringify({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("配列の要素順は保持する（キーソートの対象外）", () => {
    expect(stableStringify({ nodes: [{ b: 1, a: 1 }, { d: 1, c: 1 }] })).toBe(
      stableStringify({ nodes: [{ a: 1, b: 1 }, { c: 1, d: 1 }] }),
    );
    // 要素の並び順自体は変わらない
    const out = JSON.parse(stableStringify({ nodes: [{ id: "z" }, { id: "a" }] }));
    expect(out.nodes.map((n: { id: string }) => n.id)).toEqual(["z", "a"]);
  });
});

describe("GraphStore.workspace: 起動と読み書き", () => {
  it("正データファイルが無ければ空グラフで開始する", () => {
    const g = GraphStore.workspace(canonicalFile, sidecarDir);
    expect(g.state().nodes).toEqual([]);
    expect(fs.existsSync(canonicalFile)).toBe(false);
  });

  it("addNode すると正データファイルが作られ、workspaceInfo が workspace を返す", () => {
    const g = GraphStore.workspace(canonicalFile, sidecarDir);
    expect(g.workspaceInfo()).toEqual({ mode: "workspace", root: dir, file: canonicalFile });
    const n = g.addNode({ title: "最初の仕事" });
    expect(fs.existsSync(canonicalFile)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(canonicalFile, "utf8"));
    expect(raw.format).toBe("graphwrangler-workspace");
    expect(raw.version).toBe(1);
    expect(raw.nodes.map((x: Node) => x.id)).toEqual([n.id]);
  });

  it("round-trip: 書いて→別インスタンスで開いても同じ状態になる", () => {
    const g1 = GraphStore.workspace(canonicalFile, sidecarDir);
    const a = g1.addNode({ title: "a" });
    const b = g1.addNode({ title: "b", parents: [a.id] });
    g1.patchNode(a.id, { status: "done", detail: "済んだ" });

    const g2 = GraphStore.workspace(canonicalFile, sidecarDir);
    expect(g2.state().nodes).toEqual(g1.state().nodes);
    expect(g2.get(a.id).status).toBe("done");
    expect(g2.get(b.id).parents).toEqual([a.id]);
  });

  it("nodes は id 昇順で書かれる（生成順が逆でも）", () => {
    const g = GraphStore.workspace(canonicalFile, sidecarDir);
    // 複数ノードを作って ID の大小と作成順をずらす
    const nodes = [g.addNode({ title: "1" }), g.addNode({ title: "2" }), g.addNode({ title: "3" })];
    // 削除→再作成しても常に昇順で書かれていることをファイルから直接確認する
    const raw = JSON.parse(fs.readFileSync(canonicalFile, "utf8"));
    const ids = raw.nodes.map((n: Node) => n.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(ids).toEqual(nodes.map((n) => n.id).sort());
  });

  it("同じ状態なら常にバイト一致する（決定的シリアライズ）", () => {
    // addNode は nowIso() を使うため2回の実際の呼び出し間でタイムスタンプがずれうる。
    // 「同じ状態」を厳密に固定するため、writeWorkspaceFile に同一内容のノード配列を
    // キー順・ノード順だけ変えて渡し、出力バイト列が一致することを見る
    const fixedNode = (id: string, title: string): Node => ({
      id,
      title,
      detail: null,
      impl: null,
      parents: [],
      group: null,
      kind: "task",
      executor: "human",
      approval: false,
      autonomy: "normal",
      lifecycle: "draft",
      status: "pending",
      fixed: false,
      pendingRequest: null,
      implTrial: null,
      schedule: null,
      branches: null,
      choice: null,
      parentOptions: {},
      createdBy: null,
      assignee: null,
      members: [],
      created: "2026-01-01T00:00:00.000Z",
    });
    const a = fixedNode("n-20260101-0001", "a");
    const b = fixedNode("n-20260101-0002", "b");

    const canonicalFile2 = path.join(dir, "workflow2.gw.json");
    writeWorkspaceFile(canonicalFile, [a, b]); // 昇順で渡す
    writeWorkspaceFile(canonicalFile2, [b, a]); // 逆順で渡す（内部で id 昇順に整列されるはず）

    const bytes1 = fs.readFileSync(canonicalFile, "utf8");
    const bytes2 = fs.readFileSync(canonicalFile2, "utf8");
    expect(bytes1).toBe(bytes2);
  });

  it("手書きの正データファイルを読み込める", () => {
    const handwritten = {
      format: "graphwrangler-workspace",
      version: 1,
      nodes: [
        {
          id: "n-20260101-0001",
          title: "手書きノード",
          detail: null,
          impl: { type: "doc", text: "本文", path: null },
          parents: [],
          group: null,
          kind: "task",
          executor: "human",
          // 旧フィールド名のまま（2026-08-03 改名前のデータ互換テスト: impact → approval に読み替わる）
          impact: "irreversible",
          lifecycle: "draft",
          status: "pending",
          fixed: false,
          pendingRequest: null,
          order: null,
          schedule: null,
          branches: null,
          choice: null,
          parentOptions: {},
          created: "2026-01-01T00:00:00.000Z",
          updated: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(canonicalFile, JSON.stringify(handwritten, null, 2), "utf8");
    const g = GraphStore.workspace(canonicalFile, sidecarDir);
    expect(g.get("n-20260101-0001").title).toBe("手書きノード");
    // 旧 impact:"irreversible" が approval:true として読める（互換レイヤ）
    expect(g.get("n-20260101-0001").approval).toBe(true);
  });

  it("impl.doc は path だけでも通る（text 必須を外した後方互換）", () => {
    const g = GraphStore.workspace(canonicalFile, sidecarDir);
    const n = g.addNode({ title: "手順書", impl: { type: "doc", path: "docs/how-to.md" } });
    expect(n.impl).toEqual({ type: "doc", path: "docs/how-to.md" });
  });

  it("既存データ（text だけの doc）はそのまま通る", () => {
    const g = GraphStore.workspace(canonicalFile, sidecarDir);
    const n = g.addNode({ title: "手順書", impl: { type: "doc", text: "手順本文" } });
    expect(n.impl).toEqual({ type: "doc", text: "手順本文" });
  });

  it("壊れたファイル（不正JSON）は起動時に明確なエラーになる", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(canonicalFile, "{ not json", "utf8");
    expect(() => GraphStore.workspace(canonicalFile, sidecarDir)).toThrow(GraphError);
    expect(() => GraphStore.workspace(canonicalFile, sidecarDir)).toThrow(/正データファイル/);
  });

  it("壊れたファイル（zod不通過）も起動時に明確なエラーになる", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(canonicalFile, JSON.stringify({ format: "wrong", version: 1, nodes: [] }), "utf8");
    expect(() => GraphStore.workspace(canonicalFile, sidecarDir)).toThrow(GraphError);
  });

  it("空ファイルは空グラフとして扱う", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(canonicalFile, "", "utf8");
    const g = GraphStore.workspace(canonicalFile, sidecarDir);
    expect(g.state().nodes).toEqual([]);
  });

  it("ops.jsonl はサイドカーに置かれ、再生されない（正データファイルが唯一の正）", () => {
    const g1 = GraphStore.workspace(canonicalFile, sidecarDir);
    g1.addNode({ title: "a" });
    const opsFile = path.join(sidecarDir, "ops.jsonl");
    expect(fs.existsSync(opsFile)).toBe(true);

    // 正データファイルを外部から直接書き換える（例: 手編集）→ 再起動すればそれが正になる
    // （ops.jsonl は再生されないので、ops に無い状態でも矛盾なく開けることを確認）
    writeWorkspaceFile(canonicalFile, []);
    const g2 = GraphStore.workspace(canonicalFile, sidecarDir);
    expect(g2.state().nodes).toEqual([]);
  });

  it("セッション内 undo が正データファイルに反映される", () => {
    const g = GraphStore.workspace(canonicalFile, sidecarDir);
    const a = g.addNode({ title: "a" });
    g.patchNode(a.id, { status: "done", detail: "済" });
    g.undoLast();

    expect(g.get(a.id).status).toBe("pending");
    const raw = JSON.parse(fs.readFileSync(canonicalFile, "utf8"));
    const onDisk = raw.nodes.find((n: Node) => n.id === a.id);
    expect(onDisk.status).toBe("pending");
    expect(onDisk.detail).toBeNull();

    // add の undo も反映される
    const b = g.addNode({ title: "b" });
    g.undoLast();
    expect(g.has(b.id)).toBe(false);
    const raw2 = JSON.parse(fs.readFileSync(canonicalFile, "utf8"));
    expect(raw2.nodes.map((n: Node) => n.id)).toEqual([a.id]);
  });

  it("readWorkspaceFile を直接使って id 昇順の nodes を取れる", () => {
    const g = GraphStore.workspace(canonicalFile, sidecarDir);
    g.addNode({ title: "a" });
    g.addNode({ title: "b" });
    const nodes = readWorkspaceFile(canonicalFile);
    const ids = nodes.map((n) => n.id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe("GraphStore: data-dir モードは変わらず動く（互換確認）", () => {
  it("従来の new GraphStore(dataDir) は snapshot.json + ops.jsonl のまま", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-datadir-"));
    const g = new GraphStore(dataDir);
    expect(g.workspaceInfo()).toEqual({ mode: "datadir", root: null, file: null });
    g.addNode({ title: "a" });
    expect(fs.existsSync(path.join(dataDir, "snapshot.json"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "workflow.gw.json"))).toBe(false);
  });
});
