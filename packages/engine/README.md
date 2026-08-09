# @graphwrangler/engine

GraphWrangler の常駐実行エンジン。HTTP API（`packages/server`）をポーリングし、
実行可能なノード（`executor: ai | script`）・トリガーの発火・ランのワークアイテムを
自動で処理する。設計の正は `docs/design.md`（3.4/3.5/3.8/3.9/3.12/3.14/3.15）。

このパッケージは `packages/mcp` と同じ方針で **`packages/server` の実装には依存しない
自己完結パッケージ**。統合点は HTTP API のみ。`packages/core` に対しては型のみの
workspace 依存を持つ（`src/types.ts` が型を re-export するだけで、core の実装
（GraphStore 等）はランタイムに import しない）。

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
| `GW_ENGINE_CLAUDE_MODEL` | `opus` | `claude -p` に渡す `--model`。**設定(下記)より常に優先**（デプロイ側の確実な上書き手段） |

## エンジンAI設定（サーバ設定との連動）

起動時と以後10分ごとに `GET /api/settings` を取得し、`engine.mode`（`"cli"` / `"api"`）と
claude executor の CLI パス（`cliPath`）・モデル（`model`）・思考の深さ（`effort`）・
追加引数（`extraArgs`）・追加許可ツール（`cliExtraTools`）・追加作業ディレクトリ
（`ai.addDirs`。三役共通、`--add-dir` に渡す）に反映する（`src/index.ts` の
`refreshEngineConfig`）。取得に失敗した場合は前回値（初回は既定値 `mode="cli"` /
`cliPath="claude"` / `model="opus"` / `effort=null` / `extraArgs=[]` / `extraTools=[]` /
`addDirs=[]`）のまま継続する。`ai` セクションは2026-08-04追加のため、旧サーバ相手では
`addDirs=[]` のまま継続する。

モデル/エフォートの優先順位は **ノードの `aiModel`/`aiEffort`（2026-08-07 追加） >
env `GW_ENGINE_CLAUDE_MODEL` > サーバ設定 `engine.model`/`engine.effort` > 既定値
（`opus`/null）** の順（`src/index.ts` の `configFor`）。`GW_ENGINE_CLAUDE_MODEL` は
サーバ設定より常に優先（デプロイ側の確実な上書き手段）だが、ノード側で明示的に
モデルを指定した場合はそちらが最優先になる。

**接続方式**（`ai` executor ノード実行時に分岐）:

- `mode="cli"`（既定）: `claude -p` 等のヘッドレスCLIを子プロセス起動する
  （`executors/claude.ts` の `runClaude`）。実行結果の actor は `executor:claude`
- `mode="api"`: サーバの `POST /api/ai/complete`（チャット設定のプロバイダ/APIキーで
  `generateText`、ツールなし）を呼ぶ薄い実行者（`executors/api.ts` の `runApi`）。
  プロンプト組み立て（`buildAiPrompt`）は両モード共通。モデルは `engine.apiModel`
  （null ならチャット既定モデル）。実行結果の actor は `executor:api`

`extraArgs` に `--dangerously-skip-permissions` や `--allowedTools`/`--allowed-tools` 系の
フラグが含まれていても `executors/claude.ts` の `sanitizeExtraArgs` が取り除く（安全設計を
設定経由で無効化できないようにするための最終防御）。`cliExtraTools`/`ai.addDirs` は
`-` 始まりの要素（フラグ混入経路）を `sanitizeExtraTools`/`sanitizeAddDirs` で落とす。

## ワークスペースモード

起動時と、未取得の間は毎tick・取得後は10分ごとに `GET /api/workspace` を取得し
（`refreshWorkspaceInfo`）、サーバの動作モード（`workspace` = リポジトリのルートに
1ファイル方式 / `datadir`）を追随する。`workspace` モードでは script/ai executor の
cwd をワークスペースルートにし（AI の Read/Grep/Glob がリポジトリ内資料を素で読める
ようにする）、`impl={type:"doc",path}` は本文が無ければ `GET /api/files` で読んで
プロンプトへインラインする。`datadir` モード相当では cwd はエンジンプロセスの既定
（script executor は `os.tmpdir()`）のまま。取得失敗時は `datadir` モード相当で継続する。

## やること（1周のループ。`src/index.ts` の `tick()`）

