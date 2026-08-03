# 設計文書 — GraphWrangler（agent-driven procedural task graph）

人間・AI・スクリプトが同じタスクグラフの上で働くツール。
この文書は**現行実装の設計を記述する**。実装と食い違ったら実装に合わせてここを直す。

## 1. 目的

タスクを人間とAIが一緒に整理し、整理したタスクを 人間 / AI / スクリプト が分担して
処理し、進捗を可視化する。核は**人間/AI/スクリプトをノード単位で対等に混在実行**できること
（実行・判断・起点のすべてが executor 軸で 人間/AI/スクリプト に割り当てられる）。

「AIが全部やる」路線ではなく、「人間とAIの担当を明示して人間が主導権を持つ」路線。
ball 所有・承認ゲート(approval)・「確定させてから実行」の思想で貫く。

## 2. アーキテクチャ

```
[Web UI: グラフ + チャット]   [Claude Code 等 (MCP経由)]
              \                /
    [server: HTTP API（操作ログ） + 内蔵チャット + 試走]
              |
[engine: executor（claude CLI / API / script）・トリガー発火・ラン実行]
```

- **サーバとUIはローカルでもVPSでも同じものが動く**
- **グラフ変更APIをMCPサーバとしても公開する**。チャットで整理する入口を自作UIに限定しない
- **AIノードの実行者はヘッドレスのエージェントCLI全般**を差し替え可能にする。
  現状の実装は claude CLI（既定）と Anthropic/OpenAI API の2方式
- 内蔵チャットは薄いループ + プロバイダ選択式（Vercel AI SDK）

### AIの三役

同じLLMでも「どこに座っているか」で役割が違うので、UI上の呼び名を分けている:

| 呼び名 | 実装 | 何をするか |
|---|---|---|
| **Workflow AI** | `packages/server/src/chat.ts` / `chat_cli.ts`（右ドロワー） | ページ全体を相手にグラフを整理する。ノードの追加・並べ替え・手順書やスクリプトの起草。既定の話題は表示中のページだが、全プロジェクトの横断一覧を常時文脈に持ち、「全体」「他のプロジェクト」と言われたら get_state / state_get でグラフ全体を見て答える（2026-08-02） |
| **Task AI** | `packages/server/src/thread_ai.ts` | 1ノードのスレッドで相談に乗る。人間が say を書くと非同期で応答する（open な判断リクエストがあるノードでは黙る——そこはエンジンの担当） |
| **実行AI** | `packages/engine/src/executors/claude.ts` | executor=ai のノードを実際に実行する。impl の手順書を読み、成果と経過をスレッドへ書く |

### 技術スタック

TypeScript 一枚岩。pnpm workspace。

| package | 役割 |
|---|---|
| `packages/core` | データモデル（zod スキーマ）・グラフストア（操作ログ）・スレッドストア・ランストア |
| `packages/server` | Hono HTTP API + UI配信 + 内蔵チャット（Workflow AI / Task AI）+ 試走 |
| `packages/engine` | 実行エンジン（executor: script / claude CLI / API、ラン生成、トリガーの発火判定） |
| `packages/mcp` | MCP サーバ（stdio。Claude Code 等からグラフを直接読み書き） |
| `apps/ui` | Vite + React + React Flow（グラフ）+ shadcn/ui + Tailwind。ライト/ダークのテーマ機構 |

ストレージはファイル（データディレクトリ、既定 `./data`）:

```
data/
├── ops.jsonl            … グラフ変更の操作ログ（追記専用・帰属付き）
├── snapshot.json        … 現在のグラフ状態（操作適用後に毎回書く。ops.jsonl から再構築可能）
├── settings.json        … AI設定（接続方式・モデル・APIキー。キーは書き込み専用で読み出さない）
├── reads.json           … ノードごとの既読時刻（未読バッジ用。端末間で共有するためサーバ持ち）
├── threads/<node>.jsonl … ノードスレッド（追記専用）
├── chats/global.json    … Workflow AI の会話履歴（1本のグローバル会話。archive で過去分を退避。2026-08-02 にページ単位を廃止、旧 chats/<page>.json は遺構）
└── runs/<run>.json      … ラン（実行インスタンス。5.5）
```

これは既定の data-dir モード。既存リポジトリを開くワークスペースモード（3.10）では、
上記の代わりに正データファイル（`<repo>/workflow.gw.json`）+ サイドカー `.graphwrangler/`
（threads/ と chats/ はコミット対象、ops.jsonl・runs/・settings.json・reads.json は
自動生成の .gitignore で除外）という配置になる。

## 3. 大原則

### 3.1 グラフが正データ。構造は「依存」と「包含」の2軸

