import { describe, expect, it } from "vitest";
import { parseStreamJsonOutput } from "../src/executors/stream_trace.js";

/** stream-json の1行を作るヘルパ（JSON.stringify したものを行として結合する） */
function lines(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

function assistantToolUse(id: string, name: string, input: unknown) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  };
}

function userToolResult(toolUseId: string, content: unknown, isError = false) {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  };
}

function resultLine(result: string, isError = false) {
  return { type: "result", result, is_error: isError };
}

describe("parseStreamJsonOutput", () => {
  it("複数行にまたがる tool_use/tool_result を順序どおりの SubStep に組み立て、result行を最終出力にする", () => {
    const stdout = lines(
      assistantToolUse("t1", "Bash", { description: "ビルド", command: "pnpm build" }),
      userToolResult("t1", "build ok"),
      assistantToolUse("t2", "Read", { file_path: "/repo/src/index.ts" }),
      userToolResult("t2", [{ type: "text", text: "ファイルの中身" }]),
      resultLine("作業完了しました"),
    );

    const parsed = parseStreamJsonOutput(stdout);

    expect(parsed.output).toBe("作業完了しました");
    expect(parsed.isError).toBe(false);
    expect(parsed.subSteps).toHaveLength(2);

    expect(parsed.subSteps[0]).toMatchObject({
      id: "t1",
      index: 0,
      tool: "Bash",
      title: "ビルド",
      command: "pnpm build",
      output: "build ok",
      status: "ok",
    });
    expect(parsed.subSteps[0].input).toBe(JSON.stringify({ description: "ビルド", command: "pnpm build" }));

    // tool_result がブロック配列の場合は text ブロックを連結して取り出す（server/chat_cli.ts と同じ規則）
    expect(parsed.subSteps[1]).toMatchObject({
      id: "t2",
      index: 1,
      tool: "Read",
      title: "/repo/src/index.ts",
      command: null,
      output: "ファイルの中身",
      status: "ok",
    });
  });

  it("is_error な tool_result は status=error になる", () => {
    const stdout = lines(
      assistantToolUse("t1", "Bash", { command: "false" }),
      userToolResult("t1", "command failed", true),
      resultLine("失敗しました", true),
    );

    const parsed = parseStreamJsonOutput(stdout);

    expect(parsed.subSteps[0].status).toBe("error");
    expect(parsed.subSteps[0].output).toBe("command failed");
    expect(parsed.isError).toBe(true);
    expect(parsed.output).toBe("失敗しました");
  });

  it("対応する tool_result が来ない tool_use（中断/タイムアウト）は status=error, output=null になる", () => {
    const stdout = lines(assistantToolUse("t1", "Bash", { command: "sleep 999" }));

    const parsed = parseStreamJsonOutput(stdout);

    expect(parsed.subSteps).toHaveLength(1);
    expect(parsed.subSteps[0].status).toBe("error");
    expect(parsed.subSteps[0].output).toBeNull();
    // result行自体が無いので最終出力も無い
    expect(parsed.output).toBeNull();
    expect(parsed.isError).toBe(false);
  });

  it("壊れた行・空行は黙って読み飛ばす", () => {
    const stdout = [
      "",
      "not json {{{",
      JSON.stringify(assistantToolUse("t1", "Bash", { command: "echo hi" })),
      "   ",
      JSON.stringify(userToolResult("t1", "hi")),
      JSON.stringify(resultLine("ok")),
    ].join("\n");

    const parsed = parseStreamJsonOutput(stdout);

    expect(parsed.subSteps).toHaveLength(1);
    expect(parsed.output).toBe("ok");
  });

  it("result行が無ければ output=null, isError=false", () => {
    const stdout = lines(assistantToolUse("t1", "Bash", { command: "echo hi" }), userToolResult("t1", "hi"));

    const parsed = parseStreamJsonOutput(stdout);

    expect(parsed.output).toBeNull();
    expect(parsed.isError).toBe(false);
  });

  it("長い command/output は2000文字に切り詰める", () => {
    const longCommand = "x".repeat(3000);
    const longOutput = "y".repeat(3000);
    const stdout = lines(
      assistantToolUse("t1", "Bash", { command: longCommand }),
      userToolResult("t1", longOutput),
      resultLine("ok"),
    );

    const parsed = parseStreamJsonOutput(stdout);

    expect(parsed.subSteps[0].command).toHaveLength(2000);
    expect(parsed.subSteps[0].output).toHaveLength(2000);
    expect(parsed.subSteps[0].input).not.toBeNull();
    expect((parsed.subSteps[0].input as string).length).toBeLessThanOrEqual(2000);
  });

  describe("title 導出規則", () => {
    it("Bash: description があればそれを使う", () => {
      const stdout = lines(assistantToolUse("t1", "Bash", { description: "テスト実行", command: "pnpm test" }));
      const parsed = parseStreamJsonOutput(stdout);
      expect(parsed.subSteps[0].title).toBe("テスト実行");
    });

    it("Bash: description が無ければコマンドの先頭行", () => {
      const stdout = lines(assistantToolUse("t1", "Bash", { command: "echo one\necho two" }));
      const parsed = parseStreamJsonOutput(stdout);
      expect(parsed.subSteps[0].title).toBe("echo one");
    });

    it("Bash: description が空文字ならコマンドの先頭行にフォールバック", () => {
      const stdout = lines(assistantToolUse("t1", "Bash", { description: "  ", command: "echo hi" }));
      const parsed = parseStreamJsonOutput(stdout);
      expect(parsed.subSteps[0].title).toBe("echo hi");
    });

    it.each(["Read", "Write", "Edit", "NotebookEdit"])("%s: file_path を使う", (tool) => {
      const stdout = lines(assistantToolUse("t1", tool, { file_path: "/a/b/c.ts" }));
      const parsed = parseStreamJsonOutput(stdout);
      expect(parsed.subSteps[0].title).toBe("/a/b/c.ts");
    });

    it("Task: description があればそれを使う", () => {
      const stdout = lines(assistantToolUse("t1", "Task", { description: "サブ調査", prompt: "詳しく調べて" }));
      const parsed = parseStreamJsonOutput(stdout);
      expect(parsed.subSteps[0].title).toBe("サブ調査");
    });

    it("Task: description が無ければ prompt の先頭行", () => {
      const stdout = lines(assistantToolUse("t1", "Task", { prompt: "一行目\n二行目" }));
      const parsed = parseStreamJsonOutput(stdout);
      expect(parsed.subSteps[0].title).toBe("一行目");
    });

    it("WebSearch: query を使う", () => {
      const stdout = lines(assistantToolUse("t1", "WebSearch", { query: "graphwrangler とは" }));
      const parsed = parseStreamJsonOutput(stdout);
      expect(parsed.subSteps[0].title).toBe("graphwrangler とは");
    });

    it("WebFetch: url を使う", () => {
      const stdout = lines(assistantToolUse("t1", "WebFetch", { url: "https://example.com" }));
      const parsed = parseStreamJsonOutput(stdout);
      expect(parsed.subSteps[0].title).toBe("https://example.com");
    });

    it.each(["Grep", "Glob"])("%s: pattern を使う", (tool) => {
      const stdout = lines(assistantToolUse("t1", tool, { pattern: "foo.*bar" }));
      const parsed = parseStreamJsonOutput(stdout);
      expect(parsed.subSteps[0].title).toBe("foo.*bar");
    });

    it("未知のツール・主要引数が無い場合はツール名にフォールバックする", () => {
      const stdout = lines(assistantToolUse("t1", "TodoWrite", { todos: [] }));
      const parsed = parseStreamJsonOutput(stdout);
      expect(parsed.subSteps[0].title).toBe("TodoWrite");
    });

    it("Bash 以外では command は常に null", () => {
      const stdout = lines(assistantToolUse("t1", "Read", { file_path: "/a.ts" }));
      const parsed = parseStreamJsonOutput(stdout);
      expect(parsed.subSteps[0].command).toBeNull();
    });
  });
});
