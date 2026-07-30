// ラン（実行インスタンス）ストア。手順ページ（docs/design.md 3.8）のテンプレートノードは
// status を持たず、実行のたびに生成する Run 側のワークアイテムが status を持つ。
// 1ラン = 1ファイル（dataDir/runs/<runId>.json）。graph の snapshot と同じ atomic write。
import fs from "node:fs";
import path from "node:path";
import {
  type Node,
  type Run,
  RunSchema,
  type RunItem,
  type RunItemStatus,
} from "./schema.js";
import { nextId, nowIso } from "./ids.js";
import { ensureDir, readJson, writeJsonAtomic } from "./storage.js";
import { GraphError } from "./graph.js";

export interface RunCreateOpts {
  title?: string;
  trigger?: string;
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
   * ランを作成する。ワークアイテムは渡されたメンバーのうち lifecycle=committed の
   * テンプレートだけ（status は見ない = draft は素通りしない、というのが唯一のフィルタ）。
   * その中で status=unplanned（やり方未定）のテンプレートは item.status を "skipped" にし、
   * それ以外は "pending" にする。
   */
  create(procedureId: string, memberNodes: Node[], opts: RunCreateOpts = {}): Run {
    const ts = nowIso();
    const items: Record<string, RunItem> = {};
    for (const n of memberNodes) {
      if (n.lifecycle !== "committed") continue;
      items[n.id] = {
        status: n.status === "unplanned" ? "skipped" : "pending",
        note: null,
        choice: null,
        updated: ts,
      };
    }
    const run: Run = RunSchema.parse({
      id: nextId("r", this.existingIds()),
      procedure: procedureId,
      title: opts.title ?? `ラン ${ts}`,
      trigger: opts.trigger ?? "manual",
      status: "running",
      items,
      created: ts,
      updated: ts,
    });
    this.write(run);
    return run;
  }

  /** procedureId に属するラン一覧。created 降順（新しい順） */
  list(procedureId: string): Run[] {
    return this.all()
      .filter((r) => r.procedure === procedureId)
      .sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
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
    const ts = nowIso();
    const updatedItem: RunItem = {
      status: patch.status ?? item.status,
      note: patch.note !== undefined ? patch.note : item.note,
      choice: patch.choice !== undefined ? patch.choice : item.choice,
      updated: ts,
    };
    const items = { ...run.items, [nodeId]: updatedItem };
    const allSettled = Object.values(items).every(
      (it) => it.status === "done" || it.status === "dropped" || it.status === "skipped",
    );
    const status = run.status === "cancelled" ? run.status : allSettled ? "done" : run.status;
    const updated: Run = { ...run, items, status, updated: ts };
    this.write(updated);
    return updated;
  }

  /**
   * ランのワークアイテムのうち、テンプレートが kind=decision のものの choice を確定する
   * （docs/design.md 3.9 のラン内版）。GraphStore.applyDecision と同じ規則をラン内スコープで行う:
   * 1) item.choice をセット + status=done
   * 2) 直接規則: templates の parentOptions[decisionId] が choice と不一致な item を skipped
   * 3) 連鎖規則: 「ラン内に存在する全ての親」が skipped な item も skipped（再帰）
   * templates は procedure の全メンバー（branches/parentOptions の定義を引くため必要。
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
    if (!decisionTemplate.branches || !decisionTemplate.branches.some((b) => b.id === choice)) {
      throw new GraphError(`unknown choice: ${choice}`);
    }

    const ts = nowIso();
    let items: Record<string, RunItem> = {
      ...run.items,
      [nodeId]: { ...item, status: "done", choice, updated: ts },
    };

    // 直接規則: このdecisionを親に持ち、選ばれなかった枝のitemをskippedにする
    for (const [id, it] of Object.entries(items)) {
      if (it.status === "done" || it.status === "dropped" || it.status === "skipped") continue;
      const tmpl = templatesById.get(id);
      if (!tmpl) continue;
      const branchId = tmpl.parentOptions[nodeId];
      if (branchId !== undefined && branchId !== choice) {
        items = { ...items, [id]: { ...it, status: "skipped", updated: ts } };
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
          items = { ...items, [id]: { ...it, status: "skipped", updated: ts } };
          changed = true;
        }
      }
    }

    const allSettled = Object.values(items).every(
      (it) => it.status === "done" || it.status === "dropped" || it.status === "skipped",
    );
    const status = run.status === "cancelled" ? run.status : allSettled ? "done" : run.status;
    const updated: Run = { ...run, items, status, updated: ts };
    this.write(updated);
    return updated;
  }

  cancel(runId: string): Run {
    const run = this.get(runId);
    const updated: Run = { ...run, status: "cancelled", updated: nowIso() };
    this.write(updated);
    return updated;
  }

  private write(run: Run): void {
    writeJsonAtomic(this.file(run.id), run);
  }
}
