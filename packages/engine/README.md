# @graphwrangler/engine

GraphWrangler の常駐実行エンジン（M5）。HTTP API（`packages/server`）をポーリングし、
実行可能なノード（`executor: ai | script`）を自動で処理する。zinsei desk の
`desk/engine.py` の一般化にあたる。設計の正は `docs/design.md`（3.4/3.5/3.7）・
`docs/agent-contracts.md`。

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
