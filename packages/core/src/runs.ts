// ラン（実行インスタンス）ストア。ルーティーンページ（docs/design.md 3.8）のテンプレート
// ノードは status を持たず、実行のたびに生成する Run 側のワークアイテムが status を持つ。
// 1ラン = 1ファイル（dataDir/runs/<runId>.json）。graph の snapshot と同じ atomic write。
import fs from "node:fs";
import path from "node:path";
import {
  type Node,
  type NodeSnapshot,
  type Run,
  RunSchema,
  type RunItem,
  type RunItemStatus,
} from "./schema.js";
import { nextId, nowIso } from "./ids.js";
import { ensureDir, readJson, writeJsonAtomic } from "./storage.js";
import { GraphError, collectDescendantsAmong } from "./graph.js";

export interface TriggerRunOpts {
  title?: string;
  /** 発火理由の自由文字列（"manual" / "schedule:<原文>" / "ai" 等。既定 "manual"）。
   *  run.trigger は "trigger:<triggerId>:<via>" の形で記録する */
  via?: string;
  /** ページ自身のノード（kind=goal）。渡すと発火時点のスナップショットに含める
   *  （ページ名も当時のものを見せられる。allMembers には自分自身は入らないため別引数） */
  pageNode?: Node | null;
}

/** ノードから発火時点スナップショット（NodeSnapshotSchema の形）を作る */
function toNodeSnapshot(n: Node): NodeSnapshot {
  return {
    id: n.id,
    title: n.title,
    detail: n.detail,
    impl: n.impl,
    parents: n.parents,
    group: n.group,
    kind: n.kind,
    executor: n.executor,
    approval: n.approval,
    autonomy: n.autonomy,
    aiModel: n.aiModel,
    aiEffort: n.aiEffort,
    lifecycle: n.lifecycle,
    status: n.status,
    fixed: n.fixed,
    schedule: n.schedule,
    branches: n.branches,
    parentOptions: n.parentOptions,
    assignee: n.assignee,
  };
}

export interface PatchItemInput {
  status?: RunItemStatus;
  note?: string | null;
  choice?: string | null;
}

export class RunStore {
  private runsDir: string;

  constructor(private dataDir: string) {
    this.runsDir = path.join(dataDir, "runs");
  }

  private file(runId: string): string {
    return path.join(this.runsDir, `${runId}.json`);
  }