- グラフ（ノード+エッジ、各ノードに文字）が唯一の正。他のビュー（台帳・トレース）は投影
- **2つの独立した軸で構造を持つ**:
  - **依存 = `parents`（DAG）**。実行順。エッジとして描かれ、frontier・skip 伝搬・
    ラン生成がこれを辿る
  - **包含 = `group`（1階層）**。ノードがどのページ（フォルダ）に属するか。ゴールは
    「グラフの先頭ノード」ではなく**ノード群のフォルダ**。左レール1行 = 1ページ = group 1つ
  - この2軸は交差しない。親が別ページのノードでも依存は張れる
- **ノードIDを壊さない**ことが絶対条件（実行履歴・進捗・スレッドがIDに紐づくため）。
  どのビューからの編集もIDを保つ差分操作（add/patch/remove）に落とす
- グラフの表示は**縦方向**（rankdir=TB。文字が横書きのため）

### 3.2 すべての変更は操作ログを通る

人間のUI操作も、チャットAIの編集も、MCP経由の操作も、同じ操作語彙に落ちて
ops.jsonl に追記される。snapshot.json の直接編集は禁止。

得られるもの: **帰属**（誰がいつ何を変えたか）/ **undo**（逆操作の補償追記）。

`via` フィールドで玄関（ui / mcp / engine / chat …）を、`actor` で操作者
（human / agent / system + name）を記録する。帰属の規約:

- MCP経由: `via: "mcp"`, actor `{kind:"agent", name:"mcp"}`
- チャットAI: `via: "chat"`, actor `{kind:"agent", name:"chat:<model>"}`
- エンジン: `via: "engine"`, actor `{kind:"agent", name:"engine"}` /
  executor実行の投稿は `name:"executor:<type>"`

ワークスペースモード（3.10）ではこの前提が変わる: 正データファイルが正・操作ログは
undo 用の作業記録に格下げされる。

### 3.3 draft / committed

グラフに「編集中（draft）」と「確定済み（committed）」の区別を持つ。
AIとの整理は draft 側で自由に行い、人間の確定操作で committed に昇格した部分だけを
実行エンジンが動かす。審議中の法案と公布済みの法。

**「プラン済み」の判定基準**: **やり方（どう進めるかのワークフロー）が決まっていること**。
成果が決まっている必要はない。例:「作品タイトルを決める」ノードは、タイトル自体（成果）が
未定でも、**タイトルの決め方**が決まっていればプラン済み。成果は実行の産物であり、
プランの対象は常に「やり方」。

これで 未計画 → プラン済み → Fix が一本の梯子になる:
**未計画**（やり方が無い）→ **プラン済み**（やり方が決まった。実行に出せる）→
**Fix**（3.5。やり方をもう変えないと判を押す）。

### 3.4 実行者の3軸メタデータ

ノード種別の enum を増やさない。スケジューラが挙動を変えるのに必要な直交軸だけを持つ:

- **executor**: `human` / `ai` / `script` — 誰にディスパッチするか
- **決定性**: script は決定的、ai は非決定的
- **approval**: `true` / `false` — 実行の直前に人間の承認ゲートを通すか
  （UI上の名称は「実行前承認」トグル。不可逆な外部副作用を持つ作業に立てる。
  旧名 impact("safe"|"irreversible")——2026-08-03 改名: impl と紛らわしい・
  「ゲートの有無」という実態と名前がズレていた・判断リクエスト自身の impact
  （reversible を含む3値でこれとは別の軸——5.4）と同名衝突、の3点を解消。
  旧データ・旧クライアントは core の *CompatSchema が読み替える）。
  **承認ゲートは「機械（AI/スクリプト）の仕事」の直前に挟まるもの**: task は実行前、
  trigger は発火前（3.8）。担当=人間のノードでは本人の操作が承認そのものなので
  トグル自体を出さない（既に irreversible のノードだけ解除用に表示する）
- **autonomy**: `high` / `normal` / `low` — AI がどこまで人間に聞かずに進むか
  （UI名「自律度」。executor=ai の kind=task でのみ意味を持つ。2026-08-03）。
  実行AIのプロンプトには「人間の判断が必要なら `QUESTION: 質問文`（+任意の
  `OPTION: 選択肢` 最大3行）だけを出力して止まる」規約が入り、エンジンが
  この出力を検知すると done にせず判断リクエストへ変換する（選択肢は id `ai:N`、
  末尾に必ず「中止」= 予約id `abort`）。回答（選択肢・自由文どちらでも）は
  次回実行のプロンプトに「スレッドの経緯」として差し込まれ、再実行される。
  - `high`: 質問規約を出さず「合理的な仮定を置いて最後まで進め（仮定は成果に明記）」。
    実行失敗もまず自動リトライ（2回、失敗理由を経緯として与える）し、尽きて初めて
    失敗リカバリカードを開く
  - `normal`（既定）: 規約あり。本当に人間にしか決められないことだけ質問する
  - `low`: 規約あり。前提が曖昧・優劣不明・好みが分かれるなら質問するほうに倒す
  - **approval の承認ゲートは autonomy では外れない**（安全装置はノード属性で無効化
    できない。ゲートを外したければ approval を false に戻す＝別の明示操作）

