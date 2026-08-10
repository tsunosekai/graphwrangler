// グラフストア。すべての変更は操作ログ（ops.jsonl）を通り、snapshot.json は
// その適用結果にすぎない（docs/design.md 3.2）。snapshot 直接編集は禁止。
//
// ワークスペースモード（ワークスペース=1ファイル化）では正データファイル
// （<repo>/workflow.gw.json 等）が正になる。ops.jsonl はサイドカー（.graphwrangler/）
// への「セッション内 undo 用の作業記録」に格下げされ、起動時には再生しない
// （正データファイルを zod でパースして初期状態にする）。
import fs from "node:fs";
import path from "node:path";
import {
  ActorSchema,
  type Actor,
  type Node,
  type NodeBranch,
  type NodeImpl,
  NodeInputCompatSchema,
  type NodeInput,
  NodePatchSchema,
  NodePatchCompatSchema,
  type NodePatch,
  type OpRecord,
  OpRecordSchema,
  type ScriptParam,
  type WorkspaceFile,
  WorkspaceFileSchema,
} from "./schema.js";
import { nextId, nowIso } from "./ids.js";
import { appendJsonl, readJson, readJsonl, writeJsonAtomic, writeTextAtomic } from "./storage.js";
import { stableStringify } from "./stable-stringify.js";

/** 操作の帰属メタデータ。省略時は human/ui（desk の actor 既定と同じ思想） */
export interface OpMeta {
  actor?: Actor;
  via?: string;
  /** 操作の背後にいる人間のメール（ログイン運用時のみ）。actor が agent（チャットAI経由の
   *  作成など）でも「誰のための操作か」を保持し、addNode の createdBy に刻む用途に使う。
   *  ops.jsonl には保存しない（帰属の正本は actor/via のまま） */
  user?: string | null;
}

export class GraphError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
  }
}

interface Snapshot {
  nodes: Node[];
}

/** GraphStore の動作モード。datadir=従来（ops.jsonl 再生 + snapshot.json）、
 *  workspace=ワークスペース=1ファイル化（正データファイルが正、ops.jsonl は
 *  サイドカーへの undo 用作業記録のみ）。互換のため datadir は一切変更しない */
type StoreMode =
  | { kind: "datadir"; dataDir: string }
  | { kind: "workspace"; canonicalFile: string; sidecarDir: string };

function sortNodesById(nodes: Node[]): Node[] {
  return [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** parents が全て done または skipped か（空配列=ルートは真）。存在しない親は「未完了」扱いに
 *  して安全側に倒す。skipped も充足扱いにするのは分岐(3.9)の合流ノードが片方の枝の skipped で
 *  止まらないようにするため（「skipped でない親が全て done」と同値。docs/design.md 3.9）。
 *  engine 側（pick.ts の isFrontier / decision.ts / decisionRun.ts / pickRun.ts）にも同じ述語が
 *  あるが、engine は core へ**型のみ依存**の方針でランタイム import をしないためミラーになる。
 *  規則の正はここ。 */
export function parentsSatisfied(parents: string[], byId: ReadonlyMap<string, Node>): boolean {
  return parents.every((pid) => {
    const s = byId.get(pid)?.status;
    return s === "done" || s === "skipped";
  });
}

/** 操作レコード1件を nodes マップへ適用する。GraphStore のインスタンスに依存しない純粋な
 *  手続きにしてあるのは、静的な畳み込み（foldRecords）が「不完全な GraphStore」を作らずに
 *  済むようにするため */
function applyRecord(nodes: Map<string, Node>, record: OpRecord): void {
  switch (record.op) {
    case "node.add": {
      nodes.set(record.payload.node.id, record.payload.node);
      break;
    }
    case "node.patch": {
      const cur = nodes.get(record.payload.nodeId);
      if (!cur) throw new GraphError(`node not found: ${record.payload.nodeId}`, 404);
      nodes.set(cur.id, { ...cur, ...record.payload.patch });
      break;
    }
    case "node.remove": {
      nodes.delete(record.payload.nodeId);
      break;
    }
  }
}

/** 正データファイルを読む。存在しない/空なら空グラフ（[]）として扱う（最初のcommitで
 *  ファイルを作る想定）。壊れたファイル（不正JSON・zod不通過）は起動時に明確なエラーにする */
export function readWorkspaceFile(file: string): Node[] {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new GraphError(
      `正データファイルの読み込みに失敗しました（不正なJSON）: ${file}\n${(e as Error).message}`,
      500,
    );
  }
  const result = WorkspaceFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new GraphError(
      `正データファイルの形式が不正です: ${file}\n${result.error.message}`,
      500,
    );
  }
  return result.data.nodes;
}

/** 正データファイルをアトミック書き込みする。nodes は id 昇順に並べ替え、
 *  キー再帰辞書順ソート済みの決定的シリアライズ（stableStringify）で書く */
export function writeWorkspaceFile(file: string, nodes: Node[]): void {
  const payload: WorkspaceFile = {
    format: "graphwrangler-workspace",
    version: 1,
    nodes: sortNodesById(nodes),
  };
  writeTextAtomic(file, stableStringify(payload));
}

/** id とその子孫すべて（nodes 配列内の parents リンクを辿る。id 自身は含まない）。
 *  GraphStore.collectDescendants と RunStore.createFromTrigger（トリガーの子孫算出）が
 *  共有する純粋関数として切り出した（docs/design.md 3.8 新モデル）。 */
