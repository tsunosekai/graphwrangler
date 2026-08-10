// 配線チェック（ランのコンテキストの静的検査。docs/design.md 3.15「配線チェック」）。
// ルーティーンページの各 script ノードのコマンド中 `{name}` 参照（consumer）と、
// メンバーの outputs 宣言（producer。トリガー含む）を照合し、参照矢印（破線描画用）と
// 警告バッジの素材を返す。**ラン作成は絶対に止めない**——ここは警告のみで、実行時に本当に
// 値が無ければそのノードだけが失敗リカバリに落ちる（3.15 の原則）。
// 純関数: サーバの GET /api/pages/:id/wiring がグラフの現在ノードを渡して呼ぶ。
import type { Node } from "./schema.js";
import { referencedParamNames } from "./params.js";

/** 参照矢印の1本（producer の outputs 宣言 → consumer のコマンド中 `{name}`）。
 *  警告の有無に関係なく、宣言と参照の組み合わせを全部返す（UI が破線を描く素材） */
export interface WiringReference {
  producerId: string;
  consumerId: string;
  name: string;
}

/** 警告4種（docs/design.md 3.15 の 1〜4 と対応）:
 *  - missing: producer が1つも無く、デフォルト値（impl.params[].value）も無い
 *  - not-ancestor: producer は居るが、誰も consumer の祖先でない（並列の枝＝実行順の
 *    保証が無く、last-write-wins の運ゲーになる）
 *  - branch-dependent: 祖先 producer は居るが、経路によっては skip されて値が来ない
 *  - duplicate: 互いに祖先関係にない複数 producer が同じキーを宣言（書き順の運ゲー） */
export type WiringWarningKind = "missing" | "not-ancestor" | "branch-dependent" | "duplicate";

export interface WiringWarning {
  /** 警告が付く consumer ノードの id（UI のバッジの宛先） */
  nodeId: string;
  /** 対象のコンテキストキー */
  name: string;
  kind: WiringWarningKind;
  /** 人間向けの日本語文言（UI がそのまま出せる形） */
  message: string;
}

export interface WiringResult {
  references: WiringReference[];
  warnings: WiringWarning[];
}

/**
 * ページ pageId の配線チェック。
 *
 * - 対象（consumer）= ページのメンバー（group===pageId）のうち impl.type==="script" のノード
 * - producer = outputs に同名キーを宣言しているメンバー（トリガー含む）
 * - 祖先判定 = consumer から parents を推移的に遡って到達できるか（メンバー内で完結。
 *   ページ外のノードは配線に関与しない）
 * - impl.params[].value が非空なら「デフォルト値あり」として missing は出さない
 *   （producer が居れば references には載せる）
 */
