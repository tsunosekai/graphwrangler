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

// ---- パラメータ宣言（2026-07-31 実装。docs/design.md 3.5.1）と
//      ランのコンテキスト解決（2026-08-09。docs/design.md 3.15） ----
//
// packages/engine/src/params.ts の substituteParams と完全に同じロジック（server は
// engine に依存しないため複製している。**変えたら両方直す**）。試走（このファイルの
// 利用元）はテンプレート層＝ランが無いので context を渡さず呼ぶ——解決はデフォルト値のみ
// （3.15 の解決順②だけが効く）で従来動作のまま。context 付きの解決・インジェクション
// ガードはエンジンの本走（ラン層）だけが通る。

export type SubstituteParamsResult =
  | { ok: true; command: string; resolved: Record<string, string> }
  | { ok: false; kind: "missing"; missing: string[]; reason: string }
  | { ok: false; kind: "unsafe"; unsafe: string[]; reason: string };

/**
 * インジェクションガード（docs/design.md 3.15）。**run.context 由来の値のみ**に適用する。
 * context の書き手は人間だけでなく AI・スクリプト・外部 MCP になるため、
 * 「外部由来文字列 → AI が context へ転記 → コマンド置換」というプロンプトインジェクション→
 * シェルインジェクションの導線をここで遮断する。テンプレートのデフォルト値（人間が UI で
 * 入力）は従来どおり引用符エスケープのみ（自分のマシンで任意コマンドを書ける人間の入力を
 * 縛っても防御にならないため）。
 */
const CONTEXT_INJECTION_GUARD_RE = /[`$\\"';|&<>(){}\r\n]/;

/**
 * command 中の `{name}` プレースホルダを解決する。
 * - context があれば context[name] を優先し、無ければ params[].value（デフォルト値）。
 * - 値は二重引用符で囲む。デフォルト値は内部の `"` を `\"` にエスケープ、context 由来は
 *   ガード通過済み（`"` `\` を含まない）なのでそのまま囲む。
 * - どちらにも無い名前が残れば missing、context 由来の値がシェルのメタ文字を含めば unsafe
 *   （置換せず実行失敗。エラー文言で GW_PARAM_* 環境変数の使用へ誘導する）。
 * - ok:true の resolved には実際に置換した {name: 値}（context 由来+デフォルト値由来の両方）が
 *   入る（ラン層は RunItem.resolvedParams への記録に使う）。
 */
export function substituteParams(
  command: string,
  params: ScriptParam[] | null | undefined,
  context?: Record<string, string>,
): SubstituteParamsResult {
  const declared = new Map((params ?? []).map((p) => [p.name, p]));
  const missing: string[] = [];
  const unsafe: string[] = [];
  const resolved: Record<string, string> = {};
  const substituted = command.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const fromContext = context?.[name];
    if (fromContext !== undefined) {
      if (CONTEXT_INJECTION_GUARD_RE.test(fromContext)) {
        if (!unsafe.includes(name)) unsafe.push(name);
        return `{${name}}`;
      }
      resolved[name] = fromContext;
      return `"${fromContext}"`;
    }
    const p = declared.get(name);
    if (!p || p.value === null || p.value === undefined || p.value === "") {
      if (!missing.includes(name)) missing.push(name);
      return `{${name}}`;
    }
    resolved[name] = p.value;
    const escaped = p.value.replace(/"/g, '\\"');
    return `"${escaped}"`;
  });
  if (unsafe.length > 0) {
    return { ok: false, kind: "unsafe", unsafe, reason: unsafeContextParamsReason(unsafe) };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      kind: "missing",
      missing,
      reason: missingParamsReason(missing, context !== undefined),
    };
  }
  return { ok: true, command: substituted, resolved };
}

/** missing パラメータの reason 文言（engine 複製と同一。試走の 400 は呼び出し側=index.ts が
 *  独自文言を組むためここは使われないが、複製を完全一致に保つ）。
 *  withRunContext=true（ラン層）ではランのコンテキストにも無かったことが分かる文にする */
export function missingParamsReason(missing: string[], withRunContext = false): string {
  if (withRunContext) {
    return `パラメータが未入力です: ${missing.join(", ")}。ランのコンテキストにも無く、パネルの実装欄のデフォルト値も未入力です。コンテキストへ値を書くか、実装欄で値を入力してから『もう一度』を選んでください`;
  }
  return `パラメータが未入力です: ${missing.join(", ")}。パネルの実装欄で値を入力してから『もう一度』を選んでください`;
}

/** インジェクションガードに掛かった context 由来パラメータの reason 文言（engine 複製と同一）。
 *  値は環境変数 GW_PARAM_<NAME> でも渡している（シェル展開を通らないので安全）ため、
 *  スクリプト側での読み替えへ誘導する */
export function unsafeContextParamsReason(unsafe: string[]): string {
  return `ランのコンテキスト由来の値にシェルのメタ文字が含まれるため置換できません: ${unsafe.join(", ")}。値は環境変数 GW_PARAM_<名前を大文字化したもの> で渡しているので、コマンドの {名前} 置換ではなく環境変数から読み取るようスクリプトを変更してください`;
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
