// カードの右クリックメニュー（第0層。NodeCard から切り出し）。該当しない項目は disabled に
// せず出さない（メニューを短く保つ）。「既読にする」だけは押しても無害なので disabled で残す。
// 実体は NodeMenuActions（GraphView の既存ハンドラ）と、カード側の進捗/Fix/ラン作成
// ——ここで新しい概念は作らない。
import type { ReactElement } from "react";
import { EXECUTOR_JA } from "../../lib/labels";
import type { Node } from "../../types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../ui/context-menu";
import type { NodeMenuActions } from "./types";

interface Props {
  node: Node;
  menu: NodeMenuActions;
  /** 進捗/計画の項目（カードのボタンと同じ語彙・同じハンドラ） */
  progressItems: { label: string; run: () => void }[];
  canRun: boolean;
  /** ランのページ（記録）ではテンプレートを書き換える項目を出さない（2026-08-08 のフォーク） */
  canEditTemplate: boolean;
  descendants: number;
  onCreateRun: () => void;
  onToggleFixed: () => void;
  /** カード本体（メニューのトリガーになる） */
  children: ReactElement;
}

export function NodeMenu({
  node,
  menu,
  progressItems,
  canRun,
  canEditTemplate,
  descendants,
  onCreateRun,
  onToggleFixed,
  children,
}: Props) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        // ノード上の右クリックはペインのメニューまで上げない（両方が同時に開かないように）。
        // preventDefault はしない——Radix 側の内部ハンドラ（メニューを開く）が走らなくなる
        onContextMenu={(e) => {
          e.stopPropagation();
          menu.onOpen(node.id);
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-52"
        // 閉じたあとカードへフォーカスを戻さない。「名前を変更」で開いたタイトル入力から
        // フォーカスを奪い返す事故を構造的に防ぐ（2026-08-07「タイトル編集中にフォーカスが
        // 外れる」と同じ経路）。キーボード操作は GraphView の window keydown が一元管理する
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {progressItems.map((item) => (
          <ContextMenuItem key={item.label} onSelect={item.run}>
            {item.label}
          </ContextMenuItem>
        ))}
        {canRun && <ContextMenuItem onSelect={() => void onCreateRun()}>ラン</ContextMenuItem>}
        {(progressItems.length > 0 || canRun) && <ContextMenuSeparator />}
        <ContextMenuItem
          // 未読が無いときは押しても意味が無いだけなので disabled（非表示にはしない）
          disabled={!menu.hasUnread(node.id)}
          onSelect={() => menu.markRead(node.id)}
        >
          既読にする
        </ContextMenuItem>
        {canEditTemplate && (
          <>
            <ContextMenuSeparator />
            {/* Fix済みは名前も変えられない（F2 と同じガード） */}
            {!node.fixed && (
              <ContextMenuItem onSelect={() => menu.rename(node.id)}>
                名前を変更
                <ContextMenuShortcut>F2</ContextMenuShortcut>
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={() => menu.addChild(node.id)}>
              子ノードを作る
              <ContextMenuShortcut>Tab</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => menu.duplicate()}>
              複製
              <ContextMenuShortcut>Ctrl+D</ContextMenuShortcut>
            </ContextMenuItem>
            {/* 「やり方」フィールド（担当・ページ）は Fix済みだとサーバが409で拒否する */}
            {!node.fixed && <ContextMenuSeparator />}
            {!node.fixed && (
              <ContextMenuSub>
                <ContextMenuSubTrigger>担当を変える</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuRadioGroup
                    value={node.executor}
                    onValueChange={(v) => menu.setExecutor(node.id, v as Node["executor"])}
                  >
                    {(["human", "ai", "script"] as const).map((ex) => (
                      <ContextMenuRadioItem key={ex} value={ex}>
                        {EXECUTOR_JA[ex]}
                      </ContextMenuRadioItem>
                    ))}
                  </ContextMenuRadioGroup>
                </ContextMenuSubContent>
              </ContextMenuSub>
            )}
            {!node.fixed && menu.movePages.length > 0 && (
              <ContextMenuSub>
                <ContextMenuSubTrigger>ページへ移動</ContextMenuSubTrigger>
                <ContextMenuSubContent className="max-h-72 overflow-y-auto">
                  {menu.movePages.map((p) => (
                    <ContextMenuItem key={p.id} onSelect={() => menu.moveToPage(node.id, p.id)}>
                      {p.title}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => void onToggleFixed()}>
              {node.fixed ? "Fix を解除" : "Fix する"}
            </ContextMenuItem>
          </>
        )}
        {/* 試走はランのページでも出す（テンプレートを書き換えないため） */}
        {node.impl?.type === "script" && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => menu.trial(node.id)}>試走</ContextMenuItem>
          </>
        )}
        {canEditTemplate && descendants > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>ここから下を全部</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={() => menu.commitDescendants(node.id)}>
                計画済みにする
              </ContextMenuItem>
              <ContextMenuItem variant="destructive" onSelect={() => menu.removeSubtree(node.id)}>
                削除（{descendants + 1}件）
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => menu.copyLink(node.id)}>リンクをコピー</ContextMenuItem>
        <ContextMenuItem onSelect={() => menu.copyId(node.id)}>ID をコピー</ContextMenuItem>
        {canEditTemplate && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => menu.remove()}>
              削除
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
