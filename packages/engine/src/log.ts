// エンジンのログ出力（stdout に ISO 時刻付きの1行）。全モジュールが同じ体裁で出すための1箇所。
export function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
