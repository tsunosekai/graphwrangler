// パラメータ宣言の置換（docs/design.md 3.5.1）とランのコンテキスト解決（3.15）。
// 実体は packages/core/src/params.ts（server の試走・core の配線チェックと共用）。
// エンジンの本走（ラン層）だけが context を渡して呼ぶ——context 付きの解決・
// インジェクションガードはラン層のみ。プロジェクト層は context なし＝デフォルト値のみ。
export {
  substituteParams,
  missingParamsReason,
  unsafeContextParamsReason,
  type SubstituteParamsResult,
} from "@graphwrangler/core";
