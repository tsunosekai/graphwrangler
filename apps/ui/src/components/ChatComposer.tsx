// チャット入力欄の共通コンポーネント（2026-08-07 本人要望「ノードの会話と GraphWrangler AI の
// 会話の UI を分けずに同じコンポーネントに。いつもここが乖離していく」）。
// GraphWrangler AI（ChatDrawer）と Task AI（Thread）の両方がこれを使う——**入力欄の見た目・
// 挙動の変更は必ずここで行い、利用側に分岐を増やさない**。
// 見た目は Claude Code のコンポーザ風（2026-08-07 本人指定）: 角丸ボックス + 応答中の
// 停止（■）+ 下段に ＋（添付）・モデル/思考の深さ切替・送信。
// 音声入力は 2026-08-07 に撤去（http 運用では Web Speech API が動かず、押せるのに
// 使えない状態だったため。ちゃんとやるならサーバ側 STT が要る＝別件）。
// 権限バッジ・使用量表示は付けない（本人指定）。
//
// 添付: /api/chat/attachments（gitignore 済み・サーバが7日で自動削除）へ上げ、送信時に
// 「[添付ファイル: <パス>]」行として本文へ足す。AI 側は各システムプロンプトの指示で
// この行を Read して読む（chat.ts / thread_ai.ts）。
import { useRef, useState } from "react";
import { ArrowUp, Loader2, Plus, Square } from "lucide-react";
import { effortLabel, modelLabel, useAiDefaults } from "../lib/aiDefaults";
import { pushToast } from "../lib/toast";
import { Icon } from "./Icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

/** コンポーザ下段の小さなセレクタ用トリガー装飾（モデル/エフォート共通） */
const COMPACT_TRIGGER =
  "data-[size=sm]:h-6 gap-1 border-0 bg-transparent px-1 py-0 text-xs text-muted-foreground shadow-none hover:text-foreground dark:bg-transparent dark:hover:bg-transparent";

export interface ComposerAttachment {
  name: string;
  path: string;
  size: number;
}

interface Props {
  /** 入力値（利用側が保持する。Thread はノード切替をまたぐ下書き保持があるため制御型） */
  value: string;
  onChange: (v: string) => void;
  /** 応答中か（停止■・予約系の表示に使う） */
  busy: boolean;
  /** 組み立て済み本文（添付行を含む）を送る。busy 中の送信の扱い（予約 or 即投稿）は利用側の責務 */
  onSend: (text: string) => void;
  /** 応答の停止（■）。無ければ停止ボタンを出さない */
  onStop?: () => void;
  /** 今の応答を打ち切って即送信（⌘・Ctrl+Enter）。無ければ「止めて送る」を出さない */
  onStopAndSend?: (text: string) => void;
  /** 送信の予約内容（応答後に自動送信される分）。ChatDrawer だけが使う */
  queued?: string | null;
  onCancelQueued?: () => void;
  placeholderIdle: string;
  placeholderBusy: string;
  /** モデル/エフォート切替（null = 既定）。渡さなければセレクタ自体を出さない */
  model?: string | null;
  onModelChange?: (v: string | null) => void;
  effort?: string | null;
  onEffortChange?: (v: string | null) => void;
  /** 送信ボタンを無効にする追加条件（Thread の sending 中など） */
  disabled?: boolean;
}

/** 「考え中」インジケータ（✳ + 跳ねる点）。Thread / ChatDrawer 共通 */
export function ThinkingIndicator({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 self-start px-1 py-1 text-sm text-text-lo">
      <span className="animate-pulse">✳</span>
      <span>{label}</span>
      <span className="inline-flex items-center gap-0.5">
        <span className="size-1 animate-bounce rounded-full bg-text-lo" style={{ animationDelay: "0ms" }} />
        <span className="size-1 animate-bounce rounded-full bg-text-lo" style={{ animationDelay: "150ms" }} />
        <span className="size-1 animate-bounce rounded-full bg-text-lo" style={{ animationDelay: "300ms" }} />
      </span>
      {children}
    </div>
  );
}

