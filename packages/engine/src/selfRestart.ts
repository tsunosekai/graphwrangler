// ---- 自動アップデート追随（2026-08-05。selfupdate.ts の相方） ----
// サーバが再起動して別の版になったら、エンジンも降りて新しいコードで上がり直す。
// 自分から再起動はしない（それはプロセス管理の仕事）ので、監視されていない環境では
// 降りずにそのまま回り続ける——落ちたきり戻らないほうが困るため
import { log } from "./log.js";

let seenServerVersion: string | null = null;

function supervised(): boolean {
  return Boolean(process.env.INVOCATION_ID) || process.env.pm_id !== undefined;
}

export function noteServerVersion(version: string | null): void {
  if (!version) return;
  if (seenServerVersion === null) {
    seenServerVersion = version;
    return;
  }
  if (seenServerVersion === version) return;
  log(`サーバのアプリ版が ${seenServerVersion} → ${version} に変わりました`);
  seenServerVersion = version;
  if (!supervised()) {
    log("プロセス管理下ではないため自動終了しません（手動で再起動してください）");
    return;
  }
  // 非0で終える理由はサーバ側と同じ（unit が Restart=on-failure なので 0 だと
  // 上げ直してもらえない）。75 = EX_TEMPFAIL。selfupdate.ts の RESTART_EXIT_CODE と同値
  log("新しいコードで上がり直すため終了します");
  process.exit(75);
}
