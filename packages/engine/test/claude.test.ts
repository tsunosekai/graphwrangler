import { describe, expect, it } from "vitest";
import {
  ALLOWED_TOOLS,
  buildAiPrompt,
  explainClaudeCliFailure,
  sanitizeAddDirs,
  sanitizeExtraArgs,
  sanitizeExtraTools,
  sanitizedClaudeEnv,
} from "../src/executors/claude.js";

describe("ALLOWED_TOOLS（2026-08-03 権限拡張）", () => {
  it("Bash を含むフルセットを既定で許可する", () => {
    for (const tool of ["Read", "Write", "Edit", "Bash", "Task", "WebSearch", "WebFetch"]) {
      expect(ALLOWED_TOOLS).toContain(tool);
    }
  });
});

describe("sanitizeExtraArgs", () => {
  it("--dangerously-skip-permissions と --allowedTools 系は大文字小文字を問わず落とす", () => {
    expect(
      sanitizeExtraArgs([
        "--dangerously-skip-permissions",
        "--DANGEROUSLY-SKIP-PERMISSIONS",
        "--allowedTools",
        "--allowed-tools",
        "--verbose",
      ]),
    ).toEqual(["--verbose"]);
  });
});

describe("sanitizeAddDirs", () => {
  it('"-" 始まり（フラグ混入経路）を落とし、パスだけ通す', () => {
    expect(
      sanitizeAddDirs(["/home/ubuntu", "--dangerously-skip-permissions", "D:\\VSCodeProject"]),
    ).toEqual(["/home/ubuntu", "D:\\VSCodeProject"]);
  });
});

describe("sanitizeExtraTools", () => {
  it('"-" 始まり（フラグ混入経路）を落とし、ツール名だけ通す', () => {
    expect(
      sanitizeExtraTools(["mcp__foo__*", "-p", "--dangerously-skip-permissions", "Bash(ssh:*)"]),
    ).toEqual(["mcp__foo__*", "Bash(ssh:*)"]);
  });
});

// ---- buildAiPrompt: ランのコンテキスト注入と出力宣言の指示（docs/design.md 3.15） ----

describe("buildAiPrompt: ランのコンテキスト（3.15）", () => {
  const baseNode = {
    title: "台本を書く",
    detail: null,
    impl: null,
    outputs: null,
  };

  it("runContext に値があれば「ランのコンテキスト」ブロックを注入し sources にも載せる", () => {
    const { prompt, sources } = buildAiPrompt({
      node: baseNode,
      goal: null,
      parentSayMessages: [],
      runContext: { remix: "RMX-0231" },
    });
    expect(prompt).toContain("ランのコンテキスト");
    expect(prompt).toContain("remix: RMX-0231");
    expect(sources).toContain("ランのコンテキスト");
  });

  it("runContext が空 {} ならブロックは出さない（欠けていてもエラーにしない）", () => {
    const { prompt, sources } = buildAiPrompt({
      node: baseNode,
      goal: null,
      parentSayMessages: [],
      runContext: {},
    });
    expect(prompt).not.toContain("ランのコンテキスト（このランで引き継がれている値");
    expect(sources).not.toContain("ランのコンテキスト");
  });

  it("outputs 宣言があるノードには ##gw マーカーでの出力指示を末尾に足す（ラン層のみ）", () => {
    const { prompt } = buildAiPrompt({
      node: { ...baseNode, outputs: [{ name: "script_path", label: "台本の置き場所", example: null }] },
      goal: null,
      parentSayMessages: [],
      runContext: {},
    });
    expect(prompt).toContain("##gw");
    expect(prompt).toContain("script_path");
    expect(prompt).toContain("台本の置き場所");
  });

  it("プロジェクト層（runContext=undefined）では outputs 宣言があっても ##gw 指示は付けない", () => {
    const { prompt } = buildAiPrompt({
      node: { ...baseNode, outputs: [{ name: "script_path" }] },
      goal: null,
      parentSayMessages: [],
    });
    expect(prompt).not.toContain("##gw");
  });
});

// 実行AIも同じ資格情報で動く。server/src/chat_cli.ts のテストと対（2026-08-18）
describe("認証（ログイン切れ）", () => {
  it("sanitizedClaudeEnv は CLAUDE_CODE_* を落とすが OAuth トークンだけは通す", () => {
    const saved = { ...process.env };
    try {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "dummy-token";
      process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
      process.env.ANTHROPIC_API_KEY = "sk-should-be-dropped";
      const env = sanitizedClaudeEnv();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("dummy-token");
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });

  it("explainClaudeCliFailure はログイン切れに次の手順を足す（それ以外は素通し）", () => {
    const msg = explainClaudeCliFailure(
      "Failed to authenticate: OAuth session expired and could not be refreshed",
    );
    expect(msg).toContain("OAuth session expired");
    expect(msg).toContain("claude setup-token");
    expect(explainClaudeCliFailure("終了コード 1")).toBe("終了コード 1");
  });
});
