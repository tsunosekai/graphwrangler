# @graphwrangler/engine

GraphWrangler の常駐実行エンジン（M5、M6後半で手順ページ=ラン対応を追加）。HTTP API
（`packages/server`）をポーリングし、実行可能なノード（`executor: ai | script`）を自動で
処理する。zinsei desk の `desk/engine.py` の一般化にあたる。設計の正は `docs/design.md`
（3.4/3.5/3.7/3.8）・`docs/agent-contracts.md`。ラン（手順ページ）対応の詳細は本ファイル
末尾の「手順ページ（ラン）対応（M6後半）」セクション参照。

このパッケージは `packages/mcp` と同じ方針で **`packages/core`/`packages/server` に依存しない
自己完結パッケージ**にしてある（`src/types.ts` は core のスキーマの手動ミラー）。統合点は
HTTP API のみ。

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
| `GW_ENGINE_CLAUDE_MODEL` | `sonnet` | `claude -p` に渡す `--model` |

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
     （cwd はリポジトリ外の `os.tmpdir()`、タイムアウト5分）。`impl` が script でない script
     ノードは「実装がない」として失敗扱い
   - **ai**: `claude -p <prompt> --model <model> --allowedTools Read Grep Glob WebSearch WebFetch`
     を子プロセスで起動（タイムアウト10分）。プロンプトはゴール(group先ノード)の title/detail、
     親ノードのスレッド末尾の say メッセージ、自ノードの title/detail、`impl={type:"doc"}` なら
     その全文を含む（`src/executors/claude.ts` の `buildAiPrompt`）
4. 結果の記録: 成功なら `status`+`say` メッセージを投稿して `status=done`。失敗/タイムアウトなら
   `status` メッセージを投稿して `status=waiting` にし、`POST /request` で
   もう一度/内容を変える/中止 の判断カードを開く

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
  `{status:"waiting", note:"不可逆のため人間の実行待ち"}` にする（`pick.ts` の承認カード
  （`POST /request`）とは**未接続**。ランの承認カード連携は将来のスコープ）
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

### スケジュールによるラン自動生成（`src/schedule.ts` / `scheduleTick`）

- `node.schedule` を持つ `kind=procedure` ノードを毎tickチェックする。対応書式は
  `src/schedule.ts` の `parseSchedule` が正:
  - `every <N>m` / `every <N>h` — 最新ランの `created` から N 経過していたら新ラン
    （最新ランが無ければ即座に生成。cron の初回即時実行と同じ発想）
  - `daily <HH:MM>` — ローカル時刻でその時刻を過ぎていて、最新ランがローカル暦で「今日」の
    ものでなければ新ラン（trigger を問わず「今日の分」が1本あれば足りる、という判定）
  - それ以外の書式は**無視して警告ログ**（`未対応のschedule書式のため無視`）を出すだけで、
    ラン生成は行わない
- **重複防止**: その手順に `status=running` のランが既にあれば、上記条件を満たしていても
  新規生成しない（積み残し防止。前のランが全アイテム `done/dropped/skipped` になって
  `status=done` に変わるまでは次のランを作らない）
- 生成したランの `trigger` は `schedule:<schedule文字列そのまま>`（例 `schedule:every 15m`）
- パース・判定はいずれもネットワークI/Oを持たない純粋関数（`test/schedule.test.ts` でユニット
  テスト）

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