1. `GET /api/state` で全ノードを取得
2. **トリガー発火判定**（`triggerTick`）: `kind=trigger` かつ `lifecycle=committed` で、
   **所属ページ（group）が終いになっていない**（`isClosedPage` = status が done/dropped
   でない。2026-08-09）ノードを executor 軸で処理する。完了・中止にしたルーティーンは
   発火が止まり、アーカイブから戻せばまた回り出す
   - **script** = cron的な定期実行。`node.schedule`（`every Nm/Nh/Nd` / `daily HH:MM` /
     `weekly dow HH:MM`）を `src/schedule.ts` で判定し、条件を満たせば
     `POST /api/nodes/:id/fire` で発火する。未対応の書式は無視して警告ログのみ
   - **ai** = `schedule` を「AIに発火要否を判定させる間隔」として使う（`every` 系のみ解釈、
     無指定は既定1時間）。間隔が経過したら `buildTriggerPrompt` を AI に渡し、
     出力を `fire`/`skip` として解釈する。`fire` ならスレッドへ理由を残して発火、
     `skip` はエンジンログのみ。チェック時刻はエンジンのメモリ管理
   - **human** = エンジンは何もしない（手動 `/fire` のみ）
   - 重複防止は最新ランの時刻で行う（every=経過時間 / daily=同じ暦日か /
     weekly=直近の対象時刻より後か)。**実行中ランの有無は見ない**（2026-08-08 に
     「実行中ランがあれば発火しない」を撤廃。人間の回答待ちで止まっているランがあると
     定刻のルーティーンが永久に沈黙していたため。design.md 3.8）
   - **発火前承認**: `approval=true`（発火前承認）のトリガーは発火の代わりに go/skip の承認カードを
     トリガーのスレッドへ開き、go 回答の1回だけ発火する（発火すると回答は消費され、次の
     周期では改めて確認する）。skip はその回の発火とみなして次の周期まで黙る。
     手動 `/fire` はゲートを通らない（`src/trigger.ts` の `buildFireApprovalRequest` /
     `findFireGate` / `fireBaseline` / `hasUnconsumedGo`）
3. **プロジェクト側の実行候補を1件選ぶ**（`src/pick.ts` の `selectAction`。純粋関数）:
   - `lifecycle=committed` / `status=pending` / `executor: ai|script` / `kind=task` /
     frontier（parents が全て done|skipped）
   - トリガーを持つページ（ルーティーンページ）のメンバーは対象外（ラン側が実行を担う。
     二重実行防止）
   - `approval=true` は直前のスレッドの `decision_answer` が `option=go` のときだけ
     実行を許可（この1回だけ）。それ以外は承認カード（`POST /request`）を開く
   - `option=abort`/`skip` の回答は `status=dropped` にする
   - `option=modify`（内容を変える）の回答は **`lifecycle=draft` に戻して人間の編集を待つ**
     （即再実行しない。編集後「プラン済みにする」で再び実行対象になる。demote 後に
     status メッセージを積むことで回答を消費し、再コミット時の demote ループを防ぐ）
4. 実行:
   - **script**: `impl={type:"script",command}` のパラメータを `substituteParams` で置換して
     `shell:true` の子プロセスで実行（タイムアウト5分）。cwd は data-dir モードでは
     `os.tmpdir()`、ワークスペースモードではワークスペースルート
   - **ai**: プロンプト（ゴール文脈 + 親ノードの成果 + スレッドの経緯 + 自ノードの
     title/detail + `impl={type:"doc"}` の全文）を組み立てて実行（タイムアウト30分。
     `executors/claude.ts` の `CLAUDE_TIMEOUT_MS`）。`impl.path` のみのときはサーバの
     `GET /api/files` で読んでインラインする。実際に含めた文脈名は `sources` として
     `say` メッセージの payload に載る（UIの出典バッジ用）。`claude -p` は
     `--output-format stream-json --verbose` で起動し、呼ばれたツール（Bash/Edit/Read…）を
     `subSteps`（実行の内訳。下記）として復元する
