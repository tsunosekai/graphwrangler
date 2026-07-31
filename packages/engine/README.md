# @graphwrangler/engine

GraphWrangler の常駐実行エンジン（M5、M6後半で手順ページ=ラン対応を追加）。HTTP API
（`packages/server`）をポーリングし、実行可能なノード（`executor: ai | script`）を自動で
処理する。zinsei desk の `desk/engine.py` の一般化にあたる。設計の正は `docs/design.md`
（3.4/3.5/3.7/3.8）・`docs/agent-contracts.md`。ラン（手順ページ）対応の詳細は本ファイル
末尾の「手順ページ（ラン）対応（M6後半）」セクション参照。

このパッケージは `packages/mcp` と同じ方針で **`packages/server` の実装には依存しない
自己完結パッケージ**にしてある。統合点は HTTP API のみ（`packages/server` のコードは
一切importしない）。`packages/core` に対しては型のみの workspace 依存を持つ
（`src/types.ts` が `export type {...} from "@graphwrangler/core"` で型を re-export するだけで、
core の実装（GraphStore 等）はランタイムにimportしない。以前は core スキーマの手動ミラーだった
が、core を変えるたびに手で追随する二重管理だったため切り替えた）。

## 起動方法

```bash
pnpm --filter @graphwrangler/engine start   # tsx src/index.ts
# または watch モード
pnpm --filter @graphwrangler/engine dev
```

## 環境変数

| 変数 | 既定値 | 用途 |
|---|---|---|
| `GRAPHWRANGLER_URL` | `http://localhost:8770` | `packages/server` の HTTP API のベースURL |
| `GW_ENGINE_INTERVAL_MS` | `5000` | ポーリング間隔（ミリ秒） |
| `GW_ENGINE_CLAUDE_MODEL` | `sonnet` | `claude -p` に渡す `--model`。**設定(下記)より常に優先**（設定を跨いだ確実な上書き手段） |

## エンジンAI設定（サーバ設定との連動。M7 / 接続方式選択）

起動時と以後10分ごとに `GET /api/settings` を取得し、`engine.mode`（`"cli"` / `"api"`）と
claude executor の CLI パス（`cliPath`）・モデル（`model`）・追加引数（`extraArgs`）に反映する
（`src/index.ts` の `refreshEngineConfig`）。`GW_ENGINE_CLAUDE_MODEL` が設定されていれば、取得した
`settings.engine.model` より常にそちらを優先する（環境変数はデプロイ側の確実な上書き手段として
残す）。設定の取得に失敗した場合は前回値（初回は既定値 `mode="cli"` / `cliPath="claude"` /
`model="sonnet"` / `extraArgs=[]`）のまま継続する。

**接続方式**（`ai` executor ノード実行時に分岐。`src/index.ts` の `executeNode`/`executeRunItem`）:

- `mode="cli"`（既定）: 従来どおり `claude -p` 等のヘッドレスCLIを子プロセス起動する
  （`executors/claude.ts` の `runClaude`）。実行結果の actor は `executor:claude`
- `mode="api"`: サーバの `POST /api/ai/complete`（チャット設定のプロバイダ/APIキーで
  `generateText`、ツールなし）を呼ぶだけの薄い実行者（`executors/api.ts` の `runApi`）。
  プロンプト組み立て（`buildAiPrompt`）は両モード共通で、`claude.ts` のものをそのまま使う。
  モデルは `engine.apiModel`（null ならチャット既定モデル）で、サーバ側
  （`packages/server/src/chat.ts` の `completeText`）が解決する。実行結果の actor は
  `executor:api`。キー未設定・プロバイダエラーは `ApiError` として投げられ、通常の失敗
  リカバリ（`POST /request` の承認カード）にそのまま乗る

`extraArgs` に `--dangerously-skip-permissions` や `--allowedTools` 系のフラグが含まれていても
`executors/claude.ts` の `sanitizeExtraArgs` が取り除く（設定はサーバ管理者が触れる値だが、
下記の安全設計を設定経由で無効化できないようにするための最終防御）。