export function collectDescendantsAmong(nodes: Node[], id: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    for (const p of n.parents) {
      const list = childrenOf.get(p) ?? [];
      list.push(n.id);
      childrenOf.set(p, list);
    }
  }
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of childrenOf.get(cur) ?? []) {
      if (!seen.has(c)) {
        seen.add(c);
        stack.push(c);
      }
    }
  }
  return seen;
}

// ---- Fix（= ロック。やり方の確定）の実効化（docs/design.md 3.5）----
//
// Fix 中に守るのは「やり方」であって進捗ではない。保護対象は
// title/detail/kind/executor/approval/parents/group/branches/parentOptions/schedule/impl
// （impl は params[].value の変更だけ例外で許可——値は実行時入力でありやり方ではない）。
// status/lifecycle/fixed/pendingRequest/implTrial/choice は進捗・ロック自体の
// 操作なので常に変更できる（許可リストではなく、保護リストに載っていないもの全て、という形で表す）。
// folder/order（左レールの整理棚と並び順。2026-08-05）も保護しない — どこにどの順で
// 並べて見せるかは「やり方」ではないので、Fix 済みのページも片付けられる。
// aiModel/aiEffort（2026-08-07）も保護しない — どのモデル・エフォートで走らせるかは
// params[].value と同じ実行時チューニングであり、「やり方」ではない。

const FIXED_PROTECTED_SIMPLE_FIELDS = [
  "title",
  "detail",
  "kind",
  "executor",
  "approval",
  "parents",
  "group",
  "branches",
  "parentOptions",
  "schedule",
] as const satisfies readonly (keyof NodePatch)[];

const FIXED_PATCH_MESSAGE = "ロック済みのノードのやり方は変更できません（先にロックを解除してください）";
const FIXED_REMOVE_MESSAGE = "ロック済みのノードは削除できません（先にロックを解除してください）";
const FIXED_UNDO_MESSAGE = "ロック済みのノードに関わる操作は元に戻せません（先にロックを解除してください）";

/** impl の実質比較: script の params は value（実行時に人間が入力する値）を除いて比較する。
 *  command・type・params の宣言（name/label/example）が同じで value だけ違う場合は
 *  「やり方としては同じ」とみなす（docs/design.md 3.5 実効化）。graph.test.ts から直接検証する */
export function implEqualIgnoringParamValues(a: NodeImpl | null, b: NodeImpl | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.type !== b.type) return false;
  if (a.type === "doc") {
    const other = b as Extract<NodeImpl, { type: "doc" }>;
    return (a.text ?? null) === (other.text ?? null) && (a.path ?? null) === (other.path ?? null);
  }
  const other = b as Extract<NodeImpl, { type: "script" }>;
  if (a.command !== other.command) return false;
  const stripValues = (params: ScriptParam[] | null | undefined) =>
    (params ?? []).map(({ value: _value, ...rest }) => rest);
  return stableStringify(stripValues(a.params)) === stableStringify(stripValues(other.params));
}

/** 対象ノードが fixed のとき、patch が「やり方」フィールドを実質的に変更していないか検証する。
 *  同値の patch（no-opの再送）は許可する。message は呼び出し文脈（直接 patch / undo の補償）で
 *  使い分ける（docs/design.md 3.5 実効化）。fixed でなければ常に許可（早期return） */
function assertPatchAllowedWhileFixed(current: Node, patch: NodePatch, message: string): void {
  if (!current.fixed) return;
  for (const field of FIXED_PROTECTED_SIMPLE_FIELDS) {
    const next = patch[field];
    if (next === undefined) continue;
    if (stableStringify(next) !== stableStringify(current[field])) {
      throw new GraphError(message, 409);
    }
  }
  if (patch.impl !== undefined && !implEqualIgnoringParamValues(current.impl, patch.impl)) {
    throw new GraphError(message, 409);
  }
}

export class GraphStore {
  private nodes = new Map<string, Node>();
  private mode: StoreMode;
  private opsPath: string;

  /** 従来どおり data-dir モードで開く（`new GraphStore(dataDir)`）。
   *  ワークスペースモードは `GraphStore.workspace()` から StoreMode を渡して同じ経路を通る */
  constructor(dataDir: string);
  constructor(mode: StoreMode);
  constructor(arg: string | StoreMode) {
    this.mode = typeof arg === "string" ? { kind: "datadir", dataDir: arg } : arg;
    if (this.mode.kind === "workspace") {
      this.opsPath = path.join(this.mode.sidecarDir, "ops.jsonl");
      for (const n of readWorkspaceFile(this.mode.canonicalFile)) this.nodes.set(n.id, n);
    } else {
      this.opsPath = path.join(this.mode.dataDir, "ops.jsonl");
      const snap = readJson<Snapshot>(path.join(this.mode.dataDir, "snapshot.json"));
      if (snap) {
        for (const n of snap.nodes) this.nodes.set(n.id, n);
      }
    }
  }

  /**
   * ワークスペースモードで開く（ワークスペース=1ファイル化）。canonicalFile
   * （例: <repo>/workflow.gw.json）を正として zod パースし初期状態にする。
   * sidecarDir（例: <repo>/.graphwrangler）には ops.jsonl（undo 用の作業記録。
   * 再生しない）を置く。従来の data-dir モードとは完全に別経路で、互換は壊さない
   */
  static workspace(canonicalFile: string, sidecarDir: string): GraphStore {
    return new GraphStore({ kind: "workspace", canonicalFile, sidecarDir });
  }