新しいノード種を足したくなったら「スケジューラはそれで挙動を変えるか？」と問う。
変えないならタグでよい。エンジンが自動実行するのは lifecycle=committed のノードだけ
（「committedのみ自動実行」の原則）。

### 3.5 Fix（= ロック。やり方の確定）

**Fix とは「このノードのやり方はもう確定した」と判を押すこと**（Houdini のロックと同じ）。
`fixed` フラグで表す。ノードは未Fix（改善中）で生まれ、人間が Fix する。

- **Fix ≠ スクリプト化**。確定した中身は スクリプトでも、手順書でも、「ここは人間が
  判断する」でも、「ここは AI の裁量に任せる」でもよい
- **実装形態（impl: 会話=null → 手順書 doc → スクリプト script）は Fix と独立な
  「素材」のスペクトラム**。未Fix の間、AI は実行しながら素材を育ててよい
  （会話→手順書化→スクリプト化）
- **素材選びの操作的テスト**: 「前提知識を渡しても結果は変わらないか」— 変わらない
  （決定的）ならスクリプト素材が向く。変わるなら判断が残る＝手順書 or 裁量で確定してよい
- スクリプトが失敗したら未Fix に戻して AI に直させる → 直ったら再 Fix
- **ページの Fix = 全メンバーが Fix された状態**。UI の Fix率チップ（n/m）が 100% に
  なったページは形が固まった証拠で、ルーティーン昇格の合図になる
- 3軸の直交: lifecycle（実行してよいか）/ impl（やり方の素材）/ fixed（やり方が確定したか）
- **Fix はソフトな印ではなく実効的なロック**: 保護対象は「やり方」フィールド
  （title/detail/kind/executor/approval/parents/group/branches/parentOptions/schedule/impl）で、
  fixed=true の間はサーバ（`GraphStore.patchNode`）がこれらの実質的な変更を 409 で拒否する
  （同値の patch=no-op は許可）。impl だけ params[].value の変更は例外で許可する——
  値は実行時入力であってやり方ではないため（`implEqualIgnoringParamValues`、
  packages/core/src/graph.ts）。`removeNode` は既定では fixed ノード・メンバー持ち・
  子持ちを拒否するが、**force=true（UI の確認モーダル通過後）なら消せる**——メンバーは
  巻き添え削除、残る子は parents/parentOptions から切り離す（2026-08-01 本人指摘
  「消せないのは違う。ロックはモーダルで確認」）。`undoLast`/`redoLast`
  の補償も fixed ノードの保護フィールドを変える・削除する・復活させる操作は拒否する
  （fixed フラグ自体の付け外しを戻す undo/redo は許可——ロックは解除できる必要がある）。
  **進捗（status）と params の値・試走・fixed 自体はロック中も自由に動く**。UI は保護
  フィールドの編集UIを disabled にするが、実効性の根拠は常にサーバ側の拒否である

### 3.5.1 担当×実装の対応表と試走ゲート

3.4 の executor と 3.5 の impl は直交軸。実行に使われる組み合わせの対応表:

| executor | impl が使われる条件 | 使われ方 |
|---|---|---|
| human | impl.type === "doc" | 人間が読む手順書 |
| ai | impl.type === "doc" | 実行時プロンプトへインライン（text 優先、無ければ path のファイルを読む） |
| script | impl.type === "script" | command を子プロセスで実行（決定的） |

**それ以外の組み合わせは実行に使われない**。このため実装の種類セレクトで「スクリプト」を
選べるのは担当=script（かつ kind≠trigger）のときだけ（担当を後から変えた等で既に script
実装を持つノードは、現在値として表示・編集できるまま残す）。UI はこれを2種類の⚠として明示する:

- **担当=script なのに impl が script でない** → 「実装が未接続（実行すると失敗します）」
  （NodePanel に常時表示 + NodeCard のタイトル右端に destructive の⚠）。
  **kind=trigger は対象外**——トリガーの executor=script は「schedule で発火する」の意味で
  あって command 実行ではない（3.8）ため impl 不要
- **担当が script でないのに impl.type="script"** → 「このスクリプトは実行されません
  （担当がスクリプトではないため）」（NodePanel の実装セクション内の軽い注記のみ）

**impl を script にするのは宣言であって証明ではない**。「書いてるだけ」のスクリプトが
実行に乗って黙って失敗しないよう、試走（trial）というソフトゲートを挟む:

- `POST /api/nodes/:id/trial`（実装 `packages/server/src/trial.ts`）が command を実際に
  1回子プロセスで実行し、結果を `node.implTrial = {hash, success, ts}` としてノードへ記録する
  （hash は command の sha256 hex）。approval=true（実行前承認）でも試走は可能
  （試走は常に --dry-run の予告編で副作用が無いため）
- **hash は鮮度チェック**: command を編集すると hash が変わり、過去の試走結果は
  「stale」（コマンドが変更されています）に落ちる。UI（NodePanel）が
  ok（hash一致+成功） / stale（hash不一致） / unverified（未試走、または hash一致でも
  失敗） / not-script の4値で表示する