## やること（1周のループ）

1. `GET /api/state` で全ノードを取得
2. 実行候補を1件選ぶ（`src/pick.ts` の `selectAction`。純粋関数）:
   - `lifecycle=committed` かつ `status=pending` かつ `executor: ai|script` かつ `kind=task`
   - frontier（parents が全て `done`。空配列＝ルートも対象）
   - `impact=irreversible` は直前のスレッドの `decision_answer` が `option=go` のときだけ
     実行を許可（この1回だけ）。それ以外は承認カード（`POST /request`）を開く
   - 失敗リカバリ・承認ゲートいずれの場面でも `option=abort`/`skip` は `status=dropped` にする
3. 実行:
   - **script**: `node.impl={type:"script",command}` を `shell:true` の子プロセスで実行
     （タイムアウト5分）。cwd は data-dir モードではリポジトリ外の `os.tmpdir()`、
     ワークスペースモード（正データファイルのあるディレクトリを開いている場合）では
     ワークスペースルートに切り替わる。`impl` が script でない script
     ノードは「実装がない」として失敗扱い
   - **ai**: `<cliPath> -p <prompt> --model <model> [...extraArgs] --allowedTools Read Grep Glob WebSearch WebFetch`
     を子プロセスで起動（タイムアウト10分。cliPath/model/extraArgs は上記「エンジンAI設定」参照）。
     プロンプトはゴール(group先ノード)の title/detail、親ノードのスレッド末尾の say メッセージ、
     自ノードの title/detail、`impl={type:"doc"}` ならその全文を含む（`src/executors/claude.ts` の
     `buildAiPrompt`。実際に組み込んだ文脈名は `sources: string[]` としても返す）。
     `impl={type:"doc"}` が `text` でなく `path`（ワークスペースモードでのリポジトリ内
     ドキュメント参照）のときは、サーバの `GET /api/files`（ワークスペースルート基準で
     解決・脱出ガード付き）で読んでからプロンプトへインラインする（`text` と `path` が
     両方あれば `text` を優先）
4. 結果の記録: 成功なら `status`+`say` メッセージを投稿して `status=done`。失敗/タイムアウトなら
   `status` メッセージを投稿して `status=waiting` にし、`POST /request` で
   もう一度/内容を変える/中止 の判断カードを開く。ai executor が投稿する `say` メッセージの
   `payload` には `{ sources: string[] }`（ラン実行時はさらに `runId` も）を含める。sources は
   `buildAiPrompt` が返した「プロンプトに実際に含めた文脈名」（例:
   `["ゴール文脈", "親ノードの成果", "手順書"]`）で、UI側の出典バッジ表示に使う想定
   （docs/design.md 3.8）

## 安全設計

- **`--dangerously-skip-permissions` は絶対に使わない**（間接プロンプトインジェクション対策。
  zinsei の同種運用と同じ理由）。`ai` executor に許可するツールは読み取り・調査系のみ
  （`Read Grep Glob WebSearch WebFetch`）
- **`impact=irreversible` は無条件に実行しない**。承認カードで人間が `go` を選んだ、その1回の
  実行だけを許可する。次に同じノードを実行しようとするとき（例: 実行が失敗して再度
  リトライされたとき）は最新の回答が `go` ではなくなっているため、改めて承認を求め直す
  （「不可逆は毎回確認する」という安全側の設計）
- ネットワークI/Oを伴わない判断ロジック（`src/pick.ts`）は全て純粋関数に切り出し、vitest で
  ユニットテストしている（`test/pick.test.ts`）

## 帰属（actor/via）

すべての書き込みは `via: "engine"`。ノードの claim/patch/承認カード発行の actor は
`{kind:"agent", name:"engine"}`、実行結果のメッセージ投稿の actor は実行した executor に応じて
`{kind:"agent", name:"executor:script"}` または `{kind:"agent", name:"executor:claude"}`。

## 既知の妥協点

