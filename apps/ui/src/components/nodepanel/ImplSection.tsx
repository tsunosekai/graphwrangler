// 実装（impl）セクション: 担当連動ラベル + 種類セレクト + doc/script 編集 + 試走ボタン
// （試走ゲート。docs/design.md 3.5 近く「担当×実装の対応表と試走ゲート」）。対応表:
// human→doc=読む手順書 / ai→doc=実行時プロンプトへインライン / script→script=command
// 実行。それ以外の組み合わせ（例: 担当=humanでimpl=script）は実行に使われない
import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { api, type NodePatchInput } from "../../lib/api";
import { confirmDialog, promptDialog } from "../../lib/dialogs";
import { HINT_TEXT } from "../../lib/hints";
import { useDraftField } from "../../hooks/useDraftField";
import { missingParamNames } from "../../lib/params";
import { pushToast } from "../../lib/toast";
import type { Node, Run, RunItem, ScriptParam } from "../../types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Hint } from "../Hint";
import { Icon } from "../Icon";
import type { ImplStatusUi } from "./useImplStatus";

// 実装セクションのラベルは担当連動（docs/design.md 3.5 近く「担当×実装の対応表と試走ゲート」）:
// human=読む手順書 / ai=実行時プロンプトへインライン / script=command 実行
const IMPL_LABEL_BY_EXECUTOR: Record<Node["executor"], string> = {
  human: "手順書",
  ai: "プロンプト（手順書）",
  script: "スクリプト",
};
type ImplTypeOption = "none" | "doc" | "script";

/** パラメータ宣言(1件)の値入力行（docs/design.md 3.5.1）。宣言（name/label/example）は
 *  GraphWrangler AI が書く前提で v1 では追加/削除UIを持たず、値の編集だけを行う。
 *  blur で確定する流儀は title/detail/BranchRow と同じ */
