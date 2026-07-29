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
| `state_get` | グラフ全体の要約（ノード数・ページ一覧・各ノードの主要フィールドのみ。detail/impl は含まない） |
| `node_get` | 1ノードの全フィールド |
| `node_add` | ノード作成 |
| `node_patch` | ノード部分更新 |
| `node_remove` | ノード削除（子がいると失敗） |
| `thread_get` | ノードスレッドのメッセージ一覧 |
| `message_post` | スレッドへの投稿（say/status/artifact） |
| `request_open` | 判断リクエストを開く（ノードが waiting になる） |
| `request_answer` | 判断リクエストへの回答（option=null でラリー継続） |

全ての書き込みは `via: "mcp"`, `actor: {kind: "agent", name: "mcp"}` を付けて HTTP API に送る
（`docs/agent-contracts.md` の帰属規約）。HTTP API がエラー（4xx/5xx の `{error}`）を返した場合は、
MCP のツールエラー（`isError: true` + メッセージ）として返す。プロセス自体は落ちない。

## テスト

`packages/server` に依存する E2E テスト（自分専用ポート・データディレクトリで HTTP サーバを起動し、
MCP サーバの stdin/stdout に直接 JSON-RPC を流して全ツールを確認する）:

```bash
node packages/mcp/test/e2e.mjs
```

## 妥協点

- ツール入力の zod スキーマ（`src/schemas.ts`）は `packages/core/src/schema.ts` の手動ミラー
  （このパッケージは `@graphwrangler/core` に依存せず自己完結させているため。apps/ui/src/types.ts
  と同じ既知の妥協。core のノード形を変えたら追随が必要）
- `state_get` の「ページ」判定は `kind=goal/procedure` または他ノードの `group` として参照されている
  ノード、という設計文書どおりの定義。ページ種別ごとの追加メタ情報（procedure 用のラン情報等）は
  M6 まで未実装