- **昇格時に警告する（ハードブロックはしない）**: 担当を script に変更するとき、または
  担当=script のノードで「プラン済みにする」を押すとき、試走が ok でなければ
  `window.confirm` で確認する。**人間が主導権を持つ思想どおり、ゲートは常にソフト**
- 試走の実行結果はノードスレッドに kind:"status" で記録される（成功/失敗(exit N) +
  実コマンド + 出力先頭500字）

**手順書のファイル化**（2026-08-02）: impl.type==="doc" のインライン本文（text）は、
NodePanel の「本文をファイル化」ボタン（`POST /api/nodes/:id/impl/to-file`）でワークスペース内の
ファイルへ書き出し、impl を path 参照へ切り替えられる。手順書がリポジトリの普通のファイルになり、
エディタで開ける・git で版管理される・スクリプトと同じ場所で育てられる。パスは
resolveWorkspacePath でルート外脱出を拒否し、既存ファイルへの上書きは overwrite 明示時のみ。
fixed ノードは impl 変更の Fix ガードにかかるためファイル化できない（先に解除）。

**パラメータ宣言**: impl.type==="script" の command は、引数が要る場合 `{name}`
プレースホルダ入りのテンプレートとして書ける。宣言（`impl.params: {name, label?, example?,
value?}[]`）は **Workflow AI が書き、値（value）は人間が NodePanel の実装欄で入力する**。
試走・本走ともに実行直前に `substituteParams(command, params)`（server:
`packages/server/src/trial.ts`、engine: `packages/engine/src/params.ts` に同一ロジックを複製。
**変えたら両方直す**）で `{name}` を対応する value へ置換する（値は二重引用符で囲み、内部の
`"` は `\"` にエスケープ）。宣言に無い `{xxx}` や value 未入力の宣言が残っていれば置換失敗
（missing）とし、**実行しない**: 試走は 400（パネルが「未入力: <名前>」を表示し試走ボタンを
disabled にする）、engine の本走は既存の失敗→リカバリの器に「パラメータが未入力です」を
乗せる。implTrial.hash は **command テンプレート**の sha256 のままで、値の変更だけでは
stale にしない。

**試走 = 常に `--dry-run` の予告編**: `POST /api/nodes/:id/trial` は置換後のコマンド
**+ " --dry-run"** を必ず付けて実行する（本走には付けない）。AIがスクリプトを書くときの
規約として「`--dry-run` 実装が必須」を課すことで、試走ボタンを押しても実際の副作用が
起きないことを構造的に保証する。

**スクリプトの置き場所と言語の規約**: スクリプトファイルは**そのノードの impl.path の
手順書と同じフォルダ（工程フォルダ）に、同じ番号接頭辞で置く**。言語は **Node.js（.mjs）か
Python（.py）を優先**——OS依存スクリプトは避ける（ワークフローは複数人・複数OSで回るため）。
impl.command はワークスペースルートからの相対パスで書く。この規約は Workflow AI の
人格プロンプト（packages/server/src/chat.ts）に焼き込んである。

### 3.8 トリガー起点のルーティーン

**「ルーティーンであること」は宣言ではなく、フロー先頭のトリガー（起点）ノードから
導出される**（Rx の思想: トリガー = Observable のソース、ラン = イベントの伝搬）。
ページは goal のみ。

- **トリガーノード（kind="trigger"）**: フローの先頭に置く。parents を持てない。
  起動方式は executor 軸で一貫（実行・判断・起点の全てが 人間/AI/スクリプト）:
  - **script** = cron 的な定期実行。schedule 文字列（every Nm/Nh/Nd・daily HH:MM・weekly dow HH:MM）
  - **ai** = schedule をチェック間隔とし、間隔ごとにエンジンが AI に「今発火すべきか」を
    判定させる。条件は detail / 手順書に書く。人間へのリマインドもこれ
  - **human** = 手動発火（トリガー上の ▶）
- **発火 = ラン生成**。ワークアイテムはトリガーの子孫（トリガー自身は含めない）
- **並列ラン（パラレルワールド）**: 同じルーティーンを複数のランで並行して回せる
  （同じテンプレートグラフ・別のラン状態。例: 作品Aと作品Bのボイス収録を同時進行）。
  手動▶の発火時にランへ名前（作品名など）を付けて世界線を区別し、グラフ投影は
  ツールバーのセレクトでどのランを見るか切り替える（既定は最新の実行中ラン）。
  ラン名は後から変更できる（`POST /api/runs/:id/rename`。グラフツールバーの✎と
  台帳のトレースヘッダの✎から）。
  エンジンは全ての実行中ランのアイテムを並行して進める（1並列・ラン created 昇順）。
  **自動発火（script/AI トリガー）は実行中ランがあると発火しない**のは従来どおり
  （積み残し防止）——並列で回すのは手動▶の管轄