function ParamRow({ param, onCommit }: { param: ScriptParam; onCommit: (value: string) => void }) {
  const value = useDraftField(param.value ?? "");

  return (
    <div className="flex items-center gap-1.5">
      <span
        className="w-24 flex-shrink-0 truncate text-xs text-muted-foreground"
        title={param.name}
      >
        {param.label ?? param.name}
      </span>
      <Input
        className="h-8 flex-1"
        value={value.draft}
        placeholder={param.example ?? undefined}
        onFocus={() => value.setFocused(true)}
        onChange={(e) => value.setDraft(e.target.value)}
        onBlur={() => {
          value.setFocused(false);
          if (value.draft !== (param.value ?? "")) onCommit(value.draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

// ワークスペースの GitHub リンク基底（手順書パス右のアイコンリンク。2026-08-07 本人要望）。
// remote は運用中に変わらないのでモジュールで1回だけ取得して共有する
let githubBaseCache: string | null | undefined; // undefined = 未取得
function useGithubBlobBase(): string | null {
  const [base, setBase] = useState<string | null>(githubBaseCache ?? null);
  useEffect(() => {
    if (githubBaseCache !== undefined) return;
    githubBaseCache = null; // 取得中の多重リクエストを防ぐ（失敗時もリンク無しに倒す）
    void api
      .getWorkspaceInfo()
      .then((info) => {
        githubBaseCache = info.githubBlobBase ?? null;
        setBase(githubBaseCache);
      })
      .catch(() => {
        // 旧サーバ（githubBlobBase 無し）や取得失敗はリンク無しでよい
      });
  }, []);
  return base;
}

interface Props {
  node: Node;
  activeRun: Run | null;
  activeRunItem: RunItem | null;
  runView: { id: string; title: string } | null;
  contentLocked: boolean;
  implStatus: ImplStatusUi;
  patch: (fields: NodePatchInput) => Promise<void>;
  onMutated: () => void;
  refreshThread: () => void;
}

export function ImplSection({
  node,
  activeRun,
  activeRunItem,
  runView,
  contentLocked,
  implStatus,
  patch,
  onMutated,
  refreshThread,
}: Props) {
  const githubBase = useGithubBlobBase();

  // 実装（impl）編集ドラフト（title/detail/schedule と同じ「編集中は自分のdraftを見る」流儀）
  const implPath = useDraftField(node.impl?.type === "doc" ? (node.impl.path ?? "") : "");
  const implText = useDraftField(node.impl?.type === "doc" ? (node.impl.text ?? "") : "");
  const implCommand = useDraftField(node.impl?.type === "script" ? node.impl.command : "");

  // パラメータ宣言の未入力チェック（docs/design.md 3.5.1）。試走ボタンの disabled 判定に使う
  const missingParams = useMemo(
    () => (node.impl?.type === "script" ? missingParamNames(node.impl.command, node.impl.params) : []),
    [node.impl],
  );

  const [trialRunning, setTrialRunning] = useState(false);
  const runTrial = async () => {
    if (trialRunning) return;
    setTrialRunning(true);
    try {
      const result = await api.trialNode(node.id);
      onMutated();
      refreshThread();
      pushToast(
        result.success ? "テスト成功" : `テスト失敗（exit ${result.exitCode ?? "?"}）`,
        result.success ? "info" : "error",
      );
    } catch {
      // api() 側でトースト表示済み
    } finally {
      setTrialRunning(false);
    }
  };

  // 実装の種類セレクトの変更。中身（path/text/command）は種類を跨いで保持しない
  // （doc⇔scriptは別素材のため引き継ぐ意味が薄い。desk のFix定義通り「素材」の切替）
  const setImplType = async (v: ImplTypeOption) => {
    if (v === "none") {
      await patch({ impl: null });
      return;
    }
    if (v === "doc") {
      const cur = node.impl?.type === "doc" ? node.impl : null;
      await patch({ impl: { type: "doc", text: cur?.text ?? null, path: cur?.path ?? null } });
      return;
    }
    await patch({ impl: { type: "script", command: node.impl?.type === "script" ? node.impl.command : "" } });
  };

  const saveImplPath = async () => {
    implPath.setFocused(false);
    if (node.impl?.type !== "doc") return;
    const v = implPath.draft.trim() || null;
    if (v !== (node.impl.path ?? null)) await patch({ impl: { type: "doc", text: node.impl.text ?? null, path: v } });
  };

  const saveImplText = async () => {
    implText.setFocused(false);
    if (node.impl?.type !== "doc") return;
    const v = implText.draft || null;
    if (v !== (node.impl.text ?? null)) await patch({ impl: { type: "doc", text: v, path: node.impl.path ?? null } });
  };

  // 手順書の本文をワークスペース内ファイルへ書き出し、path 参照へ切り替える
  // （2026-08-02 本人要望「実装の手順をドキュメント化（ファイル化）する機能」）。
  // 未保存の下書きがあれば先に保存してから、サーバの to-file を呼ぶ
  const fileifyImplDoc = async () => {
    await saveImplText();
    if (!implText.draft.trim()) return;
    const safeName = (node.title || node.id).replace(/[\\/:*?"<>|]/g, "_").trim() || node.id;
    const filePath = await promptDialog(
      "ファイル化先のパス（ワークスペースルートからの相対）",
      { defaultValue: `docs/${safeName}.md`, confirmLabel: "ファイル化" },
    );
    if (!filePath) return;
    try {
      await api.implToFile(node.id, filePath);
    } catch (e) {
      if (!(e instanceof Error && e.message.includes("既にファイル"))) return; // トーストは api() 側
      const ok = await confirmDialog(`「${filePath}」は既にあります。上書きしますか？`, {
        danger: true,
        confirmLabel: "上書き",
      });
      if (!ok) return;
      try {
        await api.implToFile(node.id, filePath, { overwrite: true });
      } catch {
        return;
      }
    }
    pushToast(`手順書をファイル化しました: ${filePath}`, "info");
    onMutated();
  };

  const saveImplCommand = async () => {
    implCommand.setFocused(false);
    if (node.impl?.type !== "script") return;
    const v = implCommand.draft.trim();
    if (v && v !== node.impl.command) await patch({ impl: { type: "script", command: v } });
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5">
      <Hint id="impl" text={HINT_TEXT.impl}>
        <span className="flex items-center gap-1.5 self-start text-sm text-muted-foreground">
          <Icon name={node.impl?.type === "script" ? "code" : "doc"} size={13} />
          実装（{IMPL_LABEL_BY_EXECUTOR[node.executor]}）
        </span>
      </Hint>
      <Select
        value={node.impl === null ? "none" : node.impl.type}
        disabled={contentLocked}
        onValueChange={(v) => setImplType(v as ImplTypeOption)}
      >
        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">なし</SelectItem>
          <SelectItem value="doc">手順書</SelectItem>
          {/* スクリプト実装は担当=script のノードでしか実行されない（3.5.1 の対応表）ため、
              選択肢として出すのも担当=script のときだけ。担当を後から変えた等で既に
              script 実装を持つノードは、現在値として表示・編集できるよう残す */}
          {((node.executor === "script" && node.kind !== "trigger") || node.impl?.type === "script") && (
            <SelectItem value="script">スクリプト</SelectItem>
          )}
        </SelectContent>
      </Select>

      {node.impl?.type === "doc" && (
        <>
          <span className="flex items-center gap-1.5">
            <Input
              className="flex-1"
              placeholder="フォルダからの相対パス（例: docs/how-to.md）。本文も書いてあれば本文を優先"
              value={implPath.draft}
              disabled={contentLocked}
              onFocus={() => implPath.setFocused(true)}
              onChange={(e) => implPath.setDraft(e.target.value)}
              onBlur={saveImplPath}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            {/* GitHub リンク（2026-08-07 本人要望「手順書のパスの右側にアイコンリンク」）。
                ワークスペースの remote が GitHub のときだけ出る */}
            {githubBase && node.impl.path && (
              <a
                href={`${githubBase}/${node.impl.path.split("/").map(encodeURIComponent).join("/")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-shrink-0 text-text-lo transition-colors hover:text-foreground"
                title="GitHub でこの手順書を開く"
              >
                <ExternalLink className="size-4" />
              </a>
            )}
          </span>
          {/* 手順書の本文は長くなりがち。field-sizing-content の伸び放題を止めて
              内部スクロールにする（detail 欄と同じ理由。2026-08-02） */}
          <Textarea
            className="max-h-72 overflow-y-auto"
            placeholder="本文（パスと両方あれば省略可。どちらか片方があればよい）"
            value={implText.draft}
            disabled={contentLocked}
            onFocus={() => implText.setFocused(true)}
            onChange={(e) => implText.setDraft(e.target.value)}
            onBlur={saveImplText}
            rows={4}
          />
          {implText.draft.trim() && (
            <Hint
              id="impl-fileify"
              text="本文をワークスペース内の .md ファイルへ書き出し、path 参照に切り替える（git で版管理される）"
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={contentLocked}
                // disabled 理由だけは native title（disabled にはポインタイベントが来ない）
                title={node.fixed ? "ロック中はファイル化できません（先に解除）" : undefined}
                onClick={() => void fileifyImplDoc()}
              >
                <Icon name="doc" size={13} /> 本文をファイル化
              </Button>
            </Hint>
          )}
        </>
      )}

      {node.impl?.type === "script" && (
        <>
          <Input
            placeholder="実行コマンド（引数が要るなら {name} プレースホルダを使う）"
            value={implCommand.draft}
            disabled={contentLocked}
            onFocus={() => implCommand.setFocused(true)}
            onChange={(e) => implCommand.setDraft(e.target.value)}
            onBlur={saveImplCommand}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />

          {/* ラン表示で実行済みの記録があるとき: 解決済みの値（RunItem.resolvedParams）を
              値入り・読み取り専用で見せる（docs/design.md 3.15 実行時の読み）。実行後に
              run.context が変わってずれたキーには「古い値で実行済み」を出す——**自動では
              再実行しない**（task graph は cook graph ではない。やり直しは人間の判断） */}
          {runView && activeRunItem?.resolvedParams ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">
                パラメータ（このランで実行された値）
              </span>
              {Object.entries(activeRunItem.resolvedParams).map(([name, value]) => {
                const decl =
                  node.impl?.type === "script"
                    ? node.impl.params?.find((p) => p.name === name)
                    : undefined;
                const current = activeRun?.context?.[name];
                const stale = current !== undefined && current !== value;
                return (
                  <div key={name} className="flex items-center gap-1.5">
                    <span
                      className="w-24 flex-shrink-0 truncate text-xs text-muted-foreground"
                      title={name}
                    >
                      {decl?.label ?? name}
                    </span>
                    <Input className="h-8 flex-1" value={value} readOnly disabled />
                    {stale && (
                      <Hint
                        id="resolved-stale"
                        always="古い値で実行済み"
                        text={`実行後にランのコンテキストが変わっています（現在: ${current}）。自動では再実行しない——やり直すかは人間が判断する`}
                      >
                        <span className="flex-shrink-0" style={{ color: "var(--attention)" }}>
                          <Icon name="alert" size={12} />
                        </span>
                      </Hint>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            /* パラメータ宣言（docs/design.md 3.5.1）: 宣言=AI、値=人間がここで入力。
               Fix中でも値の入力だけは活かす（docs/design.md 3.5 実効化: 値は実行時入力でやり方ではない）。
               宣言の追加/削除UIはv1では作らない（GraphWrangler AIが command と一緒に書く想定） */
            (node.impl.params?.length ?? 0) > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">パラメータ</span>
                {node.impl.params!.map((p) => (
                  <ParamRow
                    key={p.name}
                    param={p}
                    onCommit={(value) => {
                      if (node.impl?.type !== "script") return;
                      const params = (node.impl.params ?? []).map((x) =>
                        x.name === p.name ? { ...x, value: value || null } : x,
                      );
                      patch({ impl: { type: "script", command: node.impl.command, params } });
                    }}
                  />
                ))}
              </div>
            )
          )}

          <div className="flex flex-wrap items-center gap-2">
            {/* ラベルは「試走」だけにし、説明はツールチップへ（2026-07-31 本人指定）。
                試走=常に--dry-runの予告編なので、実行前承認ノードでも試走できる
                （旧「承認ノードは試走不可」ルールは撤廃） */}
            <Hint
              id="trial"
              text="--dry-run を付けて実行し、何も変えずに「やる予定の操作」だけを表示する。実行前承認のノードでも安全に試せる"
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={trialRunning || missingParams.length > 0}
                // disabled 理由だけは native title（disabled にはポインタイベントが来ない）
                title={missingParams.length > 0 ? `未入力: ${missingParams.join(", ")}` : undefined}
                onClick={runTrial}
              >
                {trialRunning && <Loader2 className="size-3.5 animate-spin" />}
                試走
              </Button>
            </Hint>
            {missingParams.length > 0 && (
              <span className="text-xs text-destructive">未入力: {missingParams.join(", ")}</span>
            )}
            {implStatus === "ok" && node.implTrial && (
              <span className="text-xs text-ok">
                ✓ テスト成功（{new Date(node.implTrial.ts).toLocaleString("ja-JP")}）
              </span>
            )}
            {implStatus === "stale" && (
              <span className="text-xs text-destructive">
                ⚠ コマンドが変更されています（再試走を推奨）
              </span>
            )}
            {implStatus === "unverified" && node.implTrial && !node.implTrial.success && (
              <span className="text-xs text-destructive">
                ✗ テスト失敗（{new Date(node.implTrial.ts).toLocaleString("ja-JP")}）
              </span>
            )}
            {implStatus === "unverified" && !node.implTrial && (
              <span className="text-xs text-muted-foreground">未検証</span>
            )}
          </div>
        </>
      )}

      {node.impl?.type === "script" && node.executor !== "script" && (
        <p className="text-xs text-muted-foreground">
          このスクリプトは実行されません（担当がスクリプトではないため）
        </p>
      )}
    </div>
  );
}
