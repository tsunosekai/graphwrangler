// フォルダ（棚）の設定（docs/design.md 3.24）。左の一覧のフォルダの行の⚙、または右クリック →「フォルダの設定」。
//
// 2026-11-26 本人要望「AI の作業範囲をフォルダごとに分けられるようにしてほしい。その他の設定でも
// フォルダごとにした方がいいものはそうしたい」。フォルダごとに持てるものを1か所に集める:
//   - 名前（同日「フォルダ名の設定モーダルと融合して」。以前は行の✎から名前だけを変える小窓だった）
//   - AI の作業範囲（ワークスペースの外で読み書きできる場所）
//   - AI に追加で許可するツール
//   - AI のモデル・思考の深さ（中のノードの既定）
//   - 通知を切る（3.22）
//   - 予定カレンダーの色（3.20d。ルーティーンのフォルダだけ）
// AI の4項目は「全体の設定に従う」が既定で、フォルダ専用にしたものだけがそのフォルダに効く。
// 作業範囲とツールは**足し算ではなく置き換え**（足し算だと、全体より狭くできない）。
import { useEffect, useState } from "react";
import { EFFORT_LABELS, MODEL_LABELS, effortLabel, modelLabel } from "../../lib/aiDefaults";
import { api, type SettingsView } from "../../lib/api";
import {
  FOLDER_COLORS,
  assignFolderColors,
  folderColorSolid,
  isCustomFolderColor,
  isFolderColorKey,
} from "../../lib/folderColor";
import { optimisticPatchNode } from "../../lib/optimistic";
import { cn } from "../../lib/utils";
import type { Node } from "../../types";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { shelfSectionOf } from "./sections";

const INHERIT = "__inherit__";

/** 1行に1つ。空行と前後の空白は捨てる */
const toList = (text: string) =>
  text
    .split("\n")
    .map((s) => s.trim())
    // "-" 始まりはコマンドのフラグに見えるので保存しない（使う側の core/scope.ts でも捨てている）
    .filter((s) => s !== "" && !s.startsWith("-"));

