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
 * command を子プロセスで実行する。cwd はリポジトリ外の作業用tmp（os.tmpdir()）に固定する
 * （このリポジトリを汚さない。CLAUDE.md 系の「一時ファイルは /tmp へ」規律と同じ発想）。
 */
export function runScript(command: string, timeoutMs: number = SCRIPT_TIMEOUT_MS): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, {
      shell: true,
      cwd: os.tmpdir(),
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, output: stdout, error: String(err) });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
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
