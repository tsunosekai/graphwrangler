// ランのコンテキスト（docs/design.md 3.15）の共通部品のユニットテスト:
// ##gw マーカー行の抽出（実行時の書き）と GW_* 環境変数の組み立て（実行時の読み）。
import { describe, expect, it } from "vitest";
import {
  buildContextEnv,
  coerceStringRecord,
  extractGwMarkers,
  paramEnvName,
} from "../src/context.js";

describe("extractGwMarkers", () => {
  it("マーカーが無ければ本文そのまま・set は空", () => {
    const r = extractGwMarkers("処理しました\n結果: OK");
    expect(r).toEqual({ body: "処理しました\n結果: OK", set: {}, validCount: 0, invalidLines: [] });
  });

  it('##gw {"set":{...}} 行を抽出し、本文から取り除く', () => {
    const r = extractGwMarkers('処理しました\n##gw {"set":{"remix":"RMX-0231"}}\n完了');
    expect(r.set).toEqual({ remix: "RMX-0231" });
    expect(r.validCount).toBe(1);
    expect(r.body).toBe("処理しました\n完了");
    expect(r.invalidLines).toEqual([]);
  });

  it("複数マーカーは出現順に merge（同一キーは last-write-wins）", () => {
    const r = extractGwMarkers('##gw {"set":{"a":"1","b":"x"}}\n##gw {"set":{"a":"2"}}');
    expect(r.set).toEqual({ a: "2", b: "x" });
    expect(r.validCount).toBe(2);
    expect(r.body).toBe("");
  });

  it("数値・真偽値は文字列化して受け入れる（スクリプトの emit を弾かない）", () => {
    const r = extractGwMarkers('##gw {"set":{"count":3,"done":true}}');
    expect(r.set).toEqual({ count: "3", done: "true" });
  });

  it("'{' で始まるのに JSON として読めない行は invalidLines に入り、本文からも消える", () => {
    const r = extractGwMarkers('前\n##gw {"set": 壊れてる\n後');
    expect(r.set).toEqual({});
    expect(r.invalidLines).toEqual(['##gw {"set": 壊れてる']);
    expect(r.body).toBe("前\n後");
  });

  it("JSON としては読めるが set の形でない行も invalidLines", () => {
    const r = extractGwMarkers('##gw {"put":{"a":"1"}}\n##gw {"set":{"a":[1]}}');
    expect(r.set).toEqual({});
    expect(r.invalidLines).toHaveLength(2);
  });

  it("##gw の後が '{' で始まらない行は普通のログとして本文に残す", () => {
    const r = extractGwMarkers("##gw というマーカーの説明");
    expect(r.body).toBe("##gw というマーカーの説明");
    expect(r.invalidLines).toEqual([]);
  });

  it("行頭以外にある ##gw はマーカーとして扱わない（行全体がマーカーの形のみ）", () => {
    const text = 'ログ: ##gw {"set":{"a":"1"}}';
    const r = extractGwMarkers(text);
    expect(r.set).toEqual({});
    expect(r.body).toBe(text);
  });

  it("CRLF の出力（Windows のスクリプト）も行分割できる", () => {
    const r = extractGwMarkers('結果\r\n##gw {"set":{"a":"1"}}\r\n完了');
    expect(r.set).toEqual({ a: "1" });
    expect(r.body).toBe("結果\n完了");
  });
});

describe("coerceStringRecord", () => {
  it("文字列レコードはそのまま、数値・真偽値は文字列化", () => {
    expect(coerceStringRecord({ a: "1", b: 2, c: false })).toEqual({ a: "1", b: "2", c: "false" });
  });

  it("配列・null・入れ子オブジェクト値は不正（null）", () => {
    expect(coerceStringRecord(null)).toBeNull();
    expect(coerceStringRecord([])).toBeNull();
    expect(coerceStringRecord({ a: { b: 1 } })).toBeNull();
    expect(coerceStringRecord({ a: null })).toBeNull();
  });
});

describe("paramEnvName", () => {
  it("大文字化し英数以外を _ にする", () => {
    expect(paramEnvName("remix")).toBe("GW_PARAM_REMIX");
    expect(paramEnvName("remix-id")).toBe("GW_PARAM_REMIX_ID");
    expect(paramEnvName("foo.bar 1")).toBe("GW_PARAM_FOO_BAR_1");
  });
});

describe("buildContextEnv", () => {
  it("GW_RUN_ID / GW_CONTEXT（全体のJSON）を必ず含む", () => {
    const env = buildContextEnv("r-1", { a: "1" }, null, null);
    expect(env.GW_RUN_ID).toBe("r-1");
    expect(JSON.parse(env.GW_CONTEXT)).toEqual({ a: "1" });
    expect(env.GW_RUN_DIR).toBeUndefined();
  });

  it("runDir があれば GW_RUN_DIR を含む（ワークスペースモードのみ）", () => {
    const env = buildContextEnv("r-1", {}, null, "/ws/.graphwrangler/runfiles/r-1");
    expect(env.GW_RUN_DIR).toBe("/ws/.graphwrangler/runfiles/r-1");
  });

  it("GW_PARAM_* はデフォルト値 → context の順で重ねる（context 優先の解決順を再現）", () => {
    const env = buildContextEnv(
      "r-1",
      { target: "ctx" },
      [
        { name: "target", value: "default" },
        { name: "other", value: "o" },
      ],
      null,
    );
    expect(env.GW_PARAM_TARGET).toBe("ctx");
    expect(env.GW_PARAM_OTHER).toBe("o");
  });

  it("コマンドで参照されない context キーも GW_PARAM_* に入る（ガードに掛かった値の逃げ道）", () => {
    const env = buildContextEnv("r-1", { "memo-text": "a;b|c" }, null, null);
    expect(env.GW_PARAM_MEMO_TEXT).toBe("a;b|c");
  });

  it("value 未入力の宣言は GW_PARAM_* に入れない", () => {
    const env = buildContextEnv("r-1", {}, [{ name: "target", value: null }], null);
    expect(env.GW_PARAM_TARGET).toBeUndefined();
  });
});
