// claude executor のタイムアウト挙動。Windows では claude を shell:true（cmd.exe 経由）で
// 起動するため、child.kill() は cmd.exe しか止めず実体の CLI が stdio を握ったまま生き残る。
// runClaude はタイムアウトでツリーごと殺し、ストリームを打ち切って必ず resolve する契約。
// 本物の claude CLI は使わず、node 製の偽 CLI（引数を無視して眠るだけ）で検証する。
//
// 「stdio を握る孫」の作り方は OS で変える必要がある（実測 2026-08-10。scriptTimeout.test.ts
// と同じ理由）: Windows は node の spawn(stdio:'inherit') では孫へのパイプ継承が切れて
// 再現しないため、shell:true を利用して cmd の start /b で孫を作る。POSIX は偽 CLI 自身が
// stdio を継承した孫を残す。
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type ClaudeExecutorConfig, runClaude } from "../src/executors/claude.js";

const isWindows = process.platform === "win32";
const SLEEPER = `node -e "setTimeout(function(){},15000)"`;

const dir = mkdtempSync(path.join(os.tmpdir(), "gw-claude-timeout-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeFakeCli(body: string): string {
  const file = path.join(dir, `fake_claude_${Math.random().toString(36).slice(2)}.cjs`);
  if (isWindows) {
    // Windows は runClaude が shell:true で起動するため「node <path>」のコマンド文字列で渡せる
    writeFileSync(file, body);
    return `node ${file}`;
  }
  // POSIX は argv をそのまま execve するため、shebang 付きの実行可能ファイルにする
  writeFileSync(file, `#!/usr/bin/env node\n${body}`);
  chmodSync(file, 0o755);
  return file;
}

/** stdio を握る孫（15 秒生きるデーモン）を先に残してから body を実行する偽 CLI */
function makeDaemonLeavingCli(body: string): string {
  if (isWindows) {
    // cmd で「start /b で孫を残す → node <本体> を実行」を1コマンド文字列にする
    // （runClaude が後ろに付ける引数は最後のコマンドの argv に流れるだけで無害）
    return `start /b ${SLEEPER} & ${makeFakeCli(body)}`;
  }
  return makeFakeCli(
    `require('child_process').spawn(process.execPath,`
      + `['-e','setTimeout(function(){},15000)'],{stdio:'inherit'}).unref();\n${body}`,
  );
}

function configFor(cliPath: string): ClaudeExecutorConfig {
  return { cliPath, model: "test-model", effort: null, extraArgs: [], extraTools: [], addDirs: [] };
}

describe("runClaude", () => {
  it(
    "タイムアウトしたら失敗として返る（走り続ける CLI）",
    async () => {
      const cliPath = makeFakeCli("setTimeout(function(){}, 15000);");
      const result = await runClaude("test prompt", configFor(cliPath), { timeoutMs: 500 });
      expect(result.success).toBe(false);
      expect(result.error).toContain("タイムアウト");
    },
    8_000,
  );

  it(
    "孫プロセスが stdio を握ったまま残っても、タイムアウトで必ず返る（close 非依存）",
    async () => {
      // CLI 本体も走り続け、stdio を握った孫も残る構図。close 頼みの実装だと
      // 孫が stdout パイプを閉じるまで返らない
      const cliPath = makeDaemonLeavingCli("setTimeout(function(){}, 15000);");
      const result = await runClaude("test prompt", configFor(cliPath), { timeoutMs: 500 });
      expect(result.success).toBe(false);
      expect(result.error).toContain("タイムアウト");
    },
    8_000,
  );

  it(
    "本体は正常終了したが孫が stdio を握って残る場合、猶予後に成功として返る（デーモン残し）",
    async () => {
      // CLI 本体はすぐ終了コード 0 で終わるが、孫が 15 秒パイプを握り続ける構図。
      // close 頼みだと孫の終了（15秒後）まで、タイムアウト頼みだと timeoutMs（30秒）まで
      // 待たされたうえ「タイムアウト失敗」と誤報告される。exit + 猶予で確定する契約
      // （このテスト自体の制限時間 8 秒が「すぐ返ること」の検証を兼ねる）
      const cliPath = makeDaemonLeavingCli("console.log('done7');");
      const result = await runClaude("test prompt", configFor(cliPath), { timeoutMs: 30_000 });
      expect(result.success).toBe(true);
      expect(result.output).toContain("done7");
    },
    8_000,
  );
});
