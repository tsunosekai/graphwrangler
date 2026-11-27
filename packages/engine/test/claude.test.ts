import { describe, expect, it } from "vitest";
import {
  buildAiPrompt,
  buildClaudeArgs,
  claudeChildEnv,
  explainClaudeCliFailure,
  sanitizeAddDirs,
  sanitizeExtraArgs,
  sanitizedClaudeEnv,
} from "../src/executors/claude.js";

// 2026-11-27 本人指示「許可リストそのものが要らない」: 常に全ツール許可で起動し、許可リストは渡さない
describe("buildClaudeArgs（権限）", () => {
  const base = { model: "opus", effort: null, extraArgs: [], addDirs: [] };

  it("常に --permission-mode bypassPermissions を付け、--allowedTools は付けない", () => {
    const args = buildClaudeArgs(base, "/tmp/mcp.json", false);
    const i = args.indexOf("--permission-mode");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("bypassPermissions");
    expect(args.some((a) => a.toLowerCase().startsWith("--allowed"))).toBe(false);
    expect(args).toContain("--mcp-config");
  });

  it("セッションを絞るフラグ（--strict-mcp-config 等）と --chrome は付けない", () => {
    const args = buildClaudeArgs(base, "/tmp/mcp.json", false);
    for (const f of ["--strict-mcp-config", "--setting-sources", "--disallowedTools", "--tools", "--chrome"]) {
      expect(args).not.toContain(f);
    }
  });

  it("設定の extraArgs の --permission-mode より後ろに置く（後勝ちで全許可が残る）", () => {
    const args = buildClaudeArgs({ ...base, extraArgs: ["--permission-mode", "default"] }, null, false);
    expect(args.lastIndexOf("--permission-mode")).toBeGreaterThan(args.indexOf("default"));
    expect(args[args.lastIndexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  });

  it("Windows では引用符ごと保存された作業場所も、引用符を二重にせず渡す", () => {
    const args = buildClaudeArgs({ ...base, addDirs: ['"C:\\Users\\a\\デスクトップ"'] }, null, true);
    expect(args[args.indexOf("--add-dir") + 1]).toBe('"C:\\Users\\a\\デスクトップ"');
  });
});

describe("claudeChildEnv", () => {
  it("ブラウザ接続と --add-dir 先の CLAUDE.md 読み込みを、掃除の後に必ず足す", () => {
    const saved = { ...process.env };
    try {
      process.env.CLAUDE_CODE_ENABLE_CFC = "0";
      process.env.CLAUDE_CODE_SOMETHING = "x";
      const env = claudeChildEnv();
      expect(env.CLAUDE_CODE_ENABLE_CFC).toBe("1");
      expect(env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("1");
      expect(env.CLAUDE_CODE_SOMETHING).toBeUndefined();
    } finally {
      process.env = saved;
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
  it("値そのものを囲む引用符と前後の空白を外す（2026-11-27 実測の設定値）", () => {
    expect(
      sanitizeAddDirs(['"C:\\Users\\user\\OneDrive\\デスクトップ"', " 'D:/a b' ", '""', '"-x"']),
    ).toEqual(["C:\\Users\\user\\OneDrive\\デスクトップ", "D:/a b"]);
  });

  it('"-" 始まり（フラグ混入経路）を落とし、パスだけ通す', () => {
    expect(
      sanitizeAddDirs(["/home/ubuntu", "--dangerously-skip-permissions", "D:\\VSCodeProject"]),
    ).toEqual(["/home/ubuntu", "D:\\VSCodeProject"]);
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
