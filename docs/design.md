# 設計文書 — AIとのタスク処理ツール tasuki（襷）

zinsei/desk をプロトタイプとする、配布可能な汎用ツール。
この文書が設計の正。会話や実装で設計が変わったらここを更新する。

## 1. 目的と差別化

タスクを人間とAIが一緒に整理し、整理したタスクを 人間 / AI / スクリプト が分担して
処理し、進捗を可視化するツール。

2026-07 時点の先行調査で、次の3要素を同時に備えたツールは存在しない（詳細は調査ログ参照）:

1. **テキスト⇔グラフの双方向リアルタイム編集**（近いもの: Kestra=YAML⇔グラフ, AFFiNE, Taskade）
2. **人間/AI/スクリプトをノード単位で対等に混在実行**（近いもの: LangGraph, Windmill, Linear）
3. **PDG的な依存駆動・差分再計算**（近いもの: Dagster の staleness 追跡, ComfyUI のキャッシュ）

この3点の交差が本ツールの差別化。市場からの示唆: 「AIが全部やる」路線（Height 等）は死に、
「人間とAIの担当を明示して人間が主導権を持つ」路線（Linear 等）が生き残っている。
desk の ball 所有・impact 段階・「確定させてから実行」の思想はそのまま持ち込む。

## 2. アーキテクチャ

```
[Web UI: グラフ + アウトライン + チャット]   [Claude Code 等 (MCP経由)]
                  \                          /
        [コアエンジン: 変更API + スレッド + スケジューラ]
                  |
   [executor プラグイン: claude -p / codex / script / human-wait]
```

- **コアエンジンとUIはローカルでもVPSでも同じものが動く**（desk の server.py + static と同型）
- **グラフ変更APIをMCPサーバとしても公開する**。チャットで整理する入口を自作UIに限定しない
- **AIノードの実行者はヘッドレスのエージェントCLI全般**（claude -p / codex / ローカルLLM…）を
  プラグインとして差し替え可能にする。LLM選択は「APIキーの差し替え」でなく「エージェントごと差し替え」
- 内蔵チャットは薄いループ + プロバイダ選択式（Vercel AI SDK 系を想定）

### 技術スタック

TypeScript 一枚岩。pnpm workspace。

| package | 役割 |
|---|---|
| `packages/core` | データモデル（zod スキーマ）・グラフストア（操作ログ）・スレッドストア |
| `packages/server` | Hono HTTP API + UI配信。将来 MCP サーバもここ |
| `apps/ui` | Vite + React + React Flow（グラフ）。UIキットは後段で shadcn/ui 化予定 |

ストレージはファイル（データディレクトリ、既定 `./data`）:

```
data/
├── ops.jsonl            … グラフ変更の操作ログ（追記専用・帰属付き）
├── snapshot.json        … 現在のグラフ状態（操作適用後に毎回書く。ops.jsonl から再構築可能）
└── threads/<node>.jsonl … ノードスレッド（追記専用）
```

## 3. 大原則

### 3.1 グラフが正データ、テキストは投影

- グラフ（ノード+エッジ、各ノードに文字）が唯一の正。テキスト（アウトライン）は投影
- テキストビューは「変換」ではなく**同一データへの第二のエディタ**。テキスト編集は
  パース→再構築ではなく、グラフへの差分操作（add/rename/reparent）に翻訳する。
  **ノードIDを壊さない**ことが絶対条件（実行履歴・進捗・スレッドがIDに紐づくため）
- アウトラインは木、依存はDAG。テキスト側は木 + `[[参照]]` で複数親を表現する
- グラフの表示は**縦方向**（文字が横書きのため。アウトラインとの視線方向も揃う）

### 3.2 すべての変更は操作ログを通る

人間のUI操作も、チャットAIの編集も、MCP経由の操作も、同じ操作語彙に落ちて
ops.jsonl に追記される。snapshot.json の直接編集は禁止（desk の graph.json 直編集禁止と同じ規律）。

得られるもの: **帰属**（誰がいつ何を変えたか）/ **undo**（ログの巻き戻し）/
**AIへの差分コンテキスト**（グラフ全文でなく「前回からの差分」を渡せる）。

### 3.3 draft / committed

