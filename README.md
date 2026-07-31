# GraphWrangler

**AI駆動タスクグラフ** — An agent-driven procedural task graph.

人間とAIが一緒にタスクを整理し、人間 / AI / スクリプトが分担して処理する業務ツール。
名前は Houdini の Wrangle（ノードを直接手なずける場所）と、群れを追い立てて仕事をさせる
wrangler（牛追い）から — 言うことを聞かないタスクと AI エージェントの群れを取り回す。
[zinsei](https://github.com/tsunosekai/zinsei) の desk をプロトタイプとして一般化する。

**設計の正は [docs/design.md](docs/design.md)。**

## 核となるアイデア

- **グラフが正データ、テキストは投影** — アウトラインとグラフは同一データへの2つのエディタ。
  リアルタイムに行き来できる（左脳型/右脳型のどちらの整理スタイルも、共有と認知負荷軽減の
  ために両方の表現を必要とする）
- **人間 / AI / スクリプトをノード単位で対等に混在実行** — AIで始めて、安定したら
  スクリプトにFixする（判例→成文法）
- **PDG的実行モデル** — 依存駆動・差分再計算・ローカル/リモートのスケジューラ抽象
- **人間へのボールは構造化された判断リクエスト** — 文脈税をAIに払わせ、
  会話はノードに帰属するスレッドで、通知は一つの受信箱で

## 構成

```
packages/core    … データモデル・グラフストア（操作ログ）・スレッド・ランストア
packages/server  … HTTP API（Hono）+ 内蔵チャット(/api/chat) + UI配信
packages/engine  … 実行エンジン（script / claude -p executor、ラン実行、schedule）
packages/mcp     … MCP サーバ（Claude Code 等からグラフを直接読み書き）
apps/ui          … Web UI（React + React Flow。グラフ/台帳・スレッド・判断カード・チャット）
```

## 使い方

```bash
pnpm install
pnpm test                                  # core のテスト
node scripts/seed-demo.mjs                 # デモデータ投入（サーバ起動後に）

# サーバ + UI（http://localhost:8770。データは GRAPHWRANGLER_DATA、既定 ./data）
pnpm --filter ui build
pnpm --filter @graphwrangler/server start

# 実行エンジン（committed なタスク/ランのアイテムを自動処理。claude CLI 必要）
pnpm --filter @graphwrangler/engine start

# 内蔵チャット・実行エンジンとも既定の接続方式は CLI（ログイン済み claude CLI を
# ヘッドレス起動）。APIキー方式を使いたい場合は UI右上の⚙「AI設定」で接続方式を
# API に切り替えてキーを設定する（環境変数 ANTHROPIC_API_KEY / OPENAI_API_KEY +
# GW_CHAT_PROVIDER=openai はその設定が無いときのフォールバック）

# Claude Code から使う（MCP）:
claude mcp add graphwrangler -- npx tsx <このリポジトリ>/packages/mcp/src/index.ts
```

### 既存リポジトリを開く（ワークスペースモード）

対象リポジトリのルートに置いた1ファイルを正データとして開ける（.excalidraw と同じ使用感。
docs/design.md 3.10）。グラフ定義は `workflow.gw.json`、会話ログは隣の
`.graphwrangler/threads/` に入り、どちらも git にコミットして経緯ごと版管理する
（ラン履歴・undo記録・AI設定は自動生成の .gitignore で除外される）。

```bash
# 環境変数 か --workspace で正データファイルを指定（ディレクトリ指定なら workflow.gw.json）
GRAPHWRANGLER_WORKSPACE=/path/to/repo/workflow.gw.json pnpm --filter @graphwrangler/server start

# 既存の data ディレクトリからの移行
node scripts/migrate-to-workspace.mjs ./data /path/to/repo/workflow.gw.json
```

ノードの実装（impl）は `{type:"doc", path:"docs/x.md"}` でリポジトリ内のドキュメントを
パス参照でき、実行AIが実行時に読む。スクリプトの作業ディレクトリもワークスペースルートになる。