5. 結果の記録: 成功なら `status`+`say` を投稿して `status=done`。失敗/タイムアウトなら
   `status` を投稿し、`POST /request` で もう一度/内容を変える/中止 の判断カードを開く
   （pendingRequest がセットされ人間待ちになる。「あなたの番（waiting）」は保存値ではなく
   pendingRequest からの導出。回答が来ると server が pendingRequest を解いて status を
   pending に戻す）。AI が `QUESTION:` 形式で出力した場合は done にせず判断リクエストを
   開く（下記「AI質問（QUESTIONプロトコル）」）
6. プロジェクト側に候補が無ければ、**分岐ノード**（`src/decision.ts`）→
   **ランのワークアイテム**（下記）の順で1件処理する

## ラン（ルーティーンページ）の処理

- **ワークアイテム実行**（`src/pickRun.ts` / `tickRunItem`）: `status=running` のラン ×
  アイテム `status=pending` × テンプレート `kind=task` / `executor: ai|script` /
  `lifecycle=committed` × **ラン内依存**（テンプレートの parents のうち同じランの items に
  存在するもの）が全て done/skipped。ラン created 昇順 → ラン内はテンプレート created 昇順。
  結果はテンプレートノードのスレッドへ `payload:{runId}` 付きで記録する。
  実行失敗は `{status:"waiting", note:"失敗: <理由>"}` に倒す——エンジンは waiting を
  拾わないため、リトライ/見送りは UI（ノードパネルの「もう一度 / このランでは飛ばす」）が担う
- **不可逆アイテムの承認連携**（`src/approval.ts`）: `approval=true` のアイテムは
  実行せず `{status:"waiting", note:"承認待ち"}` にし、次tick以降にテンプレートノードへ
  `go`(実行して)/`skip`(このランでは飛ばす) の承認カードを開く。判断リクエストの question
  文中に `[ラン <runId>]` マーカーを埋め込んでランと紐付ける（同じテンプレートが複数の
  ランに同時に登場しうるため）。二重にカードは開かない
- **分岐アイテム**（`src/decisionRun.ts`）: テンプレートが `kind=decision` のアイテム。
  script/ai は実行して出力を枝idとして解釈、human は `{status:"waiting", note:"分岐待ち"}`
  に倒してから承認連携と同じ2段構えで判断リクエストを往復する
- **あなたの番（human executor）**（2026-08-08）: テンプレート `executor=human` のアイテムに
  順番が回ってきたら、実行はせず `{status:"waiting", note:"あなたの番"}` に上げるだけ
  （`pickRun.ts` の `selectRunAction` が返す `human-turn`）。これがサーバの「あなたの番」
  Discord通知とUIの橙ドットの発生源になる。着手/完了は人間が押す
- **AI質問（QUESTIONプロトコル）の往復**（`tickRunAiQuestions`）: ラン層でも `AI質問待ち`
  アイテムを扱う。カード未発行ならスレッドの `say` payload から質問を復元して開き直し、
  `abort` 回答は `{status:"dropped"}`、それ以外の回答は再実行（下記「AI質問」参照）

## AI質問（QUESTIONプロトコル）と autonomy

`ai` executor の実行結果が `QUESTION: <質問文>`（1行目。続けて `OPTION: <選択肢>` を
最大3個まで）の形なら、`ask.ts` の `parseAiQuestion` がこれを人間への質問と判定する。
`status=done` にはせず、AI提示の選択肢（id `ai:1..`。無ければ「おまかせで続行」）+
「中止」(`abort`) の判断カードを開く。回答（`abort` 以外）は次回実行時に
`buildThreadContextLines` でスレッド経緯としてプロンプトへ差し込まれ、AIがそれを踏まえて
再実行する。プロジェクト層は `status=pending` のまま次tickの再選択を待つ、ラン層は
`{status:"waiting", note:"AI質問待ち"}` に倒してから往復する。

- ノードの `autonomy`（`normal`/`low`/`high`）がプロンプトの指示を変える: `normal`=規約あり・
  最終手段、`low`=規約あり・迷ったら質問へ倒す、`high`=規約を出さず「聞かずに進め」
- `autonomy=high` の実行失敗は人間に渡す前に自動で最大 `MAX_AUTO_RETRIES`（2）回まで
  試し直す（失敗理由を `status` に積んでから `pending`/`waiting` に戻すことで、次回実行が
  経緯として読み込む）。`approval`（実行前承認ゲート）は `autonomy` に関わらず残る
  （安全装置はノード属性で無効化しない）