- 1並列のみ（同時に処理するノードは常に1件）。並列化・同一ゴール直列化などは M6 以降のスコープ
- `claude -p` の失敗理由は、CLI の実装都合でエラー文言が stdout/stderr のどちらに出るか一定し
  ないため（実機確認で判明: 認証エラーは stdout、stdin待ちの警告は stderr）、両方を連結して
  人間向けの理由文にしている
- Windows では `claude` が `.cmd` シムのため `spawn` に `shell:true` を付けている
  （POSIX 側は argv をそのまま渡すため付けない）
- Windows では子プロセスの標準出力/標準エラーをまず UTF-8 で厳密デコードし、失敗したら
  Shift_JIS にフォールバックして読む（2026-07-31、日本語を含む出力が文字化けする問題への対策）

## 手順ページ（ラン）対応（M6後半）

`docs/design.md` 3.7/3.8 の「手順ページ」実装。既存のプロジェクト側ループ（上記）を毎tick
1件のまま拡張し、プロジェクトのタスクに候補が無かった周だけラン側のワークアイテムを1件処理する
（候補: プロジェクト優先→ラン。`src/index.ts` の `tick()`）。

### ワークアイテム実行（`src/pickRun.ts` / `tick()` の `tickRunItem`）

- 対象: `status=running` のラン × アイテム `status=pending` × テンプレート `executor` が
  `ai|script` × **ラン内依存**（テンプレートの `parents` のうち、そのランの `items` に存在する
  もの＝同じ手順のメンバーだけ）が全て `done`/`skipped`。手順の外のノードを親に持っていても
  ランの実行判定には関係しない
- 選択順序: ラン `created` 昇順（古いランを先に）→ ラン内はテンプレート `created` 昇順。
  候補選択ロジックは `src/pickRun.ts` の `selectRunAction`（ネットワークI/Oなし・純粋関数・
  `test/pickRun.test.ts` でユニットテスト）
- `impact=irreversible` のテンプレートは実行せず、items patch で
  `{status:"waiting", note:"承認待ち"}` にする（承認カード連携は下記「不可逆ランアイテムの
  承認連携」参照）
- 実行: claim は `POST /api/runs/:id/items/:nodeId` で `{status:"running"}`。executor は
  プロジェクト側と同じ `runScript` / `runClaude` をそのまま使う。`ai` executor のプロンプトは
  `claude.ts` の `buildAiPrompt` を「手順ノード(procedure) = goal」として再利用し、手順ノードの
  title/detail → テンプレートの title/detail → `impl={type:"doc"}` ならその全文、の順で渡す
  （プロジェクト側と違い親ノードのスレッド文脈は渡さない）
- 結果はテンプレートノードのスレッドへ `payload:{runId}` 付きで記録する
  （成功: `status`要約 + `say`成果 → items patch `done`。失敗: `status` → items patch
  `{status:"waiting", note:"失敗: <理由の短縮>"}`）。server 側の
  `POST /api/runs/:id/items/:nodeId` はアイテム更新のたびに `[ラン <id>] <title>: <from> → <to>`
  という遷移ログも自動でスレッドに積むため、上記の要約メッセージと合わせて2種類のログが並ぶ
- 全ランを横断する一覧APIは無いため、`kind=procedure` の全ノードについて
  `GET /api/procedures/:id/runs` を束ねて `status=running` のものを集める
  （`src/index.ts` の `fetchRunningRuns`）

### 不可逆ランアイテムの承認連携（`src/approval.ts`）

`pick.ts`（プロジェクト側）と同じ発想の承認ゲートを、ラン（手順ページ）のワークアイテムにも
接続する。テンプレートノードの `pendingRequest`/`status` が承認カードの発行/解消の副作用で
動く（`waiting`→回答で`pending`に戻る）が、**テンプレート自身は status を持たない思想**なので
この副作用は無視してよい（UIはテンプレートの status を表示しない）。

