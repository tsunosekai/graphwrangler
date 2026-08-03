# @graphwrangler/engine

GraphWrangler の常駐実行エンジン。HTTP API（`packages/server`）をポーリングし、
実行可能なノード（`executor: ai | script`）・トリガーの発火・ランのワークアイテムを
自動で処理する。設計の正は `docs/design.md`（3.4/3.5/3.8/3.9）。

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
claude executor の CLI パス（`cliPath`）・モデル（`model`）・追加引数（`extraArgs`）に反映する
（`src/index.ts` の `refreshEngineConfig`）。取得に失敗した場合は前回値
（初回は既定値 `mode="cli"` / `cliPath="claude"` / `model="opus"` / `extraArgs=[]`）のまま継続する。

**接続方式**（`ai` executor ノード実行時に分岐）:

- `mode="cli"`（既定）: `claude -p` 等のヘッドレスCLIを子プロセス起動する
  （`executors/claude.ts` の `runClaude`）。実行結果の actor は `executor:claude`
- `mode="api"`: サーバの `POST /api/ai/complete`（チャット設定のプロバイダ/APIキーで
  `generateText`、ツールなし）を呼ぶ薄い実行者（`executors/api.ts` の `runApi`）。
  プロンプト組み立て（`buildAiPrompt`）は両モード共通。モデルは `engine.apiModel`
  （null ならチャット既定モデル）。実行結果の actor は `executor:api`

`extraArgs` に `--dangerously-skip-permissions` や `--allowedTools` 系のフラグが含まれていても
`executors/claude.ts` の `sanitizeExtraArgs` が取り除く（安全設計を設定経由で無効化できない
ようにするための最終防御）。

## やること（1周のループ。`src/index.ts` の `tick()`）

1. `GET /api/state` で全ノードを取得
2. **トリガー発火判定**（`triggerTick`）: `kind=trigger` かつ `lifecycle=committed` のノードを
   executor 軸で処理する
   - **script** = cron的な定期実行。`node.schedule`（`every Nm/Nh/Nd` / `daily HH:MM` /
     `weekly dow HH:MM`）を `src/schedule.ts` で判定し、条件を満たせば
     `POST /api/nodes/:id/fire` で発火する。未対応の書式は無視して警告ログのみ
   - **ai** = `schedule` を「AIに発火要否を判定させる間隔」として使う（`every` 系のみ解釈、
     無指定は既定1時間）。間隔経過かつ実行中ランなしのとき `buildTriggerPrompt` を AI に渡し、
     出力を `fire`/`skip` として解釈する。`fire` ならスレッドへ理由を残して発火、
     `skip` はエンジンログのみ。チェック時刻はエンジンのメモリ管理
   - **human** = エンジンは何もしない（手動 `/fire` のみ）
   - 重複防止: そのページに `status=running` のランが既にあれば発火しない
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
   - **ai**: プロンプト（ゴール文脈 + 親ノードの成果 + 自ノードの title/detail +
     `impl={type:"doc"}` の全文）を組み立てて実行（タイムアウト10分）。`impl.path` のみの
     ときはサーバの `GET /api/files` で読んでインラインする。実際に含めた文脈名は
     `sources` として `say` メッセージの payload に載る（UIの出典バッジ用）
5. 結果の記録: 成功なら `status`+`say` を投稿して `status=done`。失敗/タイムアウトなら
   `status` を投稿し、`POST /request` で もう一度/内容を変える/中止 の判断カードを開く
   （pendingRequest がセットされ人間待ちになる。「あなたの番（waiting）」は保存値ではなく
   pendingRequest からの導出。回答が来ると server が pendingRequest を解いて status を
   pending に戻す）
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

## 安全設計

- **`--dangerously-skip-permissions` は絶対に使わない**（間接プロンプトインジェクション対策）。
  `ai` executor に許可するツールは `Read Grep Glob Write Edit WebSearch WebFetch`
  （Bash は許可しない——コマンド実行は試走ボタンと script executor の管轄）
- **`approval=true`（実行前承認）は無条件に実行しない**。承認カードで人間が `go` を選んだ、その1回の
  実行だけを許可する。再実行時は改めて承認を求め直す（「不可逆は毎回確認する」）
- ネットワークI/Oを伴わない判断ロジック（pick / pickRun / approval / decision / decisionRun /
  schedule / trigger）は全て純粋関数に切り出し、vitest でユニットテストしている

## 帰属（actor/via）

すべての書き込みは `via: "engine"`。ノードの claim/patch/承認カード発行の actor は
`{kind:"agent", name:"engine"}`、実行結果のメッセージ投稿の actor は実行した executor に応じて
`{kind:"agent", name:"executor:script"}` / `executor:claude` / `executor:api`。

## 既知の妥協点

- 1並列のみ（同時に処理するノードは常に1件）
- `claude -p` の失敗理由は、CLI の実装都合でエラー文言が stdout/stderr のどちらに出るか
  一定しないため、両方を連結して人間向けの理由文にしている
- Windows では `claude` が `.cmd` シムのため `spawn` に `shell:true` を付けている。
  プロンプトは stdin 渡し（cmd.exe が改行を含む引数を切り捨てるため）
- Windows では子プロセスの出力をまず UTF-8 で厳密デコードし、失敗したら Shift_JIS に
  フォールバックして読む（日本語出力の文字化け対策）
