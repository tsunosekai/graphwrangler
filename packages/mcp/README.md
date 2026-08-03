# @graphwrangler/mcp

GraphWrangler のグラフ変更 API を [MCP](https://modelcontextprotocol.io/)（stdio トランスポート）で公開するサーバ。
Claude Code などの MCP クライアントから、GraphWrangler のグラフを直接読み書きできる。

実体は薄いプロキシで、`packages/server` が公開する HTTP API（既定 `http://localhost:8770`）を
叩いているだけ。グラフの正データは常に HTTP API 側（＝操作ログ）にあり、このパッケージは状態を持たない。

## 前提

`packages/server` を先に起動しておくこと。

```bash
cd packages/server
pnpm exec tsx src/index.ts
# graphwrangler server: http://localhost:8770 (data: ./data)
```

## 起動方法

```bash
cd packages/mcp
pnpm exec tsx src/index.ts
```

stdio で JSON-RPC (MCP プロトコル) を待ち受ける。単体で実行しても何も表示されない（クライアントからの
接続を待っている状態）のが正常。

### 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `GRAPHWRANGLER_URL` | `http://localhost:8770` | 接続先の GraphWrangler HTTP API |

## Claude Code への登録例

```bash
claude mcp add graphwrangler -- npx tsx D:/VSCodeProject/infra-tools/graphwrangler/packages/mcp/src/index.ts
```

別ポートのサーバに繋ぎたい場合は `-e GRAPHWRANGLER_URL=http://localhost:8771` のように環境変数を渡す
（`claude mcp add` の `-e` オプション、または登録後に設定ファイルへ追記）。

## 公開しているツール

| ツール | 内容 |
|---|---|
| `state_get` | グラフ全体の要約（ノード数・ページ一覧・各ノードの主要フィールドのみ。`createdBy`/`assignee` を含み、detail/impl は含まない） |
| `node_get` | 1ノードの全フィールド |
| `node_add` | ノード作成（`assignee`=担当者メール、`members`=ページの関係者メール配列も指定可。`createdBy` は入力不可＝サーバが刻む） |
| `node_patch` | ノード部分更新（`assignee`/`members` も更新可。`createdBy` は不変の記録なので patch 不可） |
| `node_remove` | ノード削除（子がいると失敗） |
| `thread_get` | ノードスレッドのメッセージ一覧 |
| `message_post` | スレッドへの投稿（say/status/artifact） |
| `request_open` | 判断リクエストを開く（pendingRequest がセットされ、ボールが人間に渡る） |
| `request_answer` | 判断リクエストへの回答（option=null でラリー継続） |
| `trigger_fire` | トリガーノード（kind=trigger）を手動発火し、その group（所属ページ）でランを1本作成する |
| `run_list` | ページの過去のラン一覧（要約: id/title/status/trigger/created + ワークアイテム状態内訳カウント） |
| `run_get` | ラン1件の全フィールド（items の詳細を含む） |
| `run_item_patch` | ラン内の1ワークアイテムの状態/メモを更新 |
| `run_cancel` | 実行中のランを中断（cancelled） |
| `run_trace` | ランのトレース再生（紐づくスレッドメッセージを時系列で） |
| `undo` | 直前のグラフ操作（node_add/patch/remove）を1件取り消す |
| `redo` | 直前に undo した操作をやり直す |

全ての書き込みは `via: "mcp"`, `actor: {kind: "agent", name: "mcp"}` を付けて HTTP API に送る
（帰属規約は `docs/design.md` 3.2）。HTTP API がエラー（4xx/5xx の `{error}`）を返した場合は、
MCP のツールエラー（`isError: true` + メッセージ）として返す。プロセス自体は落ちない。

## テスト

`packages/server` に依存する E2E テスト（自分専用ポート・データディレクトリで HTTP サーバを起動し、
MCP サーバの stdin/stdout に直接 JSON-RPC を流して全ツールを確認する）:

```bash
node packages/mcp/test/e2e.mjs
```

## 補足

- ツール入力の zod スキーマ（`src/schemas.ts`）は `@graphwrangler/core/schema`（core の中で
  node 依存を持たない zod スキーマだけを集めたサブパス）を import して組み立てている。
  このパッケージ自体は `@graphwrangler/core` の他の実装（GraphStore/RunStore 等）には依存せず、
  HTTP API を叩くだけの自己完結を保っている
- `state_get` の「ページ」判定は `kind=goal` または他ノードの `group` として参照されている
  ノード、という設計文書どおりの定義
- ラン関連ツールは HTTP API（`packages/server`）へのプロキシ。run=実行インスタンスという
  用語は docs/design.md 3.8 に対応する。`run_cancel` に取り消し操作は無い
  （undo/redo はグラフ本体の操作ログのみが対象）
