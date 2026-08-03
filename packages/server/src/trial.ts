// スクリプト試走（試走ゲート。docs/design.md 3.5 近く「担当×実装の対応表と試走ゲート」）。
// impl.type==="script" のノードに対し、command を実際に1回動かして「書いてるだけで実行すると
// 黙って失敗する」を防ぐ。ゲートはハードブロックでなく警告（人間が主導権を持つ思想）。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import type { Node, ScriptParam } from "@graphwrangler/core";
import { GraphError } from "@graphwrangler/core";

/** command 文字列の sha256 hex（implTrial.hash の鮮度チェックに使う。UI 側は
 *  Web Crypto の crypto.subtle.digest("SHA-256", ...) で同じ値を計算する） */
export function sha256Hex(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

// ---- パラメータ宣言（2026-07-31 実装。docs/design.md 3.5.1） ----

export type SubstituteParamsResult = { ok: true; command: string } | { ok: false; missing: string[] };

/**
 * command 中の `{name}` プレースホルダを対応する params[].value へ置換する。
 * 値は二重引用符で囲み、内部の `"` は `\"` にエスケープする（シェルへそのまま渡せる形）。
 * 宣言に無い `{xxx}` や、value が未入力（null/空文字）の宣言が残っていれば
 * `{ok:false, missing:[名前...]}` を返す（重複名は1回だけ）。
 * packages/engine/src/params.ts に同じロジックを複製している（**変えたら両方直す**）。
 */
export function substituteParams(
  command: string,
  params: ScriptParam[] | null | undefined,
): SubstituteParamsResult {
  const declared = new Map((params ?? []).map((p) => [p.name, p]));
  const missing: string[] = [];
  const substituted = command.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const p = declared.get(name);
    if (!p || p.value === null || p.value === undefined || p.value === "") {
      if (!missing.includes(name)) missing.push(name);
      return `{${name}}`;
    }
    const escaped = p.value.replace(/"/g, '\\"');
    return `"${escaped}"`;
  });
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, command: substituted };
}

/**
 * 試走が許可されるノードかを検証する（TypeScript の assertion function。通れば
 * node.impl が {type:"script",command} であることが以降の型で保証される）。
 * 許可されなければ GraphError(400) を投げる。
 * - impl.type !== "script" のノードは試走できない（何を動かすか無い）
 * - approval=true（実行前承認）でも試走は**できる**: 試走は常に --dry-run の
 *   予告編で副作用が無いため、承認ゲートと矛盾しない（2026-07-31 本人指示で旧ルール撤廃。
 *   dry-run 固定化以前の名残だった）
 */
export function assertTrialAllowed(
  node: Node,
): asserts node is Node & { impl: { type: "script"; command: string } } {
  if (!node.impl || node.impl.type !== "script") {
    throw new GraphError(`node ${node.id} の実装はスクリプトではありません（impl.type!=="script"）`, 400);
  }
}

/**
 * 子プロセス出力のデコード。packages/engine/src/executors/script.ts の decodeOutput と
 * 完全に同じロジック（server は engine に依存しないため複製している。**変えたら両方直す**）。
 * Windows では cmd.exe 等がシステムコードページ（日本語環境は CP932/Shift_JIS）で出力するため、
 * UTF-8 として読むと文字化けする。UTF-8 で厳密デコードし、失敗したら Shift_JIS で読み直す。
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

export const TRIAL_TIMEOUT_MS = 5 * 60 * 1000; // 5分（script executor と同じ）

export interface TrialRunResult {
  success: boolean;
  exitCode: number | null;
  output: string;
}

/**
 * command を子プロセスで1回実行する。cwd はワークスペースルート（渡されなければ os.tmpdir()）。
 * shell:true でコマンド文字列をそのまま渡す（packages/engine/src/executors/script.ts の
 * runScript と同じ実行方式。試走はエンジンを経由しないため server 側で直接子プロセスを起動する）。
 */
export function runTrial(command: string, cwd: string): Promise<TrialRunResult> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const child = spawn(command, { shell: true, cwd });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TRIAL_TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));

    child.on("error", (err) => {
      clearTimeout(timer);
      const stdout = decodeOutput(Buffer.concat(stdoutChunks));
      resolve({ success: false, exitCode: null, output: `${stdout}\n${String(err)}`.trim() });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = decodeOutput(Buffer.concat(stdoutChunks));
      const stderr = decodeOutput(Buffer.concat(stderrChunks));
      if (timedOut) {
        resolve({
          success: false,
          exitCode: code,
          output: `${stdout}\nタイムアウト（${Math.round(TRIAL_TIMEOUT_MS / 60000)}分）`.trim(),
        });
        return;
      }
      const combined = code === 0 ? stdout : `${stdout}\n${stderr}`.trim();
      resolve({ success: code === 0, exitCode: code, output: combined });
    });
  });
}

/** 試走の作業ディレクトリ既定値（ワークスペースルートが無ければ os.tmpdir()） */
export function trialCwd(workspaceRoot: string | null): string {
  return workspaceRoot ?? os.tmpdir();
}