- **発火前承認（approval=true のトリガー）**: script/AI の自動発火の直前に、
  トリガーのスレッドへ go（発火して）/ skip（今回は見送る）の承認カードを開き、
  go 回答の1回だけ発火する（task の実行前承認と同型。「不可逆は毎回確認する」）。
  **skip はその回の発火とみなす**（発火判定の基準を「最新ランと skip 回答の新しい方」に
  することで、見送り直後に確認カードが再発行され続けるのを防ぐ。every 系は skip から
  間隔経過後、daily/weekly は次の暦日/週にまた確認する）。**手動▶はゲートを通らない**
  （人間が押すこと自体が承認）。実装は `packages/engine/src/trigger.ts` の
  `buildFireApprovalRequest` / `findFireGate` / `fireBaseline` / `hasUnconsumedGo`
- **Fix はランの参加条件ではない**: 形が固まっていなくても回せる（draft のステップも
  アイテムに入る）。エンジンが自動実行するのは committed のものだけ、という安全則は維持
- プロジェクト⇔ルーティーンの往復は「トリガーを置く/外す」の1操作。
  「プロジェクト/ルーティーン」は呼び名として残る（トリガーの有無の別名）
- 台帳ビュー・トレースはトリガーを持つページに表示。ランの待ち（ワークアイテムが
  waiting）はデスクトップ通知の対象として拾う
- ルーティーンページのメンバー（テンプレート）はプロジェクト側エンジンから除外される
  （ラン側のワークアイテムが実行を担う。除外しないと二重実行になる）
- 実行中ランの進捗は、そのページのグラフ・ノードパネルにも投影される（アクティブな
  ラン = status=running の最新1本がある間だけ）
- AI発言には出典バッジ（プロンプトに実際に含めた文脈名 `sources`）が付く

### 3.9 分岐ノード（条件分岐）

**実行フェーズの原則**: 実行系の操作（分岐を選ぶ・実行の確定など）は「実行フェーズに
入ったノード」= lifecycle=committed かつ 全 parents が done|skipped（frontier）のノードで
のみ許可する。**会話（スレッドでのAI相談・プラン改善）と編集系はいつでも可**のまま。

「完了時に選択肢を1つ選ぶノード」。判断者は executor 軸をそのまま使う:

- **human**: 既存の判断リクエストが開き、回答の選択肢が**そのまま経路**になる
- **ai**: AI が状況から選択肢を選ぶ（理由はスレッドへ。毎回同じ選択なら script への Fix 候補）
- **script**: スクリプトが選択肢 id を stdout に出す（決定的な条件分岐）

- **kind: "decision" を正式なノード種として持つ**（スケジューラが挙動を変える=
  未選択の枝を skip する、ため。3.4 のテストに合格）
- **両層で使える**（プロジェクト=一回きりの判断、ルーティーン=ラン毎に再判断）
- **必ず1つ選ぶ**（単一選択のみ。複数枝同時・確率分岐・else 既定枝は無い）
- **ループは無い**（DAG 制約維持。繰り返しは「次のラン」で表現する）
- スキーマ: node.branches = 判断リクエストの options と同形（{id, label, then?}）。
  子側はどの枝から生えるかを child.parentOptions[decisionId] = branchId で持つ
  （parents は string[] のまま）
- 実行セマンティクス: decision 完了で選択肢が確定 → 選ばれなかった枝の下流は
  status "skipped"。合流ノードは「skipped でない親が全て done なら着火」
- UI: decision ノードは下辺に選択肢ごとの出力ポート（ラベル付き）。実行後は
  選ばれなかった枝のエッジを減光。台帳ビューではラン毎にどの枝を通ったかが見える
- **決着経路は「分岐を選ぶ」のみ**: decision には実行系の進捗ボタン（着手/完了/戻す）を
  出さない（choice を経ずに done にできる二重経路を作らない。ランのワークアイテムも同様で、
  台帳セルのトグル・カード/パネルのランボタンとも decision は対象外）。
  プラン済み化だけは残す（committed が選択の前提条件のため）
- **選び直し（手戻り）**: 決着済みの分岐はパネルの「選び直す」で choice を取り消せる
  （`GraphStore.revertDecision` / `POST /api/nodes/:id/decide/revert`）。この決着に由来する
  skip（直接・連鎖とも）は pending に復元されるが、**他の決着済み分岐による skip と、
  下流で既に done/dropped になった作業は戻さない**（やり直しの範囲は人間が判断する）。
  ラン層の分岐に選び直しは無い（繰り返しは「次のラン」で表現する、の原則どおり）
- **負けた枝への後付けは自動 skip**: 決着済みの分岐の「選ばれなかった枝」へ後からノードを
  追加・接続した場合、そのノードは skipped で作られる/になる（decide 時の skip 伝搬は
  その時点のノードにしか届かないため。放置すると frontier 扱いでエンジンに誤実行される）。
  選び直しをすればこれらも一緒に復元される

### 3.10 ワークスペース = リポジトリのルートに1ファイル

