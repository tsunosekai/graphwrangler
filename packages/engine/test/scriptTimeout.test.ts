// script executor のタイムアウト挙動。close イベントは「プロセス終了 + stdio が全部
// 閉じる」まで発火しないため、孫プロセスにパイプを握られると child.kill() だけでは
// 永久に返らない（エンジンは1並列なので全体が止まる）。runScript はタイムアウトで
// ツリーごと殺し、ストリームを打ち切って必ず resolve する契約。実プロセス（node）を
// 短いタイムアウトで使って検証する。
//
// 「stdio を握る孫」の作り方は OS で変える必要がある（実測 2026-08-10）:
// - Windows: node の spawn(stdio:'inherit') では孫へのパイプ継承が切れて再現しない。
//   cmd の start /b なら孫がパイプを握ったまま残る
// - POSIX: シェルのバックグラウンド実行（&）で fd を継承した孫が残る
const isWindows = process.platform === "win32";
const SLEEPER = `node -e "setTimeout(function(){},15000)"`;

import { describe, expect, it } from "vitest";
import { runScript } from "../src/executors/script.js";

describe("runScript", () => {
  it("正常終了するコマンドは成功として返る", async () => {
    const result = await runScript(`node -e "console.log('ok')"`, { timeoutMs: 30_000 });
    expect(result.success).toBe(true);
    expect(result.output).toContain("ok");
  });

  it(
    "タイムアウトしたら失敗として返る（走り続けるプロセス）",
    async () => {
      const result = await runScript(SLEEPER, { timeoutMs: 300 });
      expect(result.success).toBe(false);
      expect(result.error).toContain("タイムアウト");
    },
    10_000,
  );

  it(
    "孫プロセスが stdio を握ったまま残っても、タイムアウトで必ず返る（close 非依存）",
    async () => {
      // シェルは走り続け、stdio を継承した孫も 15 秒生き残る構図。
      // close 頼みの実装だと孫が stdout パイプを閉じるまで返らない
      const command = isWindows ? `start /b ${SLEEPER} & ${SLEEPER}` : `${SLEEPER} & ${SLEEPER}`;
      const result = await runScript(command, { timeoutMs: 500 });
      expect(result.success).toBe(false);
      expect(result.error).toContain("タイムアウト");
    },
    8_000,
  );

  it(
    "本体は正常終了したが孫が stdio を握って残る場合、猶予後に成功として返る（デーモン残し）",
    async () => {
      // シェル本体はすぐ終了コード 0 で終わるが、孫が 15 秒パイプを握り続ける構図。
      // close 頼みだと孫の終了（15秒後）まで、タイムアウト頼みだと timeoutMs（30秒）まで
      // 待たされたうえ「タイムアウト失敗」と誤報告される。exit + 猶予で確定する契約
      // （このテスト自体の制限時間 8 秒が「すぐ返ること」の検証を兼ねる）
      const command = isWindows ? `echo ok& start /b ${SLEEPER}` : `echo ok; ${SLEEPER} &`;
      const result = await runScript(command, { timeoutMs: 30_000 });
      expect(result.success).toBe(true);
      expect(result.output).toContain("ok");
    },
    8_000,
  );
});
