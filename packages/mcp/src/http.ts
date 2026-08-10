// GraphWrangler の HTTP API（既定 http://localhost:8770）を薄く叩くクライアント。
// packages/core への依存を持たない自己完結パッケージなので、レスポンスは unknown として扱う。

const baseUrl = (process.env.GRAPHWRANGLER_URL ?? "http://localhost:8770").replace(/\/+$/, "");

/** リクエスト全体の締め切り。ローカルAPIなので通常は瞬時に返る想定 */
const REQUEST_TIMEOUT_MS = 30_000;

/** HTTP API がエラー（4xx/5xx の {error}）を返したときに投げる。MCP ツール側で isError に変換する */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ApiError(
        0,
        `graphwrangler server (${baseUrl}) が ${REQUEST_TIMEOUT_MS / 1000}秒以内に応答しませんでした: ${method} ${path}`,
      );
    }
    // サーバに繋がらない等、fetch自体が失敗したケース
    throw new ApiError(0, `graphwrangler server (${baseUrl}) に接続できません: ${String(err)}`);
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    // JSON でないレスポンス（リバースプロキシのエラーページ等）は裸の SyntaxError にしない
    const contentType = res.headers.get("content-type") ?? "(なし)";
    throw new ApiError(
      res.status,
      `graphwrangler server (${baseUrl}) が JSON でないレスポンスを返しました ` +
        `(HTTP ${res.status}, content-type: ${contentType}): ${text.slice(0, 200)}`,
    );
  }

  if (!res.ok) {
    const message =
      typeof json === "object" && json !== null && "error" in json
        ? String((json as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return json;
}

export function apiGet(path: string): Promise<unknown> {
  return request("GET", path);
}

export function apiPost(path: string, body?: unknown): Promise<unknown> {
  return request("POST", path, body ?? {});
}
