// プレースホルダの未入力チェック（lib/params.ts）のテスト。正規表現は
// core の PARAM_PLACEHOLDER_RE と同じ規約（**変えたら両方直す**）なので、
// packages/core/test/params.test.ts の規約ケース（$ 直前の {} 除外・名前規則）を
// UI 側の窓口でもなぞって、規約ずれをここで検出できるようにする。
import { describe, expect, it } from "vitest";
import type { ScriptParam } from "../types";
import { missingParamNames } from "./params";

const declared = (name: string, value?: string | null): ScriptParam => ({ name, value });

describe("missingParamNames", () => {
  it("プレースホルダが無ければ空配列（試走可能）", () => {
    expect(missingParamNames("echo hello", [])).toEqual([]);
  });

  it("宣言があって value 入力済みなら missing にならない", () => {
    expect(missingParamNames("cp {src} {dest}", [declared("src", "a"), declared("dest", "b")])).toEqual([]);
  });

  it("宣言なしのプレースホルダは missing", () => {
    expect(missingParamNames("cp {src} {dest}", [declared("src", "a")])).toEqual(["dest"]);
  });

  it("宣言があっても value が null / 空文字なら missing", () => {
    expect(missingParamNames("run {a} {b}", [declared("a", null), declared("b", "")])).toEqual([
      "a",
      "b",
    ]);
  });

  it("params が null / undefined でもプレースホルダぶんを missing にする", () => {
    expect(missingParamNames("run {x}", null)).toEqual(["x"]);
    expect(missingParamNames("run {x}", undefined)).toEqual(["x"]);
  });

  it("同じ名前は出現順・重複なし", () => {
    expect(missingParamNames("cp {src} {dest} && echo {src}", [])).toEqual(["src", "dest"]);
  });

  it("シェルの ${HOME} 等の変数展開はプレースホルダではない（$ 直前の {} は除外）", () => {
    expect(missingParamNames("echo ${HOME}/${USER_DIR}", [])).toEqual([]);
  });

  it("$ 付き展開と本物のプレースホルダの混在では後者だけ拾う", () => {
    expect(missingParamNames("tar cf ${HOME}/backup.tar {target}", [])).toEqual(["target"]);
  });

  it("名前規則（英数字とアンダースコア、先頭は英字か _）に合わない {} は無視される", () => {
    expect(missingParamNames("awk '{print $1}' input.txt", [])).toEqual([]);
    expect(missingParamNames("run {1st} {a-b} {} {対象}", [])).toEqual([]);
    expect(missingParamNames("run {a1} {_x} {A_B}", [])).toEqual(["a1", "_x", "A_B"]);
  });
});
