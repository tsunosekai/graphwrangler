# GraphWrangler

**AI駆動タスクグラフ** — An agent-driven procedural task graph.

人間とAIが一緒にタスクを整理し、人間 / AI / スクリプトが分担して処理する汎用ツール。
名前は Houdini の Wrangle（ノードを直接手なずける場所）と、群れを追い立てて仕事をさせる
wrangler（牛追い）から — 言うことを聞かないタスクと AI エージェントの群れを取り回す道具。
[zinsei](https://github.com/tsunosekai/zinsei) の desk をプロトタイプとして一般化する。

**設計の正は [docs/design.md](docs/design.md)。**

## 核となるアイデア

- **グラフが正データ、テキストは投影** — アウトラインとグラフは同一データへの2つのエディタ。
  リアルタイムに行き来できる（左脳型/右脳型のどちらの整理スタイルも、共有と認知負荷軽減の
  ために両方の表現を必要とする）
- **人間 / AI / スクリプトをノード単位で対等に混在実行** — AIで始めて、安定したら
  スクリプトに硬化する（判例→成文法）
- **PDG的実行モデル** — 依存駆動・差分再計算・ローカル/リモートのスケジューラ抽象
- **人間へのボールは構造化された判断リクエスト** — 文脈税をAIに払わせ、
  会話はノードに帰属するスレッドで、通知は一つの受信箱で

## 構成

```
packages/core    … データモデル・グラフストア（操作ログ）・スレッドストア
packages/server  … HTTP API（Hono）+ UI配信。将来 MCP サーバ
apps/ui          … Web UI（React + React Flow）
```

## 開発

```bash
pnpm install
pnpm test        # core のテスト
pnpm dev         # server(:8770) + ui(Vite) を起動
```
