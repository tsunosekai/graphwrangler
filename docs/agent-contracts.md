# M3〜M6 実装の分担契約（サブエージェント向け）

> **これは 2026-07-29 の並列実装ラウンド時点のスナップショット**（当時の作業指示書）。
> API一覧・ノードの形はその後の実装で増えている（試走・ラン・トリガー・分岐・
> ワークスペース等）。**現在の正は docs/design.md と packages/core/src/schema.ts**。
> 帰属の規約とファイル境界の考え方だけが今も有効。

docs/design.md が設計の正。本ファイルは並列実装のためのファイル境界と共有規約。
**全エージェント共通: git commit しない（統合担当がまとめてコミットする）。
pnpm add / pnpm install を実行しない（依存は準備済み）。コード内コメントは日本語。**

## サーバAPI（既存。全クライアントの共通口）

ベース: `http://localhost:<port>`（既定 8770、env `GRAPHWRANGLER_PORT` で変更、
データは env `GRAPHWRANGLER_DATA`）。起動: `packages/server` で `pnpm exec tsx src/index.ts`

- `GET  /api/state` → `{nodes, now}`
- `POST /api/nodes` `{title, detail?, impl?, parents?, group?, kind?, executor?, impact?, lifecycle?, status?, order?, actor?, via?}` → node
- `POST /api/nodes/:id` 部分patch（同上フィールド + pendingRequest）。`actor`/`via` で帰属
- `POST /api/nodes/:id/remove`
- `GET  /api/nodes/:id/thread` → `{messages}`（decision_request には requestStatus: open/answered が導出済み）
- `POST /api/nodes/:id/messages` `{kind: "say"|"status"|"artifact", body, payload?, actor?, via?}`
- `POST /api/nodes/:id/request` `{request: {context, question, options:[{id,label,then,recommended?}], impact, undo, expires, on_expire}, actor?, via?}` → ノードは waiting + pendingRequest
- `POST /api/nodes/:id/answer` `{requestId, option, note?}`（option=null はラリー＝open のまま）

ノードの形（apps/ui/src/types.ts / packages/core/src/schema.ts が正）:
kind: goal|task|procedure|decision|trigger / executor: human|ai|script / impact: safe|reversible|irreversible /
lifecycle: draft|committed / status: unplanned|pending|running|waiting|done|dropped|skipped /
impl: null | {type:"doc",text,path} | {type:"script",command} / group: 所属フォルダ / parents: 依存 /
schedule: kind=trigger(procedureも旧互換で)の起動方式 / branches: kind=decision の選択肢 /
choice: kind=decision が確定した枝id / parentOptions: 親が decision のときどの枝から生えるか

## 帰属の規約

- MCP経由の操作: `via: "mcp"`, actor は `{kind:"agent", name:"mcp:<クライアント名など>"}` か省略
- チャットAIの操作: `via: "chat"`, actor `{kind:"agent", name:"chat:<model>"}`
- エンジン: `via: "engine"`, actor `{kind:"agent", name:"engine"}` / executor実行は `name:"executor:<type>"`

## ファイル境界（他エージェントの領域に触れない）

| 担当 | 触ってよい場所 |
|---|---|
| A: MCP | `packages/mcp/**` のみ（骨格作成済み。HTTP APIを叩くstdioプロセスとして自己完結） |
| B: チャット | `packages/server/src/chat.ts`(新規), `packages/server/src/index.ts`(ルート追加行のみ), `apps/ui/src/components/Chat*.tsx`(新規), `apps/ui/src/App.tsx`/`TopBar.tsx`/`index.css`(チャット導線の追記のみ), `apps/ui/src/lib/api.ts`(chat用関数追記のみ) |
| C: エンジン | `packages/engine/**` のみ（骨格作成済み。HTTP APIのみ使用、serverのコードは変更しない） |
| D: ラン（Phase2） | `packages/core/**`, `packages/server/src/**`（Phase2 で単独） |
| E: 手順UI（Phase3） | `apps/ui/**` |
| F: エンジンのラン対応（Phase3） | `packages/engine/**` |

## 検証の約束（各エージェント必須）

- `pnpm --filter <pkg> typecheck` が通ること。UI変更時は `pnpm --filter ui build` も
- 実サーバでのE2E確認は**自分専用のポートとデータディレクトリ**で行う（8770は使用中の可能性
  あり）。例: `GRAPHWRANGLER_PORT=877X GRAPHWRANGLER_DATA=<scratchpad>/gw-X pnpm exec tsx src/index.ts`
- 日本語文字列を curl で送ると Git Bash で化ける。JSONファイルに書いて `curl -d @file` で送る
