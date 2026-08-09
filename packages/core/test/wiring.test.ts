import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore, checkWiring } from "../src/index.js";

// 配線チェック（ランのコンテキストの静的検査。docs/design.md 3.15）。
// producer = outputs 宣言、consumer = script コマンド中の {name}。
// 警告4種（missing / not-ancestor / branch-dependent / duplicate）と参照矢印を検証する。

let dir: string;
let graph: GraphStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-wiring-"));
  graph = new GraphStore(dir);
});

/** ページ + トリガー（outputs 付き）だけの土台 */
function setupPage(triggerOutputs: Array<{ name: string }> | null = null) {
  const page = graph.addNode({ title: "ルーティーン", kind: "goal" });
  const trigger = graph.addNode({
    title: "起点",
    kind: "trigger",
    group: page.id,
    executor: "human",
    outputs: triggerOutputs,
  });
  return { page, trigger };
}

/** script 実装ノードを作るヘルパ */
function scriptNode(opts: {
  title: string;
  group: string;
  parents?: string[];
  command: string;
  params?: Array<{ name: string; value?: string | null }>;
  outputs?: Array<{ name: string }> | null;
  parentOptions?: Record<string, string>;
}) {
  return graph.addNode({
    title: opts.title,
    group: opts.group,
    parents: opts.parents ?? [],
    executor: "script",
    impl: { type: "script", command: opts.command, params: opts.params ?? null },
    outputs: opts.outputs ?? null,
    parentOptions: opts.parentOptions ?? {},
  });
}

function wiringOf(pageId: string) {
  return checkWiring(graph.state().nodes, pageId);
}