export function checkWiring(allNodes: Node[], pageId: string): WiringResult {
  const members = allNodes.filter((n) => n.group === pageId);
  const byId = new Map(members.map((n) => [n.id, n]));

  // 祖先集合（自分自身は含まない）。メンバー数×辺数の小規模グラフ想定なので
  // ノードごとの DFS + メモ化で十分
  const ancestorsCache = new Map<string, Set<string>>();
  function ancestorsOf(id: string): Set<string> {
    const cached = ancestorsCache.get(id);
    if (cached) return cached;
    const seen = new Set<string>();
    ancestorsCache.set(id, seen); // 循環対策（DAG のはずだが、壊れたデータでも無限再帰しない）
    const stack = [...(byId.get(id)?.parents ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur) || !byId.has(cur)) continue; // メンバー外の親は辿らない
      seen.add(cur);
      stack.push(...(byId.get(cur)?.parents ?? []));
    }
    return seen;
  }

  // キー名 → producer ノード一覧（同一ノードが同名を重複宣言していても1回だけ数える）
  const producersByName = new Map<string, Node[]>();
  for (const n of members) {
    for (const name of new Set((n.outputs ?? []).map((o) => o.name))) {
      const list = producersByName.get(name) ?? [];
      list.push(n);
      producersByName.set(name, list);
    }
  }

  /**
   * 経路依存（branch-dependent）の近似判定: producer から consumer までの経路上に
   * decision の枝選択があるか。厳密なグラフ到達解析（全経路の列挙）はせず、
   * 「producer またはその子孫のうち consumer の祖先に当たるノードのどれかが
   * parentOptions（枝への所属）を持つか」で近似する。producer 自身が枝の下に居る場合も
   * これに含まれる。consumer 自身の parentOptions は見ない——consumer が skip される
   * 経路ではそもそもコマンドが動かないので、値が来ない問題は起きないため。
   * 近似ゆえに「枝を経由しない別経路もある」ケースでも警告になりうるが、
   * 警告はラン作成を止めない（過検知は許容。3.15）
   */
  function isBranchDependent(producer: Node, consumerAncestors: Set<string>): boolean {
    for (const n of members) {
      if (!consumerAncestors.has(n.id)) continue;
      if (Object.keys(n.parentOptions).length === 0) continue;
      if (n.id === producer.id || ancestorsOf(n.id).has(producer.id)) return true;
    }
    return false;
  }

  const references: WiringReference[] = [];
  const warnings: WiringWarning[] = [];

  for (const consumer of members) {
    if (consumer.impl?.type !== "script") continue;
    const params = consumer.impl.params ?? [];
    for (const name of referencedParamNames(consumer.impl.command)) {
      const producers = producersByName.get(name) ?? [];
      // デフォルト値あり = impl.params の同名宣言に非空 value がある（解決順②。3.15）
      const hasDefault = params.some(
        (p) => p.name === name && p.value !== null && p.value !== undefined && p.value !== "",
      );

      // 参照矢印は警告の有無に関係なく全部（描画用）
      for (const p of producers) {
        references.push({ producerId: p.id, consumerId: consumer.id, name });
      }

      if (producers.length === 0) {
        if (!hasDefault) {
          warnings.push({
            nodeId: consumer.id,
            name,
            kind: "missing",
            message: `「${name}」を出力宣言しているノードが無く、デフォルト値もありません（実行時に未入力エラーになります）`,
          });
        }
        continue;
      }

      const consumerAncestors = ancestorsOf(consumer.id);
      const ancestorProducers = producers.filter((p) => consumerAncestors.has(p.id));
      if (ancestorProducers.length === 0) {
        warnings.push({
          nodeId: consumer.id,
          name,
          kind: "not-ancestor",
          message: `「${name}」の供給元がこのノードの祖先にいません（実行順が保証されず、値が間に合わない可能性があります）`,
        });
      } else if (!hasDefault && ancestorProducers.every((p) => isBranchDependent(p, consumerAncestors))) {
        // 祖先 producer が全員「枝の下」のときだけ警告（1人でも無条件経路の producer が
        // 居れば値は必ず届く）。デフォルト値があれば黙認（design.md 3.15 警告3）
        warnings.push({
          nodeId: consumer.id,
          name,
          kind: "branch-dependent",
          message: `「${name}」の供給元が分岐の枝の下にあり、経路によっては値が来ません（デフォルト値もありません）`,
        });
      }

      // 重複 producer: 互いに祖先関係にないペアが1組でもあれば書き順の保証が無い
      if (producers.length >= 2) {
        const unordered = producers.some((a, i) =>
          producers.slice(i + 1).some(
            (b) => !ancestorsOf(a.id).has(b.id) && !ancestorsOf(b.id).has(a.id),
          ),
        );
        if (unordered) {
          warnings.push({
            nodeId: consumer.id,
            name,
            kind: "duplicate",
            message: `「${name}」を互いに祖先関係にない複数のノードが出力宣言しています（どちらの値になるかは書き順しだいです）`,
          });
        }
      }
    }
  }

  return { references, warnings };
}