既存プロジェクトのワークフロー文書を GraphWrangler でリプレイスするための開き方。
対象リポジトリのルートに置いた1ファイルを「開く」。

```
<repo>/
├── workflow.gw.json        ← 正データ（グラフ定義）。人がレビュー/コミットする対象
├── .graphwrangler/         ← サイドカー（サーバが自動生成）
│   ├── .gitignore          ← 自動生成（ops.jsonl / runs/ / settings.json / reads.json を除外）
│   ├── threads/*.jsonl     ← 会話・判断の経緯。コミットする
│   ├── chats/global.json   ← Workflow AI の会話履歴（グローバル1本）。同じ理由でコミットする
│   ├── runs/*.json         ← ラン履歴。gitignore
│   ├── ops.jsonl           ← セッション内 undo 用の作業記録。gitignore
│   ├── reads.json          ← 既読時刻（個人の閲覧状態。活動の記録ではない）。gitignore
│   └── settings.json       ← AI設定（APIキー含む）。gitignore
└── docs/ ...               ← 既存ドキュメント。ノードから impl.path で参照
```

- 起動: `GRAPHWRANGLER_WORKSPACE=<path>` または `--workspace <path>`（.gw.json ファイル、
  ディレクトリなら `<dir>/workflow.gw.json`）。指定が無ければ data-dir モード
- **ワークスペースモードでは正データファイルが正**。起動時にファイルを読み、ops.jsonl は
  再生しない（undo 用の短期メモ。長期の版管理は git がやる）
- シリアライズは決定的（キー辞書順・ノードid昇順・アトミック書き込み）。git diff が
  「ノードを1個足した」と読める
- **外部編集の検知はしない**: サーバ稼働中に正データファイルを外から書き換えたら（git pull 等）
  サーバを再起動する。書き手はサーバ1プロセスのみ（エンジン・UIは全てサーバAPI経由）
- **impl のパス参照**: `impl: {type:"doc", path:"docs/x.md"}` でリポジトリ内ドキュメントを参照。
  エンジンが実行時に `GET /api/files`（ルート内解決・脱出ガード付き）で読んでプロンプトに
  インライン（text と両方あれば text 優先）。script executor と試走の cwd もワークスペースルート
- 移行: `node scripts/migrate-to-workspace.mjs <dataDir> <canonicalFile>`

## 4. HITL（人間にボールが回る）設計

**会話はノードに帰属、人間の手番は「数」でなく「色」で示す**。

- **① 会話の正本はノードスレッド**。ノード選択でサイドパネルに表示。グラフ上は
  未読バッジ+ボール所有アイコンのみ
- **② ヘッダーは「溜める箱」ではなく「投げ込む口」**:
  - 未処理件数を常時見せるUIは持たない（数字は圧をかけるだけ）
  - 手番の導線は**色が担う**: あなたの番のノードは `--attention`（橙）で光り、左レールの
    ちょぼ（席の内訳）にも同じ色が出る。ページ行に出る数字は未読メッセージ数だけ
  - ヘッダー中央は**ゴール捕獲欄**。思いついたゴールを一行書いて Enter で**即プロジェクト**
    （goal ノード = 空のページ）が生まれ、そこへ移動する。未整理の受信箱を作ると「捌く」
    仕事が増えるので、書いた瞬間にプロジェクトになる
  - 捕獲時に AI の分解は自動で走らせない（分解したくなったら開いた先で Workflow AI に頼む）
  - **プロジェクト作成の入口はこの1箇所だけ**。左レールの「＋」は作成せず、この欄へ
    フォーカスを渡す
- **③ 文脈税**: 人間への質問は構造化された判断リクエスト（5.4）。context 必須・
  専門用語禁止
- **④ ラリー**: 選択肢を選べば即決着、自由文で返せばそのままスレッドでラリー。
  単発かラリーかを事前に決めない

### UIの視距離3層

1. **グラフ上（遠景）**: 状態色・ボール所有・未読バッジのみ
2. **ノードカード（中景）**: 概要・現在の状態・次のアクション
3. **サイドパネル（近景）**: タブ「💬会話 / 📜履歴」（タブは**別データではなく
   同一ストリームへのフィルタ**）

「開く」という操作が常に「一段近づく」を意味するように統一する。

### 4.1 画面の骨格と道具立て

```
┌ ヘッダー ─────────────────────────────────────────────┐
│ GraphWrangler  [エンジン停止中]   《ゴール捕獲欄》   ↶ 🔍 ⌨ ☀ ⚙ 💬 │
├────────┬──────────────────────────┬──────────────┤
│ 左レール │ グラフ（React Flow, 縦方向）  │ ノードパネル   │  ＋ 右ドロワー
│ プロジェクト│ or 台帳ビュー（ルーティーン） │ 詳細/会話/履歴 │   Workflow AI
│ ルーティーン│                          │              │
│ アーカイブ │                          │              │
└────────┴──────────────────────────┴──────────────┘
```