## 実行の内訳（subSteps。docs/design.md 3.14「実行の内訳（ノード内ノード）」）

AI executor の実行が内部で何をしたか（読んだ・書いた・叩いたコマンド）を見えるようにする
ため、`claude -p` を `--output-format stream-json --verbose` で起動し、標準出力に流れる
`tool_use`/`tool_result` イベントを `executors/stream_trace.ts` の `parseStreamJsonOutput`
で `SubStep`（`{id,index,tool,title,command,input,output,status}`）列へ復元する。成功時の
`output` は従来どおり `result` 行の最終テキストのみ（stream-json 化で stdout は増えるが、
成否判定・タイムアウト時の部分回収には影響しない——中断でも tool_use はあるが
tool_result が来ていない SubStep は `status:"error"` として拾う）。`subSteps` は
`status`（実行成功/失敗/自律リトライ）メッセージの `payload.subSteps` として乗るだけで、
専用のストレージは増やさない（`withSubSteps`）。分岐ノード・ai トリガー判定の実行結果にも
同じ形で付く。

## ランのコンテキスト（docs/design.md 3.15。attribute flow）

ラン層の実行（`executeRunItem`/`executeRunDecisionItem`）では、発火時の初期値+以後の書き足しが
乗った `run.context`（`Record<string,string>`）を実行に渡す。プロジェクト層（ランが無い実行）
には渡さない。

- **読み**: script executor は `impl.command` 中の `{name}` プレースホルダを
  `params.ts` の `substituteParams` で解決する（解決順: ① `run.context[name]` →
  ② `impl.params[].value`（デフォルト値に降格）→ ③ 未入力エラー）。加えて環境変数
  `GW_RUN_ID` / `GW_CONTEXT`（context全体のJSON）/ `GW_RUN_DIR`（後述）/
  `GW_PARAM_<NAME>`（解決済みの各値。名前は大文字化し英数以外を `_` に）を渡す
  （`context.ts` の `buildContextEnv`）。ai executor はプロンプトへ「ランのコンテキスト」
  ブロックとして注入する（`sources` にも同名で載る。値が空でもエラーにしない——
  QUESTIONプロトコルで人間に聞ける）
- **インジェクションガード**: `run.context` 由来の値がシェルのメタ文字
  （`` ` `` `$` `\` `"` `'` `;` `|` `&` `<` `>` `(` `)` `{` `}` 改行）を含む場合は
  置換せず実行失敗にする（エラー文言で `GW_PARAM_*` 環境変数の使用へ誘導する。
  環境変数はシェル展開を通らないため安全）。テンプレートのデフォルト値（人間が UI で
  入力）はこのガードの対象外（引用符エスケープのみ）
- **実行済み値の記録**: script 実行直前に、実際に使った解決済みの値を
  `RunItem.resolvedParams` へ焼く（`patchRunItem`）。ランページの引数欄はこれを
  読み取り専用で表示し、現在の `run.context` とずれたら「古い値で実行済み」バッジを出す
  （自動再実行はしない）
- **書き**（実行時。ラン層のみ有効）: script の stdout / AI の出力の中の
  `##gw {"set":{"キー":"値"}}` 形式の行（1行1個）を `context.ts` の `extractGwMarkers`
  が抽出し、本文（say）から取り除いたうえで `POST /api/runs/:id/context`（`patchRunContext`）
  で `run.context` へ merge する（同一ラン内は last-write-wins）。プロジェクト層の実行で
  マーカーが出ても無視し、その旨を `status` に残すだけ。`##gw {` で始まるのに JSON として
  解釈できない行は `invalidLines` として `status` に記録する（実行自体は成功扱いのまま）
- **出力宣言（outputs）**: ノードの `outputs:[{name,label?,example?}]` は「このランへ
  このキーを出力する」宣言。ai executor はこの宣言があるとプロンプトへ `##gw` 出力指示を
  追加する。トリガーの `outputs` は発火フォーム項目/検知スクリプトの emit 契約になる
  （AIトリガーは判定出力の `##gw` マーカーを発火時の `context` として渡す）
- **ラン作業ディレクトリ**（`ensureRunDir`）: ワークスペースモードでのみ
  `<workspaceRoot>/.graphwrangler/runfiles/<runId>` を実行前に作成し `GW_RUN_DIR` として渡す
  （成果物はファイル、context にはパスを載せる設計。3.15）。data-dir モード/作成失敗時は
  `GW_RUN_DIR` を渡さない