グラフに「編集中（draft）」と「確定済み（committed）」の区別を持つ。
AIとの整理は draft 側で自由に行い、人間の確定操作で committed に昇格した部分だけを
実行エンジンが動かす。審議中の法案と公布済みの法。

### 3.4 実行者の3軸メタデータ

ノード種別の enum を増やさない。スケジューラが挙動を変えるのに必要な直交軸だけを持つ:

- **executor**: `human` / `ai` / `script` — 誰にディスパッチするか
- **決定性**: script は決定的（キャッシュ・再実行可）、ai は非決定的（キャッシュ不可）
- **impact**: `safe` / `reversible` / `irreversible` — 不可逆な外部副作用は承認ゲートを通す

新しいノード種を足したくなったら「スケジューラはそれで挙動を変えるか？」と問う。
変えないならタグでよい。

### 3.5 硬化ライフサイクル（AI→スクリプト）

- パターンが固まっていない仕事はAIノード（判例）
- 安定したらAI自身にスクリプトを書かせて決定的ノードへコンパイル（成文法化）
- スクリプトが失敗したらAIノードにフォールバック（また判例に戻す）
- UIではスクリプト化済み/LLM処理中が一目で分かるようにする（バッジ・硬化率）

### 3.6 入れ子ノードと自己改善（Houdini HDA と同型）

- ノードを開くと中にサブグラフ（スクリプト部分とLLM部分の混在）がある。外から見れば
  入出力契約だけのブラックボックス = HDA
- **自己改善許可フラグ** = アンロックHDA。許可されたノードの内部は AI が書き換えてよい
- 安全装置3つ:
  1. **境界の契約は外側のもの**。入出力契約は外側のグラフ=人間の管轄。AIが変えられるのは
     契約を守る範囲の内部実装だけ（省令は変えられるが法律は議会を通す）
  2. **過去の実行が回帰テスト**。実行ごとの入出力ペアを蓄積し、改善後の検証に使う
  3. **自己改善で impact は上げられない**。自分の権限を自分で拡大するのは構造的に禁止

### 3.7 実行モデル（PDG から輸入。実装は後段）

- ノード=テンプレート、実行ごとに**ワークアイテム**を生成（単発/定期/ファンアウトを統一）
- **dirty伝搬**: 上流の前提が変わったら下流だけ再実行対象になる
- **キャッシュ**: 決定的ノードは入力が同じなら再実行しない
- **スケジューラ抽象**: ローカル実行とリモート(VPS)実行を同じグラフで差し替え可能に
- 人間待ちは**ブロッキングではない**。ボールが人間にある間も依存しない枝は進む。
  人間の回答は「入力が揃った」イベントにすぎない
- 長時間停止と再開には durable execution の考え方（状態永続化）。自作するか
  Temporal/Inngest 系に乗るかは規模を見て判断

## 4. HITL（人間にボールが回る）設計

zinsei 運用で判明した3課題への解: **会話はノードに帰属、通知は一つの受信箱に集約**。

- **① 会話の正本はノードスレッド**。ノード選択でサイドパネルに表示。ノードの「中」に
  詰め込まない。グラフ上は未読バッジ+ボール所有アイコンのみ
- **② 受信箱**: 全ノード横断で ball=human を列挙。Discord/プッシュ通知は受信箱への玄関に
  すぎず、どこから入っても同じスレッドに着地する（`via` フィールドで玄関を記録）
- **③ 文脈税**: 人間への質問は構造化された判断リクエスト（後述）。context 必須・
  専門用語禁止。質問カードをクリックするとグラフ上でノードがハイライトされ、
  ゴールからの派生経路が光る（「何の話だっけ」への最強の答えは位置を見せること）
- **④ ラリー**: 選択肢を選べば即決着、自由文で返せばそのままスレッドでラリー。
  単発かラリーかを事前に決めない

### UIの視距離3層

1. **グラフ上（遠景）**: 状態色・ボール所有・未読バッジのみ
2. **ノードカード（中景）**: 概要・現在の状態・次のアクション1個
3. **サイドパネル（近景）**: タブ「💬会話 / 📜実行履歴 / ⚙️中身（サブグラフ）」
   — タブは**別データではなく同一ストリームへのフィルタ**

「開く」という操作が常に「一段近づく」を意味するように統一する。

## 5. データモデル

### 5.1 ノード

