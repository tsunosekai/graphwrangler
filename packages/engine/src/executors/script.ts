// executor=script: node.impl={type:"script",command} を子プロセスで実行する。
// 決定的ノード（3.4）担当。shell: true でコマンド文字列をそのまま渡す。
import { spawn } from "node:child_process";
import os from "node:os";

export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
}

export const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000; // 5分

/**
 * 子プロセス出力のデコード。Windows では cmd.exe（内部コマンド含む）がシステム
 * コードページ（日本語環境は CP932/Shift_JIS）で出力するため、UTF-8 として読むと
 * 文字化けする（2026-07-31 実測: echo した日本語が � の列になった。chcp 65001 の
 * 前置はパイプ出力の内部コマンドに効かず解決しない）。UTF-8 で厳密デコードし、
 * 失敗したら Shift_JIS で読み直す（UTF-8 で吐くプログラムはそのまま通る）。
 */
export function decodeOutput(buf: Buffer): string {
  if (process.platform !== "win32") return buf.toString("utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("shift_jis").decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
}

export interface RunScriptOptions {
  timeoutMs?: number;
  /** 作業ディレクトリ。省略時は従来どおりリポジトリ外の作業用tmp（os.tmpdir()）。
   *  ワークスペースモードでは正データファイルのあるディレクトリ（workspace root）を渡す
   *  （ワークスペース=1ファイル化仕様: スクリプトがリポジトリ内のファイルを素で参照できる） */
  cwd?: string;
}

/**
 * command を子プロセスで実行する。cwd は既定でリポジトリ外の作業用tmp（os.tmpdir()）に固定する
 * （このリポジトリを汚さない。CLAUDE.md 系の「一時ファイルは /tmp へ」規律と同じ発想）が、
 * opts.cwd を渡せば上書きできる（ワークスペースモードの workspace root 用）。
 * 出力はバイト列で貯めて close 時に一括デコードする（チャンク境界でマルチバイト文字が
 * 割れるのを防ぐ + 上記の Shift_JIS フォールバックのため）。
 */
export function runScript(command: string, opts: RunScriptOptions = {}): Promise<ExecResult> {
  const { timeoutMs = SCRIPT_TIMEOUT_MS, cwd = os.tmpdir() } = opts;
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const child = spawn(command, {
      shell: true,
      cwd,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdoutChunks.push(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderrChunks.push(d);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, output: decodeOutput(Buffer.concat(stdoutChunks)), error: String(err) });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = decodeOutput(Buffer.concat(stdoutChunks));
      const stderr = decodeOutput(Buffer.concat(stderrChunks));
      if (timedOut) {
        resolve({
          success: false,
          output: stdout,
          error: `タイムアウト（${Math.round(timeoutMs / 60000)}分）`,
        });
        return;
      }
      if (code !== 0) {
        resolve({
          success: false,
          output: stdout,
          error: stderr.trim().slice(0, 2000) || `終了コード ${code}`,
        });
        return;
      }
      resolve({ success: true, output: stdout });
    });
  });
}