- **左レール**: ページ一覧を「プロジェクト」（トリガー無し）と「ルーティーン」（トリガー有り）の
  2節に分ける（3.8: 分類は宣言でなくトリガーの有無から導出）。done/dropped のプロジェクトは
  「アーカイブ」節へ畳む。タイトル下の**ちょぼ**は席（ball）の内訳で、担当色 or 橙（あなたの番）
  で見せる。幅はドラッグでリサイズでき、レール自体も畳める
- **エンジン稼働表示**: 平常時は何も出さず、エンジンが止まっているときだけ警告を出す
- **道具立て**: Ctrl+K の全ノード検索パレット / ショートカット一覧（?）/ Undo・Redo（Ctrl+Z）/
  複数選択・コピー・複製・エッジ切断などのノードエディタ標準操作 / ライト・ダーク・
  システムのテーマ切替 / エクスポート / 未読バッジ（自分の操作で付いた記録は既読扱い。
  既読時刻はサーバ持ち＝PC で読めばスマホでも既読。GET /api/state の reads と
  POST /api/reads。既読は巻き戻さない=max を採る）/
  デスクトップ通知（タブが非表示のときだけ）
- **一括編集（BulkPanel）**: 2件以上選択するとノードパネルの位置に一括編集パネルが出る。
  対象は一括で意味のあるプロパティのみ——担当 / 実行前承認（AI・スクリプト担当のみ）/
  プラン済みにする・下書きに戻す / Fix・解除 / ページ移動 / 削除。タイトル・実装・進捗・
  種別・分岐の枝は個別性が高いので1件選択の管轄。Fix済みノードの「やり方」フィールド
  （担当・承認・ページ）は対象から自動で外れる
- **「プラン済みにする」はどこでも出す**: 計画（lifecycle）の操作なので、ルーティーンの
  テンプレートでも順番未到達のノードでも表示する（committed でないノードはエンジンが
  実行しないため、確定の導線が無いと詰む）。「着手/完了」は実行フェーズの操作なので
  frontier のプロジェクトノードのみ
- **UI状態はリロードを跨いで保持する**（表示中ページ・選択ノード・チャット開閉・パネル開閉・
  各種の幅・テーマ）。localStorage 側の責務で、正データには混ぜない
- **モバイル（<768px）は4ビュー専有設計**（2026-08-02 本人指定）: ヘッダーと下部タブバーを
  除き、一覧（プロジェクト）/ グラフ / ノード詳細（Task AI）/ ワークフローAI のどれか1つが
  画面を専有する。下部タブバー（MobileNav）で切替、ノードタブには選択中ノード名が出る。
  自動遷移: 一覧でプロジェクト選択→グラフ、ノードをタップ→ノード詳細、×やゴール作成→グラフ。
  グラフとチャットは非表示中もマウント維持（再レイアウト回避・応答ストリーミング継続）、
  ノード詳細は非表示中アンマウント（隠れたまま既読化しない）

## 5. データモデル

### 5.1 ノード

**実装の正は `packages/core/src/schema.ts`（zod）**。この節はその写しなので、
片方を変えたらもう片方も直すこと。

```jsonc
{
  "id": "n-20260729-0001",       // サーバ採番。永続・不変
  "title": "…",                   // 人間粒度の作業名（空文字可: 作って即リネームのため）
  "detail": null,                 // 補足・文脈
  "impl": null,                   // やり方の素材（3.5）。null=会話段 /
                                  //   {type:"doc", text?, path?} / {type:"script", command, params?}
  "implTrial": null,              // script の試走記録 {hash, success, ts}（3.5.1）
  "parents": [],                  // 依存（先行ノードid）。DAG。空=ルート
  "group": null,                  // 包含（所属ページのid）。parents とは独立な軸（3.1）
  "kind": "task",                 // goal(ページ) / task / decision(分岐 3.9) / trigger(起点 3.8)
  "executor": "ai",               // human / ai / script
  "approval": false,              // 実行前承認（trigger では発火前承認）。true=実行直前に承認ゲート
                                  //   （旧名 impact。2026-08-03 改名、旧データは読み替え互換あり）
  "autonomy": "normal",           // high / normal / low（UI名「自律度」。AI executor が人間に
                                  //   どこまで聞かずに進むか——3.4。旧データには無く既定 normal）
  "lifecycle": "draft",           // draft / committed（= プラン済み）
  "status": "pending",            // unplanned / pending / running / done / dropped / skipped
  "fixed": false,                 // Fix（やり方の確定=ロック）。未Fixで生まれる
  "pendingRequest": null,         // open な判断リクエストの message id（あれば「あなたの番」）
  "schedule": null,               // kind=trigger の起動方式（"every 15m"/"daily 09:00"/
                                  //   "weekly mon 09:00"）。パース不能な文字列は無視される
  "branches": null,               // kind=decision の選択肢 [{id, label, then?}]（3.9）
  "choice": null,                 // decision が確定した枝id（プロジェクト層。ラン層は RunItem.choice）
  "parentOptions": {},            // 親decisionId → 枝id（どの枝から生えるか）
  "created": "…"
}
```

