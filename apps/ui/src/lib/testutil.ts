// テスト専用の fixture ヘルパ（*.test.ts から共用。アプリ本体からは import しない）。
// Node は必須フィールドが多いので、テストで意味を持つ項目だけ上書きできるようにする。
import type { Node } from "../types";

/** テスト用の Node を作る。id 以外は types.ts の Node に沿った無難な既定値 */
export function makeNode(overrides: Partial<Node> & Pick<Node, "id">): Node {
  return {
    title: overrides.id,
    detail: null,
    impl: null,
    implTrial: null,
    parents: [],
    group: null,
    folder: null,
    folderSection: null,
    order: null,
    kind: "task",
    executor: "human",
    approval: false,
    autonomy: "normal",
    aiModel: null,
    aiEffort: null,
    lifecycle: "committed",
    status: "pending",
    fixed: false,
    pendingRequest: null,
    schedule: null,
    outputs: null,
    branches: null,
    choice: null,
    parentOptions: {},
    createdBy: null,
    assignee: null,
    members: [],
    created: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