  /** サーバの GET /api/workspace 用: 現在のモードと関連パスを返す */
  workspaceInfo(): { mode: "workspace" | "datadir"; root: string | null; file: string | null } {
    if (this.mode.kind === "workspace") {
      return { mode: "workspace", root: path.dirname(this.mode.canonicalFile), file: this.mode.canonicalFile };
    }
    return { mode: "datadir", root: null, file: null };
  }

  // ---- 読み取り ----

  state(): { nodes: Node[] } {
    return { nodes: [...this.nodes.values()] };
  }

  get(id: string): Node {
    const n = this.nodes.get(id);
    if (!n) throw new GraphError(`node not found: ${id}`, 404);
    return n;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  /** frontier: status が done/dropped/skipped 以外で、parents が全て done または skipped のノード。
   *  「skipped も充足扱い」により、分岐(3.9)で片方の枝が skipped でも合流ノードは着火する
   *  （skipped でない親が全て done、と同値）。skipped 自体はもう通らないと決着済みなので除外する */
  frontier(): Node[] {
    return [...this.nodes.values()].filter(
      (n) =>
        n.status !== "done" &&
        n.status !== "dropped" &&
        n.status !== "skipped" &&
        parentsSatisfied(n.parents, this.nodes),
    );
  }

  /** id とその子孫すべて */
  collectDescendants(id: string): Set<string> {
    return collectDescendantsAmong([...this.nodes.values()], id);
  }

  // ---- 書き込み（すべて操作ログ経由） ----

  addNode(input: NodeInput, meta: OpMeta = {}): Node {
    // Compat: 旧クライアントの impact("safe"|"irreversible") を approval に読み替えて受ける
    const parsed = NodeInputCompatSchema.parse(input);
    this.validateParents(null, parsed.parents);
    this.validateTriggerHasNoParents(parsed.kind, parsed.parents);
    this.validateGroup(null, parsed.group);
    this.validateFolder(null, parsed.folder);
    this.validateBranches(parsed.kind, parsed.branches);
    this.validateParentOptions(parsed.parents, parsed.parentOptions);
    // 決着済みの分岐の「選ばれなかった枝」へ後付けしたノードは最初から skipped にする
    // （decide 時の skip 伝搬はその時点に存在したノードにしか届かないため。放置すると
    // 「親=done の frontier」としてエンジンに誤実行される。docs/design.md 3.9）
    const status =
      (parsed.status === "pending" || parsed.status === "unplanned") &&
      this.isOnLosingBranch(parsed.parentOptions)
        ? "skipped"
        : parsed.status;
    const node: Node = {
      ...parsed,
      status,
      id: nextId("n", this.nodes.keys()),
      pendingRequest: null,
      // 試走記録は新規作成時は必ず未試走（NodeInputSchema には含めない。desk と同じく
      // 「作成時に指定できるものではなく、試走APIだけが書く」フィールド）
      implTrial: null,
      // 作成者はサーバが操作メタから刻む（クライアント入力からは受けない。docs/design.md 3.11）。
      // meta.user（チャットAI経由でも背後の人間）→ human actor の name（=ログインメール）→ null
      createdBy:
        meta.user ?? (meta.actor?.kind === "human" && meta.actor.name ? meta.actor.name : null),
      created: nowIso(),
    };
    this.commit({ op: "node.add", payload: { node } }, meta);
    return node;
  }

  patchNode(id: string, patch: NodePatch, meta: OpMeta = {}): Node {
    const current = this.get(id);
    const parsed = NodePatchCompatSchema.parse(patch);
    assertPatchAllowedWhileFixed(current, parsed, FIXED_PATCH_MESSAGE);
    if (parsed.parents) this.validateParents(id, parsed.parents);
    if (parsed.group !== undefined) this.validateGroup(id, parsed.group ?? null);
    if (parsed.folder !== undefined) this.validateFolder(id, parsed.folder ?? null);
    if (parsed.kind !== undefined || parsed.branches !== undefined) {
      const kind = parsed.kind ?? current.kind;
      const branches = parsed.branches !== undefined ? parsed.branches : current.branches;
      this.validateBranches(kind, branches);
    }
    if (parsed.kind !== undefined || parsed.parents !== undefined) {
      const kind = parsed.kind ?? current.kind;
      const parents = parsed.parents ?? current.parents;
      this.validateTriggerHasNoParents(kind, parents);
    }
    if (parsed.parentOptions !== undefined || parsed.parents !== undefined) {
      const parents = parsed.parents ?? current.parents;
      const parentOptions =
        parsed.parentOptions !== undefined ? parsed.parentOptions : current.parentOptions;
      this.validateParentOptions(parents, parentOptions);
    }
    // 決着済みの分岐の「選ばれなかった枝」上のノードは実行可能な status に入れない（addNode と
    // 同じ理由）。繋ぎ変え（parents/parentOptions 変更）だけでなく status だけの patch も対象
    // ——素通りさせると skipped が pending に戻って frontier に乗り、エンジンに誤実行される。
    // 負けた枝からの復帰は revertDecision（choice を先に取り消す）だけが通る正規ルート
    if (
      parsed.parentOptions !== undefined ||
      parsed.parents !== undefined ||
      parsed.status !== undefined
    ) {
      const parentOptions =
        parsed.parentOptions !== undefined ? parsed.parentOptions : current.parentOptions;
      const nextStatus = parsed.status ?? current.status;
      if (
        (nextStatus === "pending" || nextStatus === "unplanned" || nextStatus === "running") &&
        this.isOnLosingBranch(parentOptions)
      ) {
        parsed.status = "skipped";
      }
    }
    this.commit({ op: "node.patch", payload: { nodeId: id, patch: parsed } }, meta);
    return this.get(id);
  }

  /** parentOptions が「決着済みの分岐（choice確定）で選ばれなかった枝」を1つでも含むか */
  private isOnLosingBranch(parentOptions: Record<string, string>): boolean {
    for (const [decisionId, branchId] of Object.entries(parentOptions)) {
      const d = this.nodes.get(decisionId);
      if (d && d.kind === "decision" && d.choice !== null && d.choice !== branchId) return true;
    }
    return false;
  }

  /**
   * 分岐ノード(kind=decision)の choice を確定する（docs/design.md 3.9）。
   * 1) choice をセット + status を done にする
   * 2) 直接規則: parentOptions[decisionId] を持つ子のうち、choice と不一致な枝は skipped
   * 3) 連鎖規則: 「全ての親」が skipped になったノードも skipped（再帰。done/dropped は触らない）
   * 複数の patch/commit の連続として行う（1つの巨大トランザクションopは持たない。undo は
   * 「1opずつ戻る」ことで整合を保つ設計）。
   */
  applyDecision(nodeId: string, choice: string, meta: OpMeta = {}): Node {
    const node = this.get(nodeId);
    if (node.kind !== "decision") {
      throw new GraphError(`node ${nodeId} is not a decision (kind=${node.kind})`);
    }
    this.validateDecisionGate(node);
    if (!node.branches || !node.branches.some((b) => b.id === choice)) {
      throw new GraphError(`unknown choice: ${choice}`);
    }

    this.patchNode(nodeId, { choice, status: "done" }, meta);

    // 直接規則: このdecisionを親に持ち、選ばれなかった枝の子をskippedにする
    for (const n of [...this.nodes.values()]) {
      if (n.status === "done" || n.status === "dropped" || n.status === "skipped") continue;
      const branchId = n.parentOptions[nodeId];
      if (branchId !== undefined && branchId !== choice) {
        this.patchNode(n.id, { status: "skipped" }, meta);
      }
    }

    this.propagateSkipChain(meta);
    return this.get(nodeId);
  }

  /**
   * まだ実行フェーズに入っていない decision ノードで分岐を選べてしまわないようにするゲート
   * （2026-07-31 追加。「前のノードが終わっていないノードで実行系の操作ができてしまうのは
   * おかしい」）。会話AIとのプラン改善（スレッドへの発言・patch等の編集）はゲートしない —
   * ここで弾くのは choice 確定（applyDecision）だけ。
   * - lifecycle=draft はまだ下書き（実行フェーズは committed が前提）
   * - status が done/skipped/dropped は既に決着済み（選び直しはできない）
   * - frontier でない（parents が全て done|skipped ではない）＝前のノードがまだ終わっていない
   */
  private validateDecisionGate(node: Node): void {
    if (node.lifecycle !== "committed") {
      throw new GraphError(
        "下書き(draft)のノードです。分岐を選ぶ前に確定(committed)してください",
        409,
      );
    }
    if (node.status === "done" || node.status === "skipped" || node.status === "dropped") {
      throw new GraphError("この分岐は既に決着しています", 409);
    }
    if (!parentsSatisfied(node.parents, this.nodes)) {
      throw new GraphError("前のノードが終わっていないため、まだ分岐を選べません", 409);
    }
  }

  /**
   * 分岐の選び直し（手戻り。docs/design.md 3.9）: choice を取り消して pending に戻し、
   * **この決着に由来する skip**（直接・連鎖とも）だけを復元する。復元対象は
   * collectSkipsDerivedFrom が集めた集合に限る——手で見送った skipped や他の決着による
   * skip は「この決着に由来する」ものではないので、走査に混ぜてはいけない。
   * その集合の中で「もはや正当化されないもの」（どの決着済み分岐の負けた枝にも居らず、
   * 全親 skipped でもない）を pending に戻す
   * （親の復元が子の復元を解禁するため不動点まで繰り返す）。
   * 下流で既に done/dropped になった作業は戻さない（やり直しの範囲は人間が判断する）。
   */
  revertDecision(nodeId: string, meta: OpMeta = {}): Node {
    const node = this.get(nodeId);
    if (node.kind !== "decision") {
      throw new GraphError(`node ${nodeId} is not a decision (kind=${node.kind})`);
    }
    if (node.choice === null) {
      throw new GraphError("この分岐はまだ決着していません", 409);
    }
    // choice を消す前に集める（負けた枝の判定に決着時の choice が要る）
    const derived = this.collectSkipsDerivedFrom(nodeId, node.choice);
    this.patchNode(nodeId, { choice: null, status: "pending" }, meta);

    let changed = true;
    while (changed) {
      changed = false;
      for (const id of derived) {
        const n = this.nodes.get(id);
        if (!n || n.status !== "skipped") continue;
        if (this.isOnLosingBranch(n.parentOptions)) continue; // 他の決着済み分岐で正当な skip
        const allSkipped =
          n.parents.length > 0 &&
          n.parents.every((pid) => this.nodes.get(pid)?.status === "skipped");
        if (allSkipped) continue; // 連鎖規則でまだ正当な skip
        this.patchNode(n.id, { status: "pending" }, meta);
        changed = true;
      }
    }
    return this.get(nodeId);
  }

  /** 決着（decisionId を choice で確定したこと）に由来する skipped ノードの集合。
   *  applyDecision の裏返しで、直接規則（この分岐の負けた枝に居る skipped）を種にして、
   *  連鎖規則（全ての親が skipped、かつ少なくとも1つの親がこの決着由来）で不動点まで広げる */
  private collectSkipsDerivedFrom(decisionId: string, choice: string): Set<string> {
    const derived = new Set<string>();
    for (const n of this.nodes.values()) {
      if (n.status !== "skipped") continue;
      const branchId = n.parentOptions[decisionId];
      if (branchId !== undefined && branchId !== choice) derived.add(n.id);
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of this.nodes.values()) {
        if (derived.has(n.id) || n.status !== "skipped") continue;
        if (n.parents.length === 0) continue;
        if (!n.parents.every((pid) => this.nodes.get(pid)?.status === "skipped")) continue;
        if (!n.parents.some((pid) => derived.has(pid))) continue;
        derived.add(n.id);
        grew = true;
      }
    }
    return derived;
  }