導出概念（保存しない）: **frontier** = status が done/dropped/skipped 以外で parents が
全て done|skipped。**ページ**（左レール1行）= kind=goal のノード、またはメンバー
（group がそれを指すノード）を持つノード。**ルーティーン**（3.8）= trigger をメンバーに
持つページ。

**status の哲学**: 人間の語彙は「未計画か」「終わったか」だけ。
pending/running/skipped は機械の内部状態で、UIでは絵（スピナー・橙ドット・
チェック・斜線円）で表し名前を見せない。パネルの進捗ボタンが見せる語彙は
**未計画 →[プラン済みにする]→ 待ち →[着手]→ 進行中 →[完了]** の一本道（unplanned は
「ここだけまだ考えてない」印で、依存が揃っていてもエンジンは拾わない）。
逆方向は修復系としていつでも許す: 待ちのノードには「未計画に戻す」（status だけ
unplanned に戻す。lifecycle は committed のままでもエンジンは拾わないため安全）、
進行中・完了・中止には「戻す」（待ちへ）。
**「あなたの番（waiting）」は保存しない**: pendingRequest の有無から UI・エンジンが
導出する（open なリクエストの存在 ⇔ ボールが人間、を二重に保存しない。
ランのワークアイテムは pendingRequest を持たないため RunItemStatus に waiting が残る）。

### 5.2 操作ログ（ops.jsonl の1行）

```jsonc
{
  "id": "op-…", "ts": "…",
  "actor": { "kind": "human" },            // human / agent / system + name
  "via": "ui",                              // ui / mcp / engine / chat …
  "op": "node.add",                         // node.add / node.patch / node.remove
  "payload": { … }
}
```

検証はサーバが行う: parents の存在・循環禁止（自己/子孫を親にできない）、
remove は子・メンバーを持たないノードのみ。undo は過去行を書き換えず、
逆操作を `undoes` 付きで追記する（補償）。

### 5.3 ノードスレッド（threads/<node>.jsonl の1行）

```jsonc
{
  "id": "m-20260729-0001",
  "node": "n-20260729-0004",
  "ts": "…",
  "author": { "kind": "agent", "name": "executor:claude" }, // human/agent/system
  "via": "engine",                // ui / mcp / engine / chat — どの玄関から来たか
  "kind": "say",                  // say / decision_request / decision_answer / status / artifact
  "body": "…",
  "payload": null                 // kind固有。decision_request なら下の request
}
```

1ノード1ストリーム。会話・判断・実行ログ・成果物が同じ時系列に乗り、
UIタブはフィルタとして実装する。ファイルは追記専用で、decision_request の
open/answered は後続の decision_answer から導出する（過去行を書き換えない）。

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
    "impact": "irreversible",     // この判断自体の影響（safe/reversible/irreversible の3値。
                                  //   ノードの approval とは別の軸）
    "undo": "戻し方 or null"
  }
}
```

context の必須化 / recommended / リクエスト自身の impact・undo。
then が書けない選択肢は作らない。

ノードの `pendingRequest` は open なリクエストの message id を指す。
open なリクエストの存在 ⇔ ボールが人間、が機械的に対応する。

### 5.5 ラン（runs/<run>.json。3.8 の実行インスタンス）

トリガーの発火ごとに1本作られる。テンプレート（ページのメンバーノード）自身は
そのランでの進捗を持たず、ラン側のワークアイテムが持つ。

```jsonc
{
  "id": "r-20260730-0001",
  "procedure": "n-…",             // ランが属するページ(group)のid。既存ランファイルとの
                                  //   互換のためキー名は procedure のまま
  "title": "…",
  "trigger": "trigger:n-…:manual", // 発火元。"trigger:<id>:<manual|schedule:原文|ai>"
  "status": "running",            // running / done / cancelled
  "items": {                      // テンプレートノードid → ワークアイテム
    "n-…": { "status": "pending", // pending/running/waiting/done/dropped/skipped
              "note": null,
              "choice": null }    // テンプレートが decision のとき確定した枝id
  },
  "created": "…"
}
```

ワークアイテムは**トリガーの子孫**から作る（トリガー自身は含めない）。Fix はラン参加の
条件ではない（3.8）。UIでは台帳ビュー（ラン×ステップの表）とトレース（▶再生）で見る。
実行中ランの進捗は、そのページのグラフにも投影される。

### 5.6 ワークスペースファイル（3.10 の正データファイルの形）

```jsonc
{
  "format": "graphwrangler-workspace",
  "version": 1,
  "nodes": [ /* NodeSchema の配列。id 昇順 */ ]
}
```

決定的シリアライズ（キー辞書順・2スペースインデント）で書く。git diff が
「ノードを1個足した」と読めることが目的。実装・検証は
`packages/core/src/schema.ts` の `WorkspaceFileSchema` が正。
