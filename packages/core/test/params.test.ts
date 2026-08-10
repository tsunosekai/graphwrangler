// パラメータのプレースホルダ規約（docs/design.md 3.5.1 / 3.15）の正本テスト。
// 置換（substituteParams）と参照抽出（referencedParamNames）は core/src/params.ts の
// 同じ正規表現を共有する——ここではその規約そのもの（何がプレースホルダで何が違うか）を固める。
// 置換・解決順・インジェクションガードの網羅は engine/server 側のテストが
// re-export 経由で担う（利用側の窓口が壊れていないことの検証を兼ねるため残している）。
import { describe, expect, it } from "vitest";
import { referencedParamNames, substituteParams } from "../src/params.js";

describe("referencedParamNames（プレースホルダ規約）", () => {
  it("{name} 参照を出現順・重複なしで抜き出す", () => {
    expect(referencedParamNames("cp {src} {dest} && echo {src}")).toEqual(["src", "dest"]);
  });

  it("名前は英数字とアンダースコア（先頭は英字か _）のみ", () => {
    expect(referencedParamNames("run {a1} {_x} {A_B}")).toEqual(["a1", "_x", "A_B"]);
  });

  it("シェルの ${HOME} 等の変数展開はプレースホルダではない（$ 直前の {} は除外）", () => {
    expect(referencedParamNames('echo ${HOME}/${USER_DIR}')).toEqual([]);
  });

  it("awk のアクションブロックはプレースホルダではない（名前規則に合わない）", () => {
    expect(referencedParamNames("awk '{print $1}' input.txt")).toEqual([]);
    expect(referencedParamNames('jq "{a: .b}" data.json')).toEqual([]);
  });

  it("名前規則に合わない {} は無視される（数字始まり・記号・空・非ASCII）", () => {
    expect(referencedParamNames("run {1st} {a-b} {} {対象}")).toEqual([]);
  });

  it("$ 付き展開と本物のプレースホルダの混在では後者だけ拾う", () => {
    expect(referencedParamNames('tar cf ${HOME}/backup.tar {target}')).toEqual(["target"]);
  });

  it("連続で呼んでも結果が変わらない（g フラグの lastIndex を共有しない）", () => {
    expect(referencedParamNames("echo {a}")).toEqual(["a"]);
    expect(referencedParamNames("echo {a}")).toEqual(["a"]);
  });
});

describe("substituteParams（プレースホルダ規約の適用）", () => {
  it("${HOME} はそのまま残し、missing にも数えない", () => {
    expect(substituteParams('echo ${HOME}', [])).toEqual({
      ok: true,
      command: 'echo ${HOME}',
      resolved: {},
    });
  });

  it("awk '{print $1}' を含むコマンドが実行拒否にならない", () => {
    expect(substituteParams("awk '{print $1}' {file}", [{ name: "file", value: "in.txt" }])).toEqual({
      ok: true,
      command: "awk '{print $1}' \"in.txt\"",
      resolved: { file: "in.txt" },
    });
  });

  it("$ 付き展開とプレースホルダの混在: プレースホルダだけが置換される", () => {
    expect(
      substituteParams('cp {src} ${BACKUP_DIR}/', [{ name: "src", value: "a.txt" }]),
    ).toEqual({
      ok: true,
      command: 'cp "a.txt" ${BACKUP_DIR}/',
      resolved: { src: "a.txt" },
    });
  });
});