- MCP の `run_context_set`（外部からの書き込み口）・トリガー発火時の初期 `context`
  （手動▶フォーム/`trigger_fire`/検知スクリプトの emit）についてはこのパッケージの
  責務外（`packages/server`/`packages/mcp` 側）だが、同じ `run.context` を介して合流する

## 安全設計

- **`--dangerously-skip-permissions` は絶対に使わない**（間接プロンプトインジェクション対策）。
  `ai` executor に許可するツールは `executors/claude.ts` の `ALLOWED_TOOLS`
  （`Read Grep Glob Write Edit NotebookEdit Bash Task TodoWrite WebSearch WebFetch`。
  2026-08-03 に「読み取り+書き込みのみ」の縛りを撤廃し Bash 等を含むフルセットへ変更した。
  危険操作の歯止めはツールの出し渋りではなく、ノード側の実行前承認（`approval`）・
  自律度（`autonomy` の QUESTIONプロトコル）・試走（`--dry-run`）で担保する方針）。
  設定 `engine.cliExtraTools` でさらにツールを足せる（例: `mcp__foo__*`）
- `extraArgs`/`cliExtraTools` は `--dangerously-skip-permissions`・`--allowedTools` 系・
  `-` 始まりの要素を無条件に取り除く（設定経由でも安全装置を無効化できないための最終防御。
  上記「エンジンAI設定」参照）
- **`approval=true`（実行前承認）は無条件に実行しない**。承認カードで人間が `go` を選んだ、その1回の
  実行だけを許可する。再実行時は改めて承認を求め直す（「不可逆は毎回確認する」）。
  トリガーの `approval=true`（発火前承認）も同型
- ネットワークI/Oを伴わない判断ロジック（pick / pickRun / approval / decision / decisionRun /
  schedule / trigger / context / params / ask）は全て純粋関数に切り出し、vitest でユニットテストしている

## 帰属（actor/via）

すべての書き込みは `via: "engine"`。ノードの claim/patch/承認カード発行の actor は
`{kind:"agent", name:"engine"}`、実行結果のメッセージ投稿の actor は実行した executor に応じて
`{kind:"agent", name:"executor:script"}` / `executor:claude` / `executor:api`。

## 自動アップデート追随（docs/design.md 3.12。heartbeatでのサーバ版数検知）

毎tick `POST /api/engine/heartbeat`（UIの稼働インジケータ用。失敗は握りつぶして実行は続ける）
を呼び、応答に載るサーバ側アプリの版（HEAD sha。`packages/server/src/selfupdate.ts`）を
`noteServerVersion` で追跡する。前回見た版と異なれば「サーバが自動アップデートで
入れ替わった」とみなし、エンジンも降りて新しいコードで上がり直す（自分から再起動はしない）。

- 降りるのは **プロセス管理下（`supervised()`。env `INVOCATION_ID`（systemd）または
  `pm_id`（pm2）がある）のときだけ**。監視の無い環境（手元で `pnpm start` しただけ）では
  ログを出すのみで終了しない（自動更新がエンジンを落としたまま戻らない事故を作らないため）
- 終了コードは 0 ではなく **75**（EX_TEMPFAIL）。systemd/pm2 の unit が `Restart=on-failure`
  想定のため、正常終了だと上げ直してもらえない（`selfupdate.ts` の `RESTART_EXIT_CODE` と同値）
- 版の追跡はエンジンのメモリ管理（プロセス再起動で最初の heartbeat 応答を新しい基準として
  再スタートする）

## 既知の妥協点

- 1並列のみ（同時に処理するノードは常に1件）
- `claude -p` の失敗理由は、CLI の実装都合でエラー文言が stdout/stderr のどちらに出るか
  一定しないため、両方を連結して人間向けの理由文にしている（stream-json が最後まで通っていれば
  `result.result` を優先する）
- Windows では `claude` が `.cmd` シムのため `spawn` に `shell:true` を付けている。
  プロンプトは stdin 渡し（cmd.exe が改行を含む引数を切り捨てるため）
- Windows では子プロセスの出力をまず UTF-8 で厳密デコードし、失敗したら Shift_JIS に
  フォールバックして読む（日本語出力の文字化け対策）
