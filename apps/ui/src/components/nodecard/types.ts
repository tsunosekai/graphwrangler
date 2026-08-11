// グラフのカード（NodeCard）が外から受け取る2つの契約（GraphView / hooks/useNodeMenu が実装する）。
// 描画も導出も持たない型だけの置き場——カード側の各パーツ（head / badges / menu / state）が
// 同じ形を参照できるようにここに集める。NodeCard.tsx から re-export しているので、
// 呼び出し側は従来どおり "./NodeCard" から import してよい。
import type { Node, RunItemStatus } from "../../types";

/** 右クリックメニュー（第0層＝既存操作への近道。docs/design.md 4章の視距離3層に階を
 *  増やさない）から呼ぶ操作。実体は GraphView が持つ既存ハンドラ（F2 / Tab / Ctrl+D /
 *  Delete …）で、カード側は「いまどの項目を出すか」だけを決める。
 *  ここに新しい概念は置かない——同じことをする項目は必ず既存の関数を呼ぶ */
export interface NodeMenuActions {
  /** メニューを開く直前に呼ぶ。右クリックしたノードが未選択なら単独選択へ切り替える
   *  （以降の項目が「選択中に対する既存操作」をそのまま呼べるようにするため） */
  onOpen: (id: string) => void;
  /** F2 と同じ（タイトル編集モードへ入る） */
  rename: (id: string) => void;
  /** Tab と同じ（そのノードの後続を作って即リネーム） */
  addChild: (id: string) => void;
  /** Ctrl+D と同じ（選択中を複製） */
  duplicate: () => void;
  /** Delete と同じ（選択中を削除。確認モーダルの出し方も既存のまま） */
  remove: () => void;
  /** そのノードの会話（テンプレート + 全ランぶん）に未読があるか */
  hasUnread: (id: string) => boolean;
  /** 上記をまとめて既読にする */
  markRead: (id: string) => void;
  copyLink: (id: string) => void;
  copyId: (id: string) => void;
  /** 担当の変更（NodePanel の担当 Select と同じ patch + 同じ試走ゲート確認） */
  setExecutor: (id: string, executor: Node["executor"]) => void;
  /** 「ページへ移動 ▸」の候補（同じ節の他ページ）。空ならサブメニューごと出さない */
  movePages: { id: string; title: string }[];
  /** BulkPanel の「別ページへ移動」と同じ（group を patch） */
  moveToPage: (id: string, pageId: string) => void;
  /** 「ここから下を全部 ▸」の対象数（0 なら親項目ごと出さない） */
  descendantCount: (id: string) => number;
  /** 子孫のうち下書きを計画済みにする */
  commitDescendants: (id: string) => void;
  /** 子孫 + 自分を葉から順に削除する（確認モーダルは件数付き） */
  removeSubtree: (id: string) => void;
  /** スクリプトの試走（api.trialNode） */
  trial: (id: string) => void;
}

export interface NodeCardData {
  node: Node;
  selected: boolean;
  editing: boolean;
  /** ルーティーンページ（テンプレートの編集）で描かれているカードか。テンプレートは status を
   *  持たない思想（docs/design.md 3.8）なので、status 由来の見た目は出さない
   *  ——ただし runItem がある間はその進捗を投影する（下記） */
  isTemplate?: boolean;
  /** 実行フェーズ（全親が done|skipped）か。段階式アクションボタンの表示条件 */
  isFrontier?: boolean;
  /** アクティブなランのこのノードに対応するワークアイテム（あれば）。docs/design.md 3.8:
   *  「アクティブなランがある間だけ、その進捗をカードに投影する」。runId はボタンの
   *  更新先（api.patchRunItem）の特定に使う——テンプレートの patchNode は使わない */
  runItem?: { runId: string; status: RunItemStatus; note: string | null } | null;
  /** ランのページ（そのランの記録）として描かれているか（2026-08-08 本人指定のフォーク）。
   *  true のときテンプレートを書き換える操作（計画済みにする等）は出さない——直すべきは
   *  テンプレート側で、ランは起きたことの記録だから */
  inRunPage?: boolean;
  /** kind=trigger のカードだけが受ける「いま実行中のランの本数」。ラン作成時の確認文で
   *  「並行で増える」ことを伝えるのに使う（2026-08-08。ラン表示中は▶を無効にしたので、
   *  投影中のワークアイテムからは並走を知れなくなった） */
  runningRunCount?: number;
  /** runItem 版のフロンティア判定（親の「ランのアイテム」が全部 done|skipped か）。
   *  isFrontier のラン投影版。段階式アクションボタン（着手/完了）の表示条件 */
  isRunFrontier?: boolean;
  /** ラン作成フォームのプリフィル: 同じページの直近ランの context（docs/design.md 3.15
   *  「変えたい所だけ直す」）。kind=trigger のカードだけが使う */
  lastRunContext?: Record<string, string> | null;
  /** 配線チェック（GET /pages/:id/wiring）のこのノード宛警告 message 一覧。
   *  テンプレート表示のときだけ渡される（ランのページでは描かない。docs/design.md 3.15） */
  wiringWarnings?: string[];
  /** 既読ts（サーバ持ちの reads[<id>]）より新しいメッセージがあるか */
  unread?: boolean;
  /** 右クリックメニューの呼び先。未指定＝メニューを出さない（粗いポインタ環境。
   *  出す/出さないの判断は GraphView が一箇所で行う） */
  menu?: NodeMenuActions;
  onSelect: (id: string) => void;
  /** 手動でランを作る操作でランが生まれたときに呼ばれる（2026-08-08 本人指定「ランを作ったらそのランの
   *  ページへ移る」）。移動そのものは App が行う */
  onRunStarted?: (runId: string) => void;
  onDoubleClick: (id: string) => void;
  onCommitTitle: (id: string, title: string) => void;
  onCancelEdit: () => void;
  [key: string]: unknown;
}
