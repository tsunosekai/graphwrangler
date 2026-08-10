// 追記型ログ（jsonl）の耐障害性のテスト。
// appendFileSync は書き込み途中のクラッシュで最終行が欠けうる（snapshot.json と違い
// tmp→rename では守れない）ため、壊れた行があっても読み込み・起動が止まらないこと。
import { describe, expect, it, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/index.js";
import { appendJsonl, readJsonl } from "../src/storage.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-storage-"));
});

describe("readJsonl の壊れた行の扱い", () => {
  it("途中で切れた最終行は警告して読み飛ばし、無事な行は全部返す", () => {
    const file = path.join(dir, "ops.jsonl");
    appendJsonl(file, { a: 1 });
    appendJsonl(file, { a: 2 });
    // 書き込み途中クラッシュを模す: 最終行を途中で切る
    const raw = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, raw.slice(0, raw.length - 4), "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(readJsonl(file)).toEqual([{ a: 1 }]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("切れた最終行の直後への追記は改行を挟み、新しい記録が共倒れしない", () => {
    const file = path.join(dir, "ops.jsonl");
    appendJsonl(file, { a: 1 });
    // 改行なしで途中まで書かれた行の直後に追記が来る状況を模す
    fs.appendFileSync(file, '{"a":', "utf8");
    appendJsonl(file, { a: 2 });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(readJsonl(file)).toEqual([{ a: 1 }, { a: 2 }]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("最終行が壊れた ops.jsonl でも開けて、辻褄合わせが実態に追いつく", () => {
    const g1 = new GraphStore(dir);
    const a = g1.addNode({ title: "無事なノード" });
    const b = g1.addNode({ title: "記録が欠けるノード" });
    const file = path.join(dir, "ops.jsonl");
    const raw = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, raw.slice(0, raw.length - 10), "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const g2 = new GraphStore(dir);
      // server は起動のたびに reconcileLog を呼ぶ——ここで throw すると起動できなくなる
      expect(() => g2.reconcileLog()).not.toThrow();
      // snapshot 由来の現在状態は無傷、欠けた記録も辻褄合わせで再生に追いつく
      expect(g2.state().nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
      expect(
        g2
          .nodesAt("2030-01-01T00:00:00.000Z")
          .nodes.map((n) => n.id)
          .sort(),
      ).toEqual([a.id, b.id].sort());
    } finally {
      warn.mockRestore();
    }
  });
});