```jsonc
{
  "id": "n-20260729-0001",       // サーバ採番。永続・不変
  "title": "…",                   // 人間粒度の作業名
  "detail": null,                 // 補足・文脈
  "parents": [],                  // 先行ノードid。DAG。空=ルート
  "kind": "task",                 // goal(ルート意図) / task
  "executor": "ai",               // human / ai / script
  "impact": "safe",               // safe / reversible / irreversible
  "lifecycle": "draft",           // draft / committed
  "status": "pending",            // pending / running / waiting / done / dropped
  "selfImprove": false,           // 自己改善許可フラグ
  "pendingRequest": null,         // open な判断リクエストの message id
  "order": null,                  // 兄弟内の表示順
  "created": "…", "updated": "…"
}
```

導出概念（保存しない）: **frontier** = status が done/dropped 以外で parents が全て done。

### 5.2 操作ログ（ops.jsonl の1行）

```jsonc
{
  "id": "op-…", "ts": "…",
  "actor": { "kind": "human" },            // human / agent / system + name
  "via": "ui",                              // ui / mcp / engine / api / discord …
  "op": "node.add",                         // node.add / node.patch / node.remove
  "payload": { … }
}
```

検証はエンジンが行う: parents の存在・循環禁止（自己/子孫を親にできない）、
remove は子を持たないノードのみ（MVP）。

### 5.3 ノードスレッド（threads/<node>.jsonl の1行）

```jsonc
{
  "id": "m-20260729-0001",
  "node": "n-20260729-0004",
  "ts": "…",
  "author": { "kind": "agent", "name": "executor:claude-sonnet" }, // human/agent/system
  "via": "engine",                // ui / discord / mcp / engine — どの玄関から来たか
  "kind": "say",                  // say / decision_request / decision_answer / status / artifact
  "body": "…",
  "payload": null                 // kind固有。decision_request なら下の request
}
```

1ノード1ストリーム。会話・判断・実行ログ・成果物が同じ時系列に乗り、
UIタブはフィルタとして実装する。

### 5.4 判断リクエスト（kind=decision_request の payload）

```jsonc
{
  "request": {
    "context": "3行以内の平易な要約。専門用語禁止・ゴールの言葉で",   // 文脈税
    "question": "一文の質問",
    "options": [
      { "id": "go", "label": "投稿する", "then": "選ぶと何が起きるか",
        "recommended": true }
    ],
    "impact": "irreversible",     // この判断自体の影響
    "undo": "戻し方 or null",
    "expires": null,              // ISO8601。null=無期限
    "on_expire": null             // 期限切れ時に自動選択する option id。null=保留のまま
  },
  "status": "open",               // open / answered / cancelled / expired
  "answer": null                  // → { "option": "go", "note": "…", "by": …, "ts": … }
}
```

desk の ask からの改良点: context の必須化 / recommended / リクエスト自身の impact・undo /
expires・on_expire（「答えないとAIが永久に止まる」構造を作らない）。

ノードの `pendingRequest` は open なリクエストの message id を指す。
open なリクエストの存在 ⇔ ボールが人間、が機械的に対応する。

## 6. ロードマップ

- [x] M0: リポジトリ・設計文書
- [ ] M1: core — スキーマ + 操作ログ式グラフストア + スレッドストア（テスト付き）
- [ ] M2: server + UI — グラフ/アウトライン二重ビュー、ノードパネル（スレッド+判断カード）
- [ ] M3: MCP サーバ（グラフ変更APIの公開）
- [ ] M4: 内蔵チャット（プロバイダ選択式）
- [ ] M5: executor プラグイン（claude -p / script）と実行エンジン
- [ ] M6: PDG的実行モデル（ワークアイテム・dirty伝搬・キャッシュ）
- [ ] 後段: shadcn/ui 化とテーマ機構 / 入れ子ノード / 自己改善 / durable execution 判断

## 7. 参考（先行ツールから盗む場所）

| サブシステム | 参照実装 |
|---|---|
| 単一データ・複数ビュー | Taskade |
| staleness 追跡・選択的再実行 | Dagster |
| 人間待ち interrupt | LangGraph |
| ワーカープール・リモート実行 | Windmill |
| 入れ子ノード・ロック/アンロック | Houdini HDA |
| 人間/AI担当の制度化 | Linear (Assignee/Contributor) |