export function FolderSettingsDialog({
  folder,
  allNodes,
  onOpenChange,
}: {
  /** 設定するフォルダ。null なら閉じている */
  folder: Node | null;
  allNodes: Node[];
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={folder !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] w-[min(40rem,95vw)] max-w-none flex-col sm:max-w-none">
        {folder && (
          // フォルダごとに入力の下書きを作り直す
          <FolderSettingsForm key={folder.id} folder={folder} allNodes={allNodes} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FolderSettingsForm({ folder, allNodes, onDone }: { folder: Node; allNodes: Node[]; onDone: () => void }) {
  // 「全体の設定に従う」が実際に何かを見せるために、全体の設定を取る
  const [global, setGlobal] = useState<SettingsView | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .getSettings()
      .then((s) => {
        if (alive) setGlobal(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const [title, setTitle] = useState(folder.title);
  const [ownDirs, setOwnDirs] = useState(Array.isArray(folder.aiDirs));
  const [dirsText, setDirsText] = useState((folder.aiDirs ?? []).join("\n"));
  const [ownTools, setOwnTools] = useState(Array.isArray(folder.aiTools));
  const [toolsText, setToolsText] = useState((folder.aiTools ?? []).join("\n"));
  const [browser, setBrowser] = useState(folder.aiBrowser === true);
  const [model, setModel] = useState(folder.aiModel ?? INHERIT);
  const [effort, setEffort] = useState<string>(folder.aiEffort ?? INHERIT);
  const [muted, setMuted] = useState(folder.muted === true);
  const [color, setColor] = useState<string | null>(isFolderColorKey(folder.color) ? folder.color : null);
  const [saving, setSaving] = useState(false);

  const routine = shelfSectionOf(folder) === "routine";
  // 「自動」のときに付く色（ほかのフォルダの色と重ならないように決まる）
  const autoColor = assignFolderColors(
    allNodes.filter((n) => n.kind === "folder").map((n) => ({ id: n.id, color: n.id === folder.id ? null : n.color })),
  ).get(folder.id);

  const globalDirs = global?.ai.addDirs ?? [];
  // ツールは実行AIと会話の AI で全体の設定が別なので、両方を見せる
  const globalTools = global ? [...new Set([...global.engine.cliExtraTools, ...global.chat.cliExtraTools])] : [];

  const save = async () => {
    setSaving(true);
    try {
      await optimisticPatchNode(folder.id, {
        // 名前を空にして保存したときは、名前だけ今のままにする
        ...(title.trim() && title.trim() !== folder.title ? { title: title.trim() } : {}),
        aiDirs: ownDirs ? toList(dirsText) : null,
        aiTools: ownTools ? toList(toolsText) : null,
        // 変えていなければ送らない（未設定のまま＝外側のフォルダの設定に従う、を保つ）
        ...(browser !== (folder.aiBrowser === true) ? { aiBrowser: browser } : {}),
        aiModel: model === INHERIT ? null : model,
        aiEffort: effort === INHERIT ? null : (effort as Node["aiEffort"]),
        muted,
        color,
      });
      onDone();
    } catch {
      // api 側でトースト済み
    } finally {
      setSaving(false);
    }
  };

  const section = "flex flex-col gap-2 rounded-md border border-border p-3";
  const heading = "text-sm font-semibold";
  const note = "text-xs text-muted-foreground";

  return (
    <>
      <DialogHeader>
        <DialogTitle>フォルダの設定</DialogTitle>
      </DialogHeader>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1" data-folder-settings>
        <label className="flex flex-col gap-1">
          <span className={heading}>名前</span>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              // 変換の確定の Enter では保存しない
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void save();
            }}
            aria-label="フォルダの名前"
            autoFocus
          />
        </label>
        <div className={section}>
          <div className="flex items-center justify-between gap-2">
            <span className={heading}>AI の作業範囲</span>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              このフォルダ専用にする
              <Switch checked={ownDirs} onCheckedChange={setOwnDirs} aria-label="作業範囲をこのフォルダ専用にする" />
            </label>
          </div>
          <p className={note}>
            このフォルダの中で動く AI（実行・ノードの会話・ページを開いているときの全体チャット）が、ワークスペースの外で
            読み書きできる場所です。専用にすると、全体の設定の代わりに、ここに書いた場所だけになります。
          </p>
          {ownDirs ? (
            <>
              <Textarea
                rows={3}
                className="max-h-40 overflow-y-auto font-mono text-xs"
                placeholder={"1行に1つ。例:\nD:\\VSCodeProject\\stremix-jp"}
                value={dirsText}
                onChange={(e) => setDirsText(e.target.value)}
                aria-label="AI の作業範囲（1行に1つ）"
              />
              {toList(dirsText).length === 0 && (
                <p className={note}>何も書かなければ、ワークスペースの中だけになります。</p>
              )}
            </>
          ) : (
            <p className="text-xs">
              全体の設定に従います:{" "}
              <span className="font-mono text-muted-foreground">
                {global ? (globalDirs.length > 0 ? globalDirs.join(" / ") : "（追加なし＝ワークスペースの中だけ）") : "…"}
              </span>
            </p>
          )}
        </div>

        <div className={section}>
          <div className="flex items-center justify-between gap-2">
            <span className={heading}>AI に追加で許可するツール</span>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              このフォルダ専用にする
              <Switch checked={ownTools} onCheckedChange={setOwnTools} aria-label="ツールをこのフォルダ専用にする" />
            </label>
          </div>
          <p className={note}>
            標準のツール（ファイル操作・シェル・Web など）に足して許可するもの。MCP のツールを使わせたいときに書きます。
          </p>
          {ownTools ? (
            <Textarea
              rows={2}
              className="max-h-32 overflow-y-auto font-mono text-xs"
              placeholder={"1行に1つ。例:\nmcp__linear__*"}
              value={toolsText}
              onChange={(e) => setToolsText(e.target.value)}
              aria-label="追加で許可するツール（1行に1つ）"
            />
          ) : (
            <p className="text-xs">
              全体の設定に従います:{" "}
              <span className="font-mono text-muted-foreground">
                {global ? (globalTools.length > 0 ? globalTools.join(" / ") : "（追加なし）") : "…"}
              </span>
            </p>
          )}
        </div>

        <div className={section}>
          <div className="flex items-center justify-between gap-2">
            <span className={heading}>AI にブラウザを操作させる</span>
            <Switch checked={browser} onCheckedChange={setBrowser} aria-label="AI にブラウザを操作させる" />
          </div>
          <p className={note}>
            ON にすると、このフォルダの中の AI のノードが、Claude の拡張を入れたブラウザ（いま開いているもの）でページを開いて
            読んだり操作したりできます。ログイン済みのサイトにも届くので、必要なフォルダだけ ON にしてください。
            効くのは実行AIだけです（ノードの会話・全体チャットには効きません）。
          </p>
        </div>

        <div className={section}>
          <span className={heading}>AI のモデル・思考の深さ</span>
          <p className={note}>このフォルダの中のノードの既定です。ノードごとに指定してあれば、そちらが優先されます。</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              モデル
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>
                    {global ? `全体の設定に従う（実行 ${modelLabel(global.engine.model)}）` : "全体の設定に従う"}
                  </SelectItem>
                  {Object.entries(MODEL_LABELS).map(([k, label]) => (
                    <SelectItem key={k} value={k}>{label}</SelectItem>
                  ))}
                  {model !== INHERIT && !(model in MODEL_LABELS) && <SelectItem value={model}>{model}</SelectItem>}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              思考の深さ
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>
                    {global ? `全体の設定に従う（実行 ${effortLabel(global.engine.effort)}）` : "全体の設定に従う"}
                  </SelectItem>
                  {Object.entries(EFFORT_LABELS).map(([k, label]) => (
                    <SelectItem key={k} value={k}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
        </div>

        <div className={section}>
          <label className="flex items-center justify-between gap-2">
            <span className={heading}>通知を切る</span>
            <Switch checked={muted} onCheckedChange={setMuted} aria-label="このフォルダの通知を切る" />
          </label>
          <p className={note}>
            中の全ページについて、あなたの番の通知と左の一覧の未読バッジを出しません。進み方は変わりません。
          </p>
        </div>

        {routine && (
          <div className={section}>
            <span className={heading}>予定カレンダーの色</span>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {FOLDER_COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  title={c.label}
                  aria-label={c.label}
                  aria-pressed={color === c.key}
                  className={cn(
                    "size-5 rounded-full ring-offset-background hover:ring-2 hover:ring-ring hover:ring-offset-1",
                    color === c.key && "ring-2 ring-foreground ring-offset-1",
                  )}
                  style={{ backgroundColor: folderColorSolid(c) }}
                  onClick={() => setColor(c.key)}
                />
              ))}
              <label
                className={cn(
                  "ml-1 inline-flex cursor-pointer items-center gap-1 rounded-full border border-border py-0.5 pl-1 pr-2 text-text-lo hover:text-foreground",
                  isCustomFolderColor(color) && "border-foreground text-foreground",
                )}
              >
                <input
                  type="color"
                  aria-label="好きな色を選ぶ"
                  className="size-4 cursor-pointer border-0 bg-transparent p-0"
                  value={isCustomFolderColor(color) ? color : "#4f8ef7"}
                  onChange={(e) => setColor(e.target.value)}
                />
                好きな色
              </label>
              <button
                type="button"
                className={cn("ml-1 underline hover:text-foreground", color === null ? "text-foreground" : "text-text-lo")}
                onClick={() => setColor(null)}
              >
                自動{color === null && autoColor ? `（いまは${autoColor.label}）` : ""}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-shrink-0 justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          やめる
        </Button>
        <Button type="button" disabled={saving} onClick={() => void save()}>
          保存
        </Button>
      </div>
    </>
  );
}