- 初回発見時（`tickRunItem` の `waiting-irreversible`）: items patch
  `{status:"waiting", note:"承認待ち"}` にするだけ（この時点ではカードを開かない）
- 次tick以降（`tickRunApprovals`）: `status=waiting` かつ `note="承認待ち"` のアイテムを
  `collectPendingApprovalItems` で集め、テンプレートノードのスレッドを見て承認ゲートの状態を
  `findRunGate` で判定する。判断リクエストの `payload` は呼び出し側が指定できないため、
  question 文中に `[ラン <runId>]` というマーカーを埋め込んでランと紐付ける
  （`buildRunApprovalRequest` / `runGateMarker`。テンプレートノードは複数のランに同時に
  登場しうるため、ノードidだけでは束ねられない）
  - ゲートが未発行 → `POST /request` で `go`(実行して)/`skip`(このランでは飛ばす) の2択
    （`impact=irreversible`）を開く
  - ゲートが発行済み・未回答 → 何もしない（**二重にカードを開かない**）
  - 回答が `go` → その1回だけ実行（`executeRunItem`。実行後は item.status が
    waiting/承認待ち から外れるため再実行されない）
  - 回答が `skip` → items patch `{status:"skipped", note:"承認で見送り"}`
- 判定本体（`selectRunApprovalAction`）はネットワークI/Oを持たない純粋関数
  （`test/approval.test.ts` でユニットテスト。gateStates は呼び出し側が
  `${runId}:${nodeId}` キーで渡す）

### トリガーノード（`kind=trigger`）による発火とラン自動生成（`src/trigger.ts` / `triggerTick`）

2026-07-31、「ルーティーンであること」を **ページ種別（`kind=procedure`）の宣言」から
「フロー先頭のトリガーノード（`kind=trigger`）から導出する」モデルへ移行した**
（docs/design.md 3.4/3.8/3.9）。旧 `scheduleTick`（`procedure.schedule` ベース）は
`triggerTick`（`src/index.ts`）に置き換わった。Rx の思想を借りる: トリガー = Observable の
ソース、ラン = イベントの伝搬。起動方式は `executor` 軸で一貫させる:

- **script トリガー**（cron的な定期実行）: `node.schedule` を `src/schedule.ts` の
  `parseSchedule`/`shouldCreateScheduledRun`（旧 procedure 判定と全く同じロジック。
  `src/trigger.ts` の `shouldFireScriptTrigger` が薄くラップして流用する）で判定し、
  発火条件を満たせば `POST /api/nodes/:id/fire` を呼ぶ。書式は `every <N>m/h/d` /
  `daily <HH:MM>` / `weekly <曜日> <HH:MM>` の3つ（詳細は下記「補足: schedule書式」）
- **ai トリガー**: `node.schedule` を「AIに発火要否を判定させる間隔」として使う
  （`resolveAiCheckIntervalMs`。`every` 系のみ解釈、無指定/未対応書式は既定1時間）。
  間隔経過かつそのページに実行中ランが無いとき（`shouldEvaluateAiTrigger` で重複防止も
  兼ねる）、`buildTriggerPrompt`（title/detail/`impl={type:"doc"}`の全文+現在時刻）を
  `claude -p`（または `engine.mode="api"` なら `/api/ai/complete`）に渡し、出力を
  `parseAiFireDecision` で `fire`/`skip` として解釈する。`fire` ならスレッドへ理由を
  `say` した上で発火、`skip` はエンジンログのみ（スレッドは汚さない）。チェック時刻は
  エンジンのメモリ内 `Map`（`aiTriggerLastCheckedAt`）で管理し、プロセス再起動で
  即再チェックされるのは許容する
- **human トリガー**: エンジンは何もしない（`POST /api/nodes/:id/fire` の手動発火のみ）

