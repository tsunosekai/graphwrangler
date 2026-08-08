// 「このランの時点の中身」の表示（2026-08-08 本人要望「その時のノードの状態を見れるように」）。
//
// テンプレートノードはランをまたいで共有されるので、あとからタイトルや手順を書き換えると
// 過去のランを開いても今の文面しか出ない。サーバの GET /api/runs/:id/graph は
// 「発火時に焼いたスナップショット → 操作ログの再生 → 現在の中身」の順に当時を割り出すので、
// それを現在の値と突き合わせて**違うところだけ**出す。
// - 当時と同じなら何も出さない（常時出すと普通のノードにも注記が付いて騒がしい）
// - source==="current"（当時の記録が無く現在で代用）のときも出さない。分からないものを
//   「当時はこうでした」と見せない
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Node, Run, RunGraphNode } from "../types";

/** ラン id → そのランの時点のノード一覧。ランの中身は不変なので取得は1回でよい */
const cache = new Map<string, Promise<Map<string, RunGraphNode>>>();

function loadRunGraph(runId: string): Promise<Map<string, RunGraphNode>> {
  const hit = cache.get(runId);
  if (hit) return hit;
  const p = api
    .getRunGraph(runId)
    .then((r) => new Map(r.nodes.map((n) => [n.id, n])))
    .catch(() => new Map<string, RunGraphNode>());
  cache.set(runId, p);
  return p;
}

/** 手順（impl）を1行で表す。差分の有無を見るのと、そのまま表示するのに使う */
function implLine(impl: Node["impl"]): string {
  if (!impl) return "なし";
  if (impl.type === "script") return `コマンド: ${impl.command}`;
  return impl.path ? `手順書: ${impl.path}` : `手順書: ${(impl.text ?? "").slice(0, 60)}`;
}

interface Props {
  /** 表示中のラン。null = ラン投影なし（テンプレートを見ている）*/
  run: Run | null;
  node: Node;
}

export function RunTimeNote({ run, node }: Props) {
  const [past, setPast] = useState<RunGraphNode | null>(null);
  useEffect(() => {
    if (!run) {
      setPast(null);
      return;
    }
    let alive = true;
    void loadRunGraph(run.id).then((m) => {
      if (alive) setPast(m.get(node.id) ?? null);
    });
    return () => {
      alive = false;
    };
  }, [run, node.id]);

  if (!past || past.source === "current") return null;
  const rows: Array<[string, string]> = [];
  if (past.title !== node.title) rows.push(["タイトル", past.title || "（無題）"]);
  if ((past.detail ?? null) !== (node.detail ?? null)) rows.push(["概要", past.detail || "（空）"]);
  if (implLine(past.impl ?? null) !== implLine(node.impl)) rows.push(["手順", implLine(past.impl ?? null)]);
  if (rows.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs">
      <div className="mb-1 text-text-lo">
        このランの時点（{run?.title}）— 今と違うところ
        {past.source === "replay" && <span className="ml-1 opacity-70">※記録から復元</span>}
      </div>
      <dl className="flex flex-col gap-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <dt className="w-10 flex-shrink-0 text-text-lo">{label}</dt>
            <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