describe("checkWiring: references（参照矢印）", () => {
  it("トリガーの outputs 宣言 → 子孫 script の {name} が references になる（警告なし）", () => {
    const { page, trigger } = setupPage([{ name: "work" }]);
    const consumer = scriptNode({
      title: "収録",
      group: page.id,
      parents: [trigger.id],
      command: "node record.mjs {work}",
    });
    const { references, warnings } = wiringOf(page.id);
    expect(references).toEqual([{ producerId: trigger.id, consumerId: consumer.id, name: "work" }]);
    expect(warnings).toEqual([]);
  });

  it("デフォルト値があっても producer が居れば references に載る", () => {
    const { page, trigger } = setupPage([{ name: "work" }]);
    const consumer = scriptNode({
      title: "収録",
      group: page.id,
      parents: [trigger.id],
      command: "node record.mjs {work}",
      params: [{ name: "work", value: "既定作品" }],
    });
    const { references, warnings } = wiringOf(page.id);
    expect(references).toEqual([{ producerId: trigger.id, consumerId: consumer.id, name: "work" }]);
    expect(warnings).toEqual([]);
  });

  it("同じ {name} を複数回参照しても参照矢印は producer×consumer で1本", () => {
    const { page, trigger } = setupPage([{ name: "work" }]);
    scriptNode({
      title: "収録",
      group: page.id,
      parents: [trigger.id],
      command: "node a.mjs {work} && node b.mjs {work}",
    });
    expect(wiringOf(page.id).references).toHaveLength(1);
  });

  it("ページ外のノードの outputs は producer にならない", () => {
    const { page, trigger } = setupPage();
    const otherPage = graph.addNode({ title: "別ページ", kind: "goal" });
    graph.addNode({ title: "よそ者", group: otherPage.id, outputs: [{ name: "work" }] });
    scriptNode({
      title: "収録",
      group: page.id,
      parents: [trigger.id],
      command: "node record.mjs {work}",
    });
    const { references, warnings } = wiringOf(page.id);
    expect(references).toEqual([]);
    expect(warnings.map((w) => w.kind)).toEqual(["missing"]);
  });

  it("script 実装でないノードは consumer にならない（doc の本文中 {x} は対象外）", () => {
    const { page, trigger } = setupPage();
    graph.addNode({
      title: "手順書",
      group: page.id,
      parents: [trigger.id],
      executor: "ai",
      impl: { type: "doc", text: "本文の {work} は参照ではない" },
    });
    const { references, warnings } = wiringOf(page.id);
    expect(references).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("checkWiring: missing（供給元なし）", () => {
  it("producer もデフォルト値も無い {name} は missing 警告", () => {
    const { page, trigger } = setupPage();
    const consumer = scriptNode({
      title: "収録",
      group: page.id,
      parents: [trigger.id],
      command: "node record.mjs {work}",
    });
    const { warnings } = wiringOf(page.id);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ nodeId: consumer.id, name: "work", kind: "missing" });
    expect(warnings[0].message).toContain("work");
  });

  it("デフォルト値（impl.params[].value 非空）があれば missing は出ない", () => {
    const { page, trigger } = setupPage();
    scriptNode({
      title: "収録",
      group: page.id,
      parents: [trigger.id],
      command: "node record.mjs {work}",
      params: [{ name: "work", value: "既定作品" }],
    });
    expect(wiringOf(page.id).warnings).toEqual([]);
  });

  it("value が空文字・null の宣言はデフォルト値と見なさない", () => {
    const { page, trigger } = setupPage();
    scriptNode({
      title: "収録",
      group: page.id,
      parents: [trigger.id],
      command: "node record.mjs {work}",
      params: [{ name: "work", value: "" }],
    });
    expect(wiringOf(page.id).warnings.map((w) => w.kind)).toEqual(["missing"]);
  });
});

describe("checkWiring: not-ancestor（祖先でない producer）", () => {
  it("producer が並列の枝（祖先でない）に居ると not-ancestor 警告", () => {
    const { page, trigger } = setupPage();
    // trigger から2本に分かれる: producer と consumer は兄弟（実行順の保証なし）
    const producer = scriptNode({
      title: "値を作る",
      group: page.id,
      parents: [trigger.id],
      command: "node produce.mjs",
      outputs: [{ name: "work" }],
    });
    const consumer = scriptNode({
      title: "使う",
      group: page.id,
      parents: [trigger.id],
      command: "node consume.mjs {work}",
    });
    const { references, warnings } = wiringOf(page.id);
    expect(references).toEqual([{ producerId: producer.id, consumerId: consumer.id, name: "work" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ nodeId: consumer.id, name: "work", kind: "not-ancestor" });
  });

  it("producer が祖先（推移的に到達可能）なら警告なし", () => {
    const { page, trigger } = setupPage();
    const producer = scriptNode({
      title: "値を作る",
      group: page.id,
      parents: [trigger.id],
      command: "node produce.mjs",
      outputs: [{ name: "work" }],
    });
    const middle = graph.addNode({
      title: "間",
      group: page.id,
      parents: [producer.id],
    });
    scriptNode({
      title: "使う",
      group: page.id,
      parents: [middle.id],
      command: "node consume.mjs {work}",
    });
    expect(wiringOf(page.id).warnings).toEqual([]);
  });
});

describe("checkWiring: branch-dependent（経路依存）", () => {
  /** trigger → decision →（枝b1: producer）→ merge(consumer) の分岐構造 */
  function setupBranch(consumerParams?: Array<{ name: string; value?: string | null }>) {
    const { page, trigger } = setupPage();
    const decision = graph.addNode({
      title: "分岐",
      kind: "decision",
      group: page.id,
      parents: [trigger.id],
      branches: [
        { id: "b1", label: "やる" },
        { id: "b2", label: "やらない" },
      ],
    });
    const producer = scriptNode({
      title: "枝の下の producer",
      group: page.id,
      parents: [decision.id],
      parentOptions: { [decision.id]: "b1" },
      command: "node produce.mjs",
      outputs: [{ name: "work" }],
    });
    const other = graph.addNode({
      title: "もう片方の枝",
      group: page.id,
      parents: [decision.id],
      parentOptions: { [decision.id]: "b2" },
    });
    // 合流点（どちらの枝を通っても実行される）が {work} を参照する
    const consumer = scriptNode({
      title: "合流で使う",
      group: page.id,
      parents: [producer.id, other.id],
      command: "node consume.mjs {work}",
      params: consumerParams,
    });
    return { page, producer, consumer };
  }

  it("祖先 producer が分岐の枝の下だと branch-dependent 警告", () => {
    const { page, consumer } = setupBranch();
    const { warnings } = wiringOf(page.id);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      nodeId: consumer.id,
      name: "work",
      kind: "branch-dependent",
    });
  });

  it("デフォルト値があれば branch-dependent は黙認（警告なし）", () => {
    const { page } = setupBranch([{ name: "work", value: "既定作品" }]);
    expect(wiringOf(page.id).warnings).toEqual([]);
  });

  it("無条件経路の producer も居れば警告なし（値は必ず届く）", () => {
    const { page } = setupBranch();
    // トリガー直下（枝の外）にもう1つ producer を足し、consumer の祖先にする…の代わりに
    // 既存構造で consumer の親へ直結する無条件 producer を足す
    const nodes = graph.state().nodes;
    const consumer = nodes.find((n) => n.title === "合流で使う")!;
    const trigger = nodes.find((n) => n.kind === "trigger")!;
    const safeProducer = scriptNode({
      title: "無条件の producer",
      group: page.id,
      parents: [trigger.id],
      command: "node produce2.mjs",
      outputs: [{ name: "work" }],
    });
    graph.patchNode(consumer.id, { parents: [...consumer.parents, safeProducer.id] });
    // 2 producer が互いに祖先関係にないので duplicate は出るが、branch-dependent は消える
    const kinds = wiringOf(page.id).warnings.map((w) => w.kind);
    expect(kinds).not.toContain("branch-dependent");
    expect(kinds).toContain("duplicate");
  });
});

describe("checkWiring: duplicate（重複 producer）", () => {
  it("互いに祖先関係にない複数 producer が同じキーを宣言すると duplicate 警告", () => {
    const { page, trigger } = setupPage();
    const p1 = scriptNode({
      title: "producer1",
      group: page.id,
      parents: [trigger.id],
      command: "node p1.mjs",
      outputs: [{ name: "work" }],
    });
    const p2 = scriptNode({
      title: "producer2",
      group: page.id,
      parents: [trigger.id],
      command: "node p2.mjs",
      outputs: [{ name: "work" }],
    });
    const consumer = scriptNode({
      title: "使う",
      group: page.id,
      parents: [p1.id, p2.id],
      command: "node consume.mjs {work}",
    });
    const { references, warnings } = wiringOf(page.id);
    expect(references).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ nodeId: consumer.id, name: "work", kind: "duplicate" });
  });

  it("複数 producer でも直列（祖先関係あり）なら duplicate は出ない", () => {
    const { page, trigger } = setupPage();
    const p1 = scriptNode({
      title: "producer1",
      group: page.id,
      parents: [trigger.id],
      command: "node p1.mjs",
      outputs: [{ name: "work" }],
    });
    const p2 = scriptNode({
      title: "producer2（p1 の子）",
      group: page.id,
      parents: [p1.id],
      command: "node p2.mjs",
      outputs: [{ name: "work" }],
    });
    scriptNode({
      title: "使う",
      group: page.id,
      parents: [p2.id],
      command: "node consume.mjs {work}",
    });
    expect(wiringOf(page.id).warnings).toEqual([]);
  });
});