  /** 既存ランidの一覧（ファイル名から拡張子を除いたもの）。id採番に使う */
  private existingIds(): string[] {
    ensureDir(this.runsDir);
    return fs
      .readdirSync(this.runsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
  }

  private all(): Run[] {
    return this.existingIds().map((id) => RunSchema.parse(readJson(this.file(id))));
  }

  /**
   * トリガーノード（kind=trigger）の発火からランを作成する（docs/design.md 3.8）。
   *
   * - items = トリガーの子孫（parents を辿って allMembers 内で到達可能なメンバー。分岐・合流を
   *   含む）。トリガー自身は items に含めない
   * - **Fix/committed をランの参加条件にしない**: lifecycle を問わず（draft も committed も）
   *   子孫であれば items に入る。draft は status=pending のまま入る（実行するかどうかは
   *   engine 側が lifecycle=committed のみを対象にすることで担保する。3.4「committedのみ
   *   自動実行」の原則は engine 側で維持）
   * - status=unplanned（やり方未定）のテンプレートは item.status を "skipped" にする
   *
   * pageId は run.procedure（＝ランが属するページ）に記録するid。トリガーノードの group が
   * 通常これにあたる（呼び出し側=server が渡す）。
   */
  createFromTrigger(
    pageId: string,
    triggerId: string,
    allMembers: Node[],
    opts: TriggerRunOpts = {},
  ): Run {
    const ts = nowIso();
    const descendants = collectDescendantsAmong(allMembers, triggerId);
    const items: Record<string, RunItem> = {};
    for (const n of allMembers) {
      if (!descendants.has(n.id)) continue;
      items[n.id] = {
        status: n.status === "unplanned" ? "skipped" : "pending",
        note: null,
        choice: null,
      };
    }
    const via = opts.via ?? "manual";
    // 発火時点の中身を焼く（2026-08-08）。items（＝トリガーの子孫）だけでなくページ構成
    // まるごと（ページ自身・トリガー・items に入らないメンバー）を残す——後から見返すときに
    // 「そのとき何がぶら下がっていたか」まで再現できないと当時のグラフにならないため
    const snapshotSource = opts.pageNode ? [opts.pageNode, ...allMembers] : allMembers;
    const run: Run = RunSchema.parse({
      id: nextId("r", this.existingIds()),
      procedure: pageId,
      title: opts.title ?? `ラン ${ts}`,
      trigger: `trigger:${triggerId}:${via}`,
      status: "running",
      items,
      snapshot: { capturedAt: ts, nodes: snapshotSource.map(toNodeSnapshot) },
      created: ts,
    });
    this.write(run);
    return run;
  }

  /** pageId に属するラン一覧。created 降順（新しい順） */
  list(pageId: string): Run[] {
    return this.all()
      .filter((r) => r.procedure === pageId)
      .sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  }

  /** 全ランをページ(procedure)ごとに束ねて返す。各配列は created 降順。
   *  左レールが全ページぶんのランを1リクエストで取るため（2026-08-08。旧: ページごとに
   *  list() を呼ぶ＝ページ数ぶんのリクエストと、その回数ぶんの全ラン走査） */
  listByPage(): Record<string, Run[]> {
    const byPage: Record<string, Run[]> = {};
    for (const r of this.all()) (byPage[r.procedure] ??= []).push(r);
    for (const list of Object.values(byPage)) {
      list.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
    }
    return byPage;
  }

  get(runId: string): Run {
    const raw = readJson<Run>(this.file(runId));
    if (!raw) throw new GraphError(`run not found: ${runId}`, 404);
    return RunSchema.parse(raw);
  }

  /**
   * ワークアイテムを更新する。全アイテムが done/dropped/skipped になったら
   * ラン全体の status を自動的に "done" にする（cancelled のランは覆さない）。
   */
  patchItem(runId: string, nodeId: string, patch: PatchItemInput): Run {
    const run = this.get(runId);
    const item = run.items[nodeId];
    if (!item) {
      throw new GraphError(`run ${runId} has no work item for node ${nodeId}`, 404);
    }
    const updatedItem: RunItem = {
      status: patch.status ?? item.status,
      note: patch.note !== undefined ? patch.note : item.note,
      choice: patch.choice !== undefined ? patch.choice : item.choice,
    };
    const items = { ...run.items, [nodeId]: updatedItem };
    const allSettled = Object.values(items).every(
      (it) => it.status === "done" || it.status === "dropped" || it.status === "skipped",
    );
    const status = run.status === "cancelled" ? run.status : allSettled ? "done" : run.status;
    const updated: Run = { ...run, items, status };
    this.write(updated);
    return updated;
  }

  /**
   * ランのワークアイテムのうち、テンプレートが kind=decision のものの choice を確定する
   * （docs/design.md 3.9 のラン内版）。GraphStore.applyDecision と同じ規則をラン内スコープで行う:
   * 1) item.choice をセット + status=done
   * 2) 直接規則: templates の parentOptions[decisionId] が choice と不一致な item を skipped
   * 3) 連鎖規則: 「ラン内に存在する全ての親」が skipped な item も skipped（再帰）
   * templates はページの全メンバー（branches/parentOptions の定義を引くため必要。
   * pickRun.ts の dependenciesSettled と同じく、ラン内に存在しない親は無視する）。
   */
  applyItemDecision(runId: string, nodeId: string, choice: string, templates: Node[]): Run {
    const run = this.get(runId);
    const item = run.items[nodeId];
    if (!item) {
      throw new GraphError(`run ${runId} has no work item for node ${nodeId}`, 404);
    }
    const templatesById = new Map(templates.map((t) => [t.id, t]));
    const decisionTemplate = templatesById.get(nodeId);
    if (!decisionTemplate || decisionTemplate.kind !== "decision") {
      throw new GraphError(`node ${nodeId} is not a decision (kind=${decisionTemplate?.kind})`);
    }
    // 実行フェーズに入っていないランアイテムで分岐を選べないようにするゲート（2026-07-31追加。
    // GraphStore.applyDecision の validateDecisionGate と同種。ラン内では「テンプレートの
    // parents のうち、このランの items に存在するもの」が全て done|skipped であることを見る
    // （pickRun.ts の dependenciesSettled と同じ「ラン内依存」規則）
    const relevantParents = decisionTemplate.parents.filter((pid) => pid in run.items);
    const parentsSettled = relevantParents.every((pid) => {
      const s = run.items[pid]?.status;
      return s === "done" || s === "skipped";
    });
    if (!parentsSettled) {
      throw new GraphError("前のノードが終わっていないため、まだ分岐を選べません", 409);
    }
    if (!decisionTemplate.branches || !decisionTemplate.branches.some((b) => b.id === choice)) {
      throw new GraphError(`unknown choice: ${choice}`);
    }

    let items: Record<string, RunItem> = {
      ...run.items,
      [nodeId]: { ...item, status: "done", choice },
    };

    // 直接規則: このdecisionを親に持ち、選ばれなかった枝のitemをskippedにする
    for (const [id, it] of Object.entries(items)) {
      if (it.status === "done" || it.status === "dropped" || it.status === "skipped") continue;
      const tmpl = templatesById.get(id);
      if (!tmpl) continue;
      const branchId = tmpl.parentOptions[nodeId];
      if (branchId !== undefined && branchId !== choice) {
        items = { ...items, [id]: { ...it, status: "skipped" } };
      }
    }

    // 連鎖規則: ラン内に存在する全ての親がskippedなitemもskippedにする（不動点まで繰り返す）
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, it] of Object.entries(items)) {
        if (it.status === "done" || it.status === "dropped" || it.status === "skipped") continue;
        const tmpl = templatesById.get(id);
        if (!tmpl) continue;
        const relevantParents = tmpl.parents.filter((pid) => pid in items);
        if (relevantParents.length === 0) continue; // ラン内に親が居なければ連鎖の対象外
        const allSkipped = relevantParents.every((pid) => items[pid]?.status === "skipped");
        if (allSkipped) {
          items = { ...items, [id]: { ...it, status: "skipped" } };
          changed = true;
        }
      }
    }

    const allSettled = Object.values(items).every(
      (it) => it.status === "done" || it.status === "dropped" || it.status === "skipped",
    );
    const status = run.status === "cancelled" ? run.status : allSettled ? "done" : run.status;
    const updated: Run = { ...run, items, status };
    this.write(updated);
    return updated;
  }

  /** ランの名前を変更する（並列ラン=ランの区別用ラベル。後からの編集を許す） */
  rename(runId: string, title: string): Run {
    const run = this.get(runId);
    const updated: Run = { ...run, title };
    this.write(updated);
    return updated;
  }

  cancel(runId: string): Run {
    const run = this.get(runId);
    const updated: Run = { ...run, status: "cancelled" };
    this.write(updated);
    return updated;
  }

  private write(run: Run): void {
    writeJsonAtomic(this.file(run.id), run);
  }
}
