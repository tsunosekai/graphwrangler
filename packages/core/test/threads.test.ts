import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadStore, type DecisionRequest } from "../src/index.js";

let dir: string;
let t: ThreadStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphwrangler-thread-"));
  t = new ThreadStore(dir);
});

const REQ: DecisionRequest = {
  context: "Xへの自動投稿の話。監査AIが判定に迷う文面が出た。出すか止めるか決めてほしい。",
  question: "この文面、投稿していい？",
  options: [
    { id: "go", label: "投稿する", then: "5分後にXに出る", recommended: true },
    { id: "drop", label: "やめる", then: "何も起きない" },
  ],
  impact: "irreversible",
  undo: null,
};

describe("ThreadStore", () => {
  it("say の投稿と読み出し", () => {
    t.post("n-1", { body: "こんにちは", author: { kind: "human" }, via: "discord" });
    const msgs = t.list("n-1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].kind).toBe("say");
    expect(msgs[0].via).toBe("discord");
  });

  it("判断リクエスト: open → 選択肢回答で answered", () => {
    const req = t.openRequest("n-1", REQ);
    expect(t.list("n-1")[0].requestStatus).toBe("open");

    const { resolved } = t.answerRequest("n-1", {
      requestId: req.id,
      option: "go",
      note: null,
    });
    expect(resolved).toBe(true);
    const [reqMsg, ansMsg] = t.list("n-1");
    expect(reqMsg.requestStatus).toBe("answered");
    expect(reqMsg.answeredBy).toBe(ansMsg.id);
  });

  it("ラリー: option=null の回答ではリクエストは open のまま", () => {
    const req = t.openRequest("n-1", REQ);
    const { resolved } = t.answerRequest("n-1", {
      requestId: req.id,
      option: null,
      note: "そもそもなんでこの文面になったの？",
    });
    expect(resolved).toBe(false);
    expect(t.list("n-1")[0].requestStatus).toBe("open");
  });

  it("二重回答は409", () => {
    const req = t.openRequest("n-1", REQ);
    t.answerRequest("n-1", { requestId: req.id, option: "go", note: null });
    expect(() =>
      t.answerRequest("n-1", { requestId: req.id, option: "drop", note: null }),
    ).toThrow(/already answered/);
  });

  it("存在しない選択肢は拒否", () => {
    const req = t.openRequest("n-1", REQ);
    expect(() =>
      t.answerRequest("n-1", { requestId: req.id, option: "nope", note: null }),
    ).toThrow(/unknown option/);
  });

  it("スレッドはノードごとに独立", () => {
    t.post("n-1", { body: "a" });
    t.post("n-2", { body: "b" });
    expect(t.list("n-1")).toHaveLength(1);
    expect(t.list("n-2")).toHaveLength(1);
  });

  // 2026-08-12: ボール（pendingRequest）はノード単位に1個なので、open なカードはどの
  // スコープから見ても出す。runId で切ると「橙は付くのにカードが無い」画面ができる
  // （通知リンクからランのページを開いたら質問に答えられなかった、の修正）
  describe("listScoped と判断カード", () => {
    it("runId 付きで開いたカードはそのランの会話に属する（回答も同じランに落ちる）", () => {
      const req = t.openRequest("n-1", REQ, { runId: "r-1" });
      expect(t.listScoped("n-1", "r-1").map((m) => m.id)).toContain(req.id);
      const { message: ans } = t.answerRequest("n-1", { requestId: req.id, option: "go", note: null });
      expect(ans.runId).toBe("r-1");
      // answered 後は自分のスコープにだけ残る
      expect(t.listScoped("n-1", null).map((m) => m.id)).not.toContain(req.id);
      expect(t.listScoped("n-1", "r-1").map((m) => m.id)).toContain(req.id);
    });

    it("open なカードはスコープを問わず見える（テンプレート側カード⇄ランのページの相互）", () => {
      const req = t.openRequest("n-1", REQ); // runId なし＝テンプレート側
      expect(t.listScoped("n-1", "r-1").map((m) => m.id)).toContain(req.id);
      const req2 = t.openRequest("n-2", REQ, { runId: "r-9" });
      expect(t.listScoped("n-2", null).map((m) => m.id)).toContain(req2.id);
    });
  });
});