export function ChatComposer({
  value,
  onChange,
  busy,
  onSend,
  onStop,
  onStopAndSend,
  queued,
  onCancelQueued,
  placeholderIdle,
  placeholderBusy,
  model,
  onModelChange,
  effort,
  onEffortChange,
  disabled,
}: Props) {
  // 「既定」が実際に何か（⚙の設定値）をラベルに出す（2026-08-07 本人指摘）。
  // 会話系AI（GraphWrangler AI / Task AI）はどちらも chat 設定が既定
  const defaults = useAiDefaults();

  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadFiles = async (files: FileList | File[]) => {
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        try {
          const res = await fetch("/api/chat/attachments", { method: "POST", body: form });
          if (!res.ok) {
            const data = (await res.json().catch(() => null)) as { error?: string } | null;
            pushToast(data?.error ?? `添付に失敗しました: ${file.name}`, "error");
            continue;
          }
          const data = (await res.json()) as ComposerAttachment;
          setAttachments((prev) => [...prev, data]);
        } catch {
          pushToast(`添付に失敗しました: ${file.name}`, "error");
        }
      }
    } finally {
      setUploading(false);
    }
  };

  /** 入力と添付から実際に送る本文を組み立てる（空なら null） */
  const composeText = (): string | null => {
    const text = value.trim();
    const attachLines = attachments.map((a) => `[添付ファイル: ${a.path}]`);
    if (!text && attachLines.length === 0) return null;
    return [text, ...attachLines].filter(Boolean).join("\n");
  };

  const send = () => {
    if (disabled) return;
    const full = composeText();
    if (!full) return;
    onChange("");
    setAttachments([]);
    onSend(full);
  };

  const stopAndSend = () => {
    if (!onStopAndSend) return;
    const full = composeText();
    if (!full) return;
    onChange("");
    setAttachments([]);
    onStopAndSend(full);
  };

  const hasContent = !!value.trim() || attachments.length > 0;

  return (
    <div className="flex-shrink-0">
      {/* 送信予約: 応答中に送った分は応答後にまとめて自動送信 */}
      {queued && (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-ai/40 bg-ai/[0.06] px-3 py-1.5 text-xs text-muted-foreground">
          <span className="flex-shrink-0 pt-0.5 text-ai">応答後に送信</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{queued}</span>
          {onCancelQueued && (
            <button
              type="button"
              className="flex-shrink-0 pt-0.5 text-text-lo hover:text-foreground"
              title="送信をやめる"
              onClick={onCancelQueued}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      )}
      <div className="rounded-xl border border-border bg-card transition-colors focus-within:border-border-strong">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2">
            {attachments.map((a, i) => (
              <span
                key={`${a.path}-${i}`}
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground"
              >
                <span className="max-w-48 truncate">{a.name}</span>
                <button
                  type="button"
                  className="text-text-lo hover:text-foreground"
                  title="添付を外す"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="relative">
          <textarea
            className="max-h-48 w-full resize-none bg-transparent px-3 py-2.5 pr-9 text-sm outline-none placeholder:text-text-lo"
            value={value}
            rows={2}
            onChange={(e) => onChange(e.target.value)}
            placeholder={busy ? placeholderBusy : placeholderIdle}
            // キー操作の説明はプレースホルダから title へ（2026-08-07 文字削減）
            title="Enter: 送信 / Shift+Enter: 改行"
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing || e.shiftKey) return;
              e.preventDefault();
              if (busy && (e.metaKey || e.ctrlKey) && onStopAndSend) {
                stopAndSend();
                return;
              }
              send();
            }}
            onPaste={(e) => {
              // 画像などのファイル貼り付けは添付として受ける
              const files = e.clipboardData?.files;
              if (files && files.length > 0) {
                e.preventDefault();
                void uploadFiles(files);
              }
            }}
          />
          {busy && onStop && (
            <button
              type="button"
              className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground"
              title="応答を停止（途中までの内容は残る）"
              onClick={onStop}
            >
              <Square className="size-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            title="ファイルを添付（リポジトリには入らず、7日で自動削除）"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? <Loader2 className="size-4.5 animate-spin" /> : <Plus className="size-5" />}
          </button>
          <span className="flex-1" />
          {busy && onStopAndSend && (
            <button
              type="button"
              className="mr-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
              disabled={!hasContent && !queued}
              title="今の応答を打ち切って、書いた内容をすぐ送る（⌘・Ctrl+Enter）"
              onClick={stopAndSend}
            >
              止めて送る
            </button>
          )}
          {/* トリガーは値だけの短い表示（Claude Code 同様。2026-08-07 文字削減）。
              「モデル」「思考の深さ」の説明は title と選択肢側に置く */}
          {onModelChange && (
            <Select
              value={model ?? "default"}
              onValueChange={(v) => onModelChange(v === "default" ? null : v)}
            >
              <SelectTrigger size="sm" className={COMPACT_TRIGGER} title="この会話で使うモデル（既定は⚙の設定）">
                <SelectValue>{modelLabel(model ?? defaults?.chatModel ?? null)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">
                  既定{defaults ? `（${modelLabel(defaults.chatModel)}）` : ""}
                </SelectItem>
                <SelectItem value="fable">Fable 5</SelectItem>
                <SelectItem value="opus">Opus 5</SelectItem>
                <SelectItem value="sonnet">Sonnet 5</SelectItem>
                <SelectItem value="haiku">Haiku 4.5</SelectItem>
              </SelectContent>
            </Select>
          )}
          {onEffortChange && (
            <Select
              value={effort ?? "default"}
              onValueChange={(v) => onEffortChange(v === "default" ? null : v)}
            >
              <SelectTrigger size="sm" className={COMPACT_TRIGGER} title="思考の深さ（既定は⚙の設定）">
                <SelectValue>{effortLabel(effort ?? defaults?.chatEffort ?? null)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">
                  既定{defaults ? `（${effortLabel(defaults.chatEffort)}）` : ""}
                </SelectItem>
                <SelectItem value="low">低</SelectItem>
                <SelectItem value="medium">中</SelectItem>
                <SelectItem value="high">高</SelectItem>
                <SelectItem value="xhigh">超高</SelectItem>
                <SelectItem value="max">最大</SelectItem>
              </SelectContent>
            </Select>
          )}
          {busy ? (
            <Loader2 className="ml-1 size-4.5 animate-spin text-ai" />
          ) : (
            <button
              type="button"
              // 送信だけ強調色にする理由が無いので中間色に（2026-08-08 本人指定）
              className="ml-1 inline-flex size-7 items-center justify-center rounded-md bg-secondary text-secondary-foreground transition-colors hover:bg-border-strong disabled:opacity-30"
              title="送信（Enter）"
              disabled={!hasContent || disabled}
              onClick={send}
            >
              <ArrowUp className="size-4.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