  /** 連鎖規則: 全ての親が skipped なノードを skipped にする（不動点まで繰り返す） */
  private propagateSkipChain(meta: OpMeta): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of [...this.nodes.values()]) {
        if (n.status === "done" || n.status === "dropped" || n.status === "skipped") continue;
        if (n.parents.length === 0) continue; // ルートは連鎖規則の対象外（親なし=空配列の空虚な真を避ける）
        const allSkipped = n.parents.every((pid) => this.nodes.get(pid)?.status === "skipped");
        if (allSkipped) {
          this.patchNode(n.id, { status: "skipped" }, meta);
          changed = true;
        }
      }
    }
  }

  /** 既定は安全側: 子（依存の後続）またはメンバー（group で自分を指すノード）を持つ、
   *  もしくは Fix済みのノードは消せない（409/エラー）。
   *  force=true（UI が確認モーダルを通した後に使う。2026-08-01 本人指摘「消せないのは違う。
   *  ロックはモーダルで確認」）なら全部消す:
   *  - Fix済みでも消す（確認は UI の責務）
   *  - メンバー（group で自分＝またはその子孫グループ＝を指すノード）は巻き添えで全削除
   *  - 削除集合の外の子からは parents / parentOptions の参照を切り離す（fixed の子でも
   *    切り離す——これは削除の後始末であって「やり方の変更」ではないため、patchNode の
   *    fixed ガードを通さず直接 commit する） */
  removeNode(id: string, meta: OpMeta = {}, opts: { force?: boolean } = {}): void {
    const node = this.get(id);
    const force = opts.force === true;
    if (!force) {
      if (node.fixed) {
        throw new GraphError(FIXED_REMOVE_MESSAGE, 409);
      }
      const children = [...this.nodes.values()].filter((n) => n.parents.includes(id));
      if (children.length > 0) {
        throw new GraphError(
          `node ${id} has ${children.length} children; remove or reparent them first`,
        );
      }
      const members = [...this.nodes.values()].filter((n) => n.group === id);
      if (members.length > 0) {
        throw new GraphError(
          `node ${id} has ${members.length} members; ungroup or remove them first`,
        );
      }
      this.detachFolderRefs(new Set([id]), meta);
      this.commit({ op: "node.remove", payload: { nodeId: id } }, meta);
      return;
    }

    // 削除集合: 自分 + メンバー（入れ子グループも辿る。不動点まで）
    const toRemove = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of this.nodes.values()) {
        if (n.group !== null && toRemove.has(n.group) && !toRemove.has(n.id)) {
          toRemove.add(n.id);
          grew = true;
        }
      }
    }

    // 集合の外の子から、消えるノードへの参照を切り離す
    for (const n of [...this.nodes.values()]) {
      if (toRemove.has(n.id)) continue;
      const parents = n.parents.filter((p) => !toRemove.has(p));
      const poEntries = Object.entries(n.parentOptions).filter(([d]) => !toRemove.has(d));
      const patch: { parents?: string[]; parentOptions?: Record<string, string> } = {};
      if (parents.length !== n.parents.length) patch.parents = parents;
      if (poEntries.length !== Object.keys(n.parentOptions).length) {
        patch.parentOptions = Object.fromEntries(poEntries);
      }
      if (Object.keys(patch).length > 0) {
        this.commit({ op: "node.patch", payload: { nodeId: n.id, patch } }, meta);
      }
    }

    // 消える一式を folder に持つノード（フォルダを消したときの中のページ）は直下へ出す
    this.detachFolderRefs(toRemove, meta);

    // メンバー → 自分の順で削除（undo は逆順に1opずつ戻るため、グループが先に復活する）
    for (const rid of [...toRemove].filter((x) => x !== id)) {
      this.commit({ op: "node.remove", payload: { nodeId: rid } }, meta);
    }
    this.commit({ op: "node.remove", payload: { nodeId: id } }, meta);
  }

  // ---- 内部 ----

  /** group の検証: 実在すること・包含の循環（自分自身/自分のメンバー子孫）を作らないこと */
  private validateGroup(selfId: string | null, group: string | null): void {
    if (group === null) return;
    if (!this.nodes.has(group)) throw new GraphError(`group not found: ${group}`);
    if (selfId) {
      let cur: string | null = group;
      const seen = new Set<string>();
      while (cur !== null) {
        if (cur === selfId) {
          throw new GraphError(`containment cycle: ${group} is inside ${selfId}`);
        }
        if (seen.has(cur)) break;
        seen.add(cur);
        cur = this.nodes.get(cur)?.group ?? null;
      }
    }
  }

  /** folder の検証（2026-08-05 左レールの整理棚）: 実在すること・相手が kind=folder で
   *  あること・入れ子の循環を作らないこと。group（包含）とは別軸なので検証も別に持つ */
  private validateFolder(selfId: string | null, folder: string | null): void {
    if (folder === null) return;
    const target = this.nodes.get(folder);
    if (!target) throw new GraphError(`folder not found: ${folder}`);
    if (target.kind !== "folder") {
      throw new GraphError(`node ${folder} is not a folder (kind=${target.kind})`);
    }
    if (!selfId) return;
    let cur: string | null = folder;
    const seen = new Set<string>();
    while (cur !== null) {
      if (cur === selfId) {
        throw new GraphError(`folder cycle: ${folder} is inside ${selfId}`);
      }
      if (seen.has(cur)) break;
      seen.add(cur);
      cur = this.nodes.get(cur)?.folder ?? null;
    }
  }

  /** 消えるノードを folder に持つノードから、その参照を外す。フォルダは整理棚なので
   *  **巻き添え削除しない**（中のページは直下へ出るだけ）。patchNode の fixed ガードを
   *  通さず直接 commit するのは parents の切り離しと同じ理由——削除の後始末であって
   *  「やり方の変更」ではないため */
  private detachFolderRefs(removed: Set<string>, meta: OpMeta): void {
    for (const n of [...this.nodes.values()]) {
      if (removed.has(n.id)) continue;
      if (n.folder !== null && removed.has(n.folder)) {
        this.commit({ op: "node.patch", payload: { nodeId: n.id, patch: { folder: null } } }, meta);
      }
    }
  }

  /** kind=decision のノードは branches が最低2個必要（elseなし・単一選択。docs/design.md 3.9）。
   *  それ以外の kind では branches の中身は問わない */
  private validateBranches(kind: Node["kind"], branches: NodeBranch[] | null): void {
    if (kind !== "decision") return;
    if (!branches || branches.length < 2) {
      throw new GraphError("decision ノードには branches が最低2つ必要です");
    }
  }

  /** kind=trigger のノードは parents を持てない（トリガー=グラフの起点=Observable のソース、
   *  という構造を守る。docs/design.md 3.4/3.8 新モデル） */
  private validateTriggerHasNoParents(kind: Node["kind"], parents: string[]): void {
    if (kind === "trigger" && parents.length > 0) {
      throw new GraphError("trigger ノードは parents を持てません");
    }
  }

  /** parentOptions の検証: キーが parents に含まれ、その親が kind=decision であること。
   *  値がその親の branches に存在すること（docs/design.md 3.9） */
  private validateParentOptions(parents: string[], parentOptions: Record<string, string>): void {
    for (const [decisionId, branchId] of Object.entries(parentOptions)) {
      if (!parents.includes(decisionId)) {
        throw new GraphError(`parentOptions のキー ${decisionId} は parents に含まれていません`);
      }
      const decisionNode = this.nodes.get(decisionId);
      if (!decisionNode || decisionNode.kind !== "decision") {
        throw new GraphError(`parentOptions のキー ${decisionId} は decision ノードではありません`);
      }
      if (!decisionNode.branches?.some((b) => b.id === branchId)) {
        throw new GraphError(`parentOptions の値 ${branchId} は ${decisionId} の branches に存在しません`);
      }
    }
  }

  private validateParents(selfId: string | null, parents: string[]): void {
    for (const p of parents) {
      if (!this.nodes.has(p)) throw new GraphError(`parent not found: ${p}`);
    }
    if (selfId) {
      if (parents.includes(selfId)) {
        throw new GraphError("node cannot be its own parent");
      }
      const descendants = this.collectDescendants(selfId);
      for (const p of parents) {
        if (descendants.has(p)) {
          throw new GraphError(`cycle: ${p} is a descendant of ${selfId}`);
        }
      }
    }
  }

  private commit(
    // system（ログの辻褄合わせの印）は通常の操作では立てない＝ここでは受けない
    op: Omit<OpRecord, "id" | "ts" | "actor" | "via" | "system">,
    meta: OpMeta,
    undoes?: string,
  ): void {
    const record: OpRecord = OpRecordSchema.parse({
      id: nextId("op", []) + "-" + Math.random().toString(36).slice(2, 8),
      ts: nowIso(),
      actor: ActorSchema.parse(meta.actor ?? { kind: "human" }),
      via: meta.via ?? "ui",
      ...(undoes ? { undoes } : {}),
      ...op,
    });
    applyRecord(this.nodes, record);
    appendJsonl(this.opsPath, record);
    if (this.mode.kind === "workspace") {
      writeWorkspaceFile(this.mode.canonicalFile, [...this.nodes.values()]);
    } else {
      writeJsonAtomic(path.join(this.mode.dataDir, "snapshot.json"), {
        nodes: [...this.nodes.values()],
      });
    }
  }

  /** ops.jsonl だけから状態を再構築する（snapshot 消失時の復元・整合性テスト用） */
  static replay(dataDir: string): Map<string, Node> {
    const records = readJsonl<OpRecord>(path.join(dataDir, "ops.jsonl"));
    return GraphStore.replayRecords(records);
  }

  /**
   * 操作ログを畳んで状態を作る。
   *
   * **記録が欠けていても止まらない**のが要点: ログに存在しないノードへの patch/remove は
   * 読み飛ばす（apply は not found で throw する）。GraphWrangler を通らずに正データファイルへ
   * 入ったノード（移行データ・外部編集）は add の記録が無く、その後の patch だけがログに載る
   * ——ここで throw すると、そういう実データを持つインスタンスが起動できなくなる
   * （2026-08-08。zinsei が実際にこの形）。
   *
   * until を渡すとその時刻までで畳む。baseline には「add が system 印（reconcileLog の
   * 辻褄合わせ）で足されたノード」の id が入る＝当時の中身は記録が無いという印。
   */
  private static foldRecords(
    records: OpRecord[],
    until?: string,
  ): { nodes: Map<string, Node>; baseline: Set<string> } {
    const nodes = new Map<string, Node>();
    const baseline = new Set<string>();
    for (const raw of records) {
      const r = OpRecordSchema.parse(raw);
      if (until !== undefined && r.ts > until) break;
      if (r.op !== "node.add" && !nodes.has(r.payload.nodeId)) continue;
      applyRecord(nodes, r);
      if (r.op === "node.add") {
        if (r.system) baseline.add(r.payload.node.id);
        else baseline.delete(r.payload.node.id);
      }
    }
    return { nodes, baseline: new Set([...baseline].filter((id) => nodes.has(id))) };
  }

  private static replayRecords(records: OpRecord[]): Map<string, Node> {
    return GraphStore.foldRecords(records).nodes;
  }

  /**
   * 過去のある時刻のグラフを操作ログから再構築する（2026-08-08 本人要望
   * 「その時のノードの状態を見れるように」）。書き込みはしない読み取り専用。
   *
   * 並べ替えは **ts 昇順**（ファイル順ではない）。辻褄合わせの追記（system 印。reconcileLog）は
   * ノードの created 時刻を名乗って末尾に足されるため、ファイル順のまま再生すると
   * 後発の patch を上書きしてしまう。ts で並べれば正しい順に戻る。
   *
   * 戻り値の baseline は「作られた記録がログに無く、辻褄合わせで後から足されたノード」の id。
   * これらは**当時の中身が記録されていない**（足した時点の中身しか無い）ので、
   * 呼び出し側は「当時の記録なし」と断って見せる必要がある。
   */
  nodesAt(ts: string): { nodes: Node[]; baseline: Set<string> } {
    const records = readJsonl<OpRecord>(this.opsPath)
      .map((r) => OpRecordSchema.parse(r))
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const folded = GraphStore.foldRecords(records, ts);
    return { nodes: [...folded.nodes.values()], baseline: folded.baseline };
  }

  /**
   * 操作ログを実態に合わせる（2026-08-08）。GraphWrangler を通らない正データファイルの
   * 書き換え（移行データの流し込み・git pull・他エージェントの直接編集）はログに載らないため、
   * そのままだと nodesAt の再構築が実態からずれる。起動時にこれを呼び、
   * 「いまの状態 vs ログ再生の結果」の差分を system 印の行として**追記だけ**する。
   *
   * 正データファイルには一切書かない（読み取り側の状態も変えない）。追加ノードの ts は
   * node.created を名乗らせる——本当にいつ作られたかはログに無く、created が唯一の手がかりで、
   * これにより過去時刻の再構築でも「その頃から在った」形になる。
   */
  reconcileLog(meta: OpMeta = {}): { added: number; patched: number; removed: number } {
    const existing = readJsonl<OpRecord>(this.opsPath).map((r) => OpRecordSchema.parse(r));
    const result = { added: 0, patched: 0, removed: 0 };
    const pending: OpRecord[] = [];
    const stamp = (ts: string, op: Omit<OpRecord, "id" | "ts" | "actor" | "via" | "system">): OpRecord =>
      OpRecordSchema.parse({
        id: nextId("op", []) + "-" + Math.random().toString(36).slice(2, 8),
        ts,
        actor: ActorSchema.parse(meta.actor ?? { kind: "system" }),
        via: meta.via ?? "external",
        system: true,
        ...op,
      });
    // 評価は nodesAt と同じ **ts 昇順の畳み込み**で行う（ファイル順ではない）。追記する行は
    // 過去の時刻を名乗ることがあるので、ファイル順で見ていると「追記後に何が復元されるか」を
    // 見誤る
    const projected = (): Map<string, Node> =>
      GraphStore.foldRecords(
        [...existing, ...pending].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)),
      ).nodes;

    // 1巡目: 居ないノードを足し、余分なノードを消す
    let folded = projected();
    for (const [id, node] of this.nodes) {
      if (folded.has(id)) continue;
      pending.push(stamp(node.created, { op: "node.add", payload: { node } }));
      result.added += 1;
    }
    for (const id of folded.keys()) {
      if (this.nodes.has(id)) continue;
      pending.push(stamp(nowIso(), { op: "node.remove", payload: { nodeId: id } }));
      result.removed += 1;
    }
    // 2巡目: **1巡目を織り込んだ復元結果**と中身を突き合わせる。過去時刻の add を足したことで、
    // それまで宙に浮いていた古い patch が生き返って別の中身になることがあるため、ここで
    // いまの時刻の patch を当てて実態に寄せる（いまの時刻＝ts 順で最後に効く）
    folded = projected();
    for (const [id, node] of this.nodes) {
      const before = folded.get(id);
      if (!before) continue;
      // patch できるフィールドだけの差分を作る（id/created/createdBy は NodePatchSchema が落とす）。
      // それを当てても変わらない＝直せる差が無いなら追記しない——毎起動で同じ行を積み続けて
      // ログが太る（そして直らない）のを避ける
      const patch = NodePatchSchema.parse(node);
      if (stableStringify({ ...before, ...patch }) !== stableStringify(before)) {
        pending.push(stamp(nowIso(), { op: "node.patch", payload: { nodeId: id, patch } }));
        result.patched += 1;
      }
    }
    for (const r of pending) appendJsonl(this.opsPath, r);
    return result;
  }

  /**
   * 直近の操作を1つ元に戻す。過去行は書き換えず、**逆操作を追記**する
   * （undoes に対象 op の id を刻む）。補償操作（undoes 付き）は undo の対象から
   * 外すので、連続 undo は時系列を遡る。取り消しの取り消しは redoLast。
   */
  undoLast(meta: OpMeta = {}): OpRecord | null {
    // system 印（ログの辻褄合わせ。reconcileLog）は人間の操作ではないので取り消し対象から外す
    return this.compensate(meta, (r, isUndone) => !r.undoes && !r.system && !isUndone(r.id));
  }

  /** 直近の undo を1つやり直す（有効な補償操作を打ち消す = redo） */
  redoLast(meta: OpMeta = {}): OpRecord | null {
    return this.compensate(meta, (r, isUndone) => Boolean(r.undoes) && !isUndone(r.id));
  }

  private compensate(
    meta: OpMeta,
    pick: (r: OpRecord, isUndone: (id: string) => boolean) => boolean,
  ): OpRecord | null {
    const records = readJsonl<OpRecord>(this.opsPath);
    // 「効果的に打ち消されているか」= 自分への補償のうち、それ自身が打ち消されて
    // いないものが1つでもあるか（undo→redo→undo… のチェーンの偶奇を正しく見る）
    const compsOf = new Map<string, OpRecord[]>();
    for (const r of records) {
      const t = (r as { undoes?: string }).undoes;
      if (t) {
        const list = compsOf.get(t) ?? [];
        list.push(r);
        compsOf.set(t, list);
      }
    }
    const memo = new Map<string, boolean>();
    const isUndone = (id: string): boolean => {
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      const result = (compsOf.get(id) ?? []).some((c) => !isUndone(c.id));
      memo.set(id, result);
      return result;
    };
    let targetIndex = -1;
    for (let i = records.length - 1; i >= 0; i--) {
      if (pick(records[i], isUndone)) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex < 0) return null;
    const target = records[targetIndex];
    const before = GraphStore.replayRecords(records.slice(0, targetIndex));

    switch (target.op) {
      case "node.add": {
        const id = target.payload.node.id;
        const children = [...this.nodes.values()].filter((n) => n.parents.includes(id));
        const members = [...this.nodes.values()].filter((n) => n.group === id);
        // フォルダ（kind=folder）は中身を folder 参照で持つ。参照が残ったまま消すと
        // 迷子のページができるので、削除（=add の補償）は同じく拒否する
        const filed = [...this.nodes.values()].filter((n) => n.folder === id);
        if (children.length || members.length || filed.length) {
          throw new GraphError(
            `undo できません: ${id} には後続ノードやメンバーが追加されています`,
            409,
          );
        }
        if (!this.nodes.has(id)) {
          throw new GraphError(`undo できません: ${id} は既に存在しません`, 409);
        }
        // Fix済みノードの削除は補償でも拒否（docs/design.md 3.5 実効化。add の undo = 削除）
        const existing = this.nodes.get(id)!;
        if (existing.fixed) {
          throw new GraphError(FIXED_UNDO_MESSAGE, 409);
        }
        this.commit({ op: "node.remove", payload: { nodeId: id } }, meta, target.id);
        break;
      }
      case "node.patch": {
        const id = target.payload.nodeId;
        const prev = before.get(id);
        const cur = this.nodes.get(id);
        if (!prev || !cur) {
          throw new GraphError(`undo できません: ${id} が現存しません`, 409);
        }
        // patch されたキーだけを、patch 前の値へ戻す
        const inverse: Record<string, unknown> = {};
        for (const key of Object.keys(target.payload.patch)) {
          inverse[key] = (prev as unknown as Record<string, unknown>)[key];
        }
        const inversePatch = NodePatchSchema.parse(inverse);
        // 現在 fixed なノードの「やり方」フィールドを戻す補償は拒否（fixed 自体の付け外しの
        // 戻しだけは許可。docs/design.md 3.5 実効化）
        assertPatchAllowedWhileFixed(cur, inversePatch, FIXED_UNDO_MESSAGE);
        this.commit(
          { op: "node.patch", payload: { nodeId: id, patch: inversePatch } },
          meta,
          target.id,
        );
        break;
      }
      case "node.remove": {
        const id = target.payload.nodeId;
        const prev = before.get(id);
        if (!prev) throw new GraphError(`undo できません: ${id} の削除前の状態が不明です`, 409);
        if (this.nodes.has(id)) {
          throw new GraphError(`undo できません: ${id} は既に再作成されています`, 409);
        }
        // 削除前に fixed だったノードの復活も拒否（現行の removeNode は fixed を消せないため
        // 通常は起こらないが、過去ログ互換のための保険。docs/design.md 3.5 実効化）
        if (prev.fixed) {
          throw new GraphError(FIXED_UNDO_MESSAGE, 409);
        }
        this.commit({ op: "node.add", payload: { node: prev } }, meta, target.id);
        break;
      }
    }
    return target;
  }
}
