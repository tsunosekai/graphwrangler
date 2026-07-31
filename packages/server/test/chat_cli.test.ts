// chat_cli.ts の stream-json → UIMessageStream(SSE) 変換（emitStreamJsonLine）のユニットテスト。
// --include-partial-messages 有効時の実例（プロンプトに添付されたサンプル行）を模して、
// 1) stream_event からトークン単位で text-start/delta/end が出ること
// 2) 確定済み assistant フルメッセージ行からテキストが再度出ない（二重表示防止）こと
// 3) tool_use/tool_result はフルメッセージ行からのみ出ること
// を検証する。server パッケージには vitest 等が無いため node:test を tsx 経由で直接実行する
// （依存追加をせずに検証できる。packages/server/test/files.test.ts と同じ方針）。
// 実行: `pnpm --filter @graphwrangler/server test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamJsonState, emitStreamJsonLine } from "../src/chat_cli.js";

/** テスト用の最小 ReadableStreamDefaultController スタブ。enqueue された SSE チャンクを
 *  デコードして JSON の配列として集める */
function makeController() {
  const chunks: Record<string, unknown>[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const controller = {
    enqueue(buf: Uint8Array) {
      const text = decoder.decode(buf);
      // sseChunk は "data: {...}\n\n" 形式
      const payload = text.replace(/^data: /, "").trim();
      chunks.push(JSON.parse(payload));
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return { chunks, controller, encoder };
}

test("stream_event でトークン単位の text-start/delta/end が流れる", () => {
  const { chunks, controller, encoder } = makeController();
  const state = createStreamJsonState();

  const lines = [
    '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1"}}}',
    '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"こ"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ん"}}}',
    '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
  ];
  for (const line of lines) emitStreamJsonLine(line, controller, encoder, state);

  assert.deepEqual(chunks, [
    { type: "text-start", id: "msg_1-0" },
    { type: "text-delta", id: "msg_1-0", delta: "こ" },
    { type: "text-delta", id: "msg_1-0", delta: "ん" },
    { type: "text-end", id: "msg_1-0" },
  ]);
});

test("stream_event の thinking ブロックは reasoning-* として流れる", () => {
  const { chunks, controller, encoder } = makeController();
  const state = createStreamJsonState();

  const lines = [
    '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_2"}}}',
    '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"考え中…"}}}',
    '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
  ];
  for (const line of lines) emitStreamJsonLine(line, controller, encoder, state);

  assert.deepEqual(chunks, [
    { type: "reasoning-start", id: "msg_2-0" },
    { type: "reasoning-delta", id: "msg_2-0", delta: "考え中…" },
    { type: "reasoning-end", id: "msg_2-0" },
  ]);
});

test("確定済みassistantメッセージのtextブロックは二重に出さない（partialで流し済み）", () => {
  const { chunks, controller, encoder } = makeController();
  const state = createStreamJsonState();

  const lines = [
    '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_3"}}}',
    '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"こんにちは"}}}',
    '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"こんにちは…"}]}}',
  ];
  for (const line of lines) emitStreamJsonLine(line, controller, encoder, state);

  // stream_eventぶんのtext-start/delta/endのみ。フルメッセージ行からのtextは出ない
  assert.deepEqual(chunks, [
    { type: "text-start", id: "msg_3-0" },
    { type: "text-delta", id: "msg_3-0", delta: "こんにちは" },
    { type: "text-end", id: "msg_3-0" },
  ]);
});

test("tool_use / tool_result はフルメッセージ行からのみ変換される", () => {
  const { chunks, controller, encoder } = makeController();
  const state = createStreamJsonState();

  const lines = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"こんにちは…"},{"type":"tool_use","id":"toolu_x","name":"mcp__graphwrangler__get_state","input":{}}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"ok"}]}}',
  ];
  for (const line of lines) emitStreamJsonLine(line, controller, encoder, state);

  assert.deepEqual(chunks, [
    { type: "tool-input-available", toolCallId: "toolu_x", toolName: "get_state", input: {} },
    { type: "tool-output-available", toolCallId: "toolu_x", output: "ok" },
  ]);
});

test("tool_use の input_json_delta（未追跡のブロック）は無視される", () => {
  const { chunks, controller, encoder } = makeController();
  const state = createStreamJsonState();

  const lines = [
    '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_y","name":"mcp__graphwrangler__get_state"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}}',
    '{"type":"stream_event","event":{"type":"content_block_stop","index":1}}',
  ];
  for (const line of lines) emitStreamJsonLine(line, controller, encoder, state);

  assert.deepEqual(chunks, []);
});

test("system/result 行や壊れた行は無視される", () => {
  const { chunks, controller, encoder } = makeController();
  const state = createStreamJsonState();

  emitStreamJsonLine('{"type":"system","subtype":"init"}', controller, encoder, state);
  emitStreamJsonLine('{"type":"result"}', controller, encoder, state);
  emitStreamJsonLine("not json", controller, encoder, state);
  emitStreamJsonLine("", controller, encoder, state);

  assert.deepEqual(chunks, []);
});