**発火**（`fireTriggerNode` → `POST /api/nodes/:id/fire`）すると、サーバ側がそのトリガーの
`group`（所属ページ）で `RunStore.createFromTrigger` を呼び、トリガーの**子孫**
（`parents` を辿って到達可能なメンバー。分岐・合流を含む。トリガー自身は含まない）を
ワークアイテムとするランを1本作る。**Fix/committed はランの参加条件ではない**——`lifecycle`
を問わず子孫であれば items に入る（draft は `status=pending` のまま入る）。ただし
**自動実行の対象は `lifecycle=committed` のみ**という3.4の原則は engine 側
（`pickRun.ts`/`decisionRun.ts` の `lifecycle !== "committed"` 除外）で維持する。

- **重複防止**: script は `hasRunningRun`、ai は `shouldEvaluateAiTrigger` の
  `hasRunningRun` 引数で、そのページに `status=running` のランが既にあれば何もしない
  （積み残し防止）
- 生成したランの `trigger` は `trigger:<triggerノードid>:<via>`（`via` は `manual` /
  `schedule:<原文>` / `ai`）
- 二重実行防止: トリガーノードを持つページ（新モデルのルーティーンページ）のメンバーは、
  旧来の `kind=procedure` メンバーと同じくプロジェクト側エンジン（`pick.ts`/`decision.ts`）
  からも除外される（`pick.ts` の `triggerPageIds`/`isRunManagedMember` で判定。2026-07-29に
  `kind=procedure` で実際に起きた二重実行の穴を新モデルでも塞ぐ）
- パース・判定はいずれもネットワークI/Oを持たない純粋関数（`test/trigger.test.ts` /
  `test/schedule.test.ts` でユニットテスト）

#### 補足: schedule書式（`src/schedule.ts` の `parseSchedule` が正）

- `every <N>m` / `every <N>h` / `every <N>d` — 最新ランの `created` から N 経過していたら
  新ラン（最新ランが無ければ即座に生成。cron の初回即時実行と同じ発想）
- `daily <HH:MM>` — ローカル時刻でその時刻を過ぎていて、最新ランがローカル暦で「今日」の
  ものでなければ新ラン（trigger を問わず「今日の分」が1本あれば足りる、という判定）
- `weekly <mon|tue|wed|thu|fri|sat|sun> <HH:MM>` — 対象曜日で、かつローカル時刻でその
  時刻を過ぎていない間は生成しない（dailyと同じ理由。無ければ即座に生成、にはしない）。
  それ以外は直近の対象曜日・時刻（必ず現在時刻以前になるよう計算）を求め、最新ランがそれより
  前なら新ラン（trigger を問わず「今週の分」が1本あれば足りる、という判定）
- それ以外の書式は**無視して警告ログ**を出すだけ（script は「未対応のschedule書式のため無視」、
  ai は既定のチェック間隔=1時間にフォールバック）

#### 後方互換: `kind=procedure`（非推奨）

`kind=procedure` は enum に残っており、`GET/POST /api/procedures/:id/runs` も互換
エイリアスとして動く。ページにトリガーノードが無い場合に限り、旧来どおり
`kind=procedure` のノードとして扱われる（`RunStore.create` が committed のみを items に
入れる旧仕様のまま）。新規に作るページはトリガーノードを使うこと。

### E2E確認の実績（2026-07-29）

自分専用サーバ（`GRAPHWRANGLER_PORT=8777`）で手動確認済み:
手順ノード + script実装のテンプレート2個（直列依存）+ human実装1個 → 手動でラン作成 →
エンジン起動 → 依存順（A→B）で2個が `done` になり、human のテンプレートは `pending` のまま
残る → `GET /api/runs/:id/trace` で claim/成功/成果/遷移ログが `payload.runId` 付きで
時系列に並ぶことを確認。スケジュールは `every 1m` を設定した手順ノードで確認し、
「最新ランが無ければ即座に生成」の分岐どおり設定直後にラン（`trigger:"schedule:every 1m"`）が
自動生成されることを確認した（次tickでは実行中ランがあるため重複生成されないことも確認）。
1分待って2周目の間隔判定まで確認するのは行っていない（`every` の間隔判定自体は
`test/schedule.test.ts` でユニットテスト済み）。
