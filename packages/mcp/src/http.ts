// GraphWrangler の HTTP API（既定 http://localhost:8770）を薄く叩くクライアント。
// packages/core への依存を持たない自己完結パッケージなので、レスポンスは unknown として扱う。

const baseUrl = (process.env.GRAPHWRANGLER_URL ?? "http://localhost:8770").replace(/\/+$/, "");

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
    });
  } catch (err) {
    // サーバに繋がらない等、fetch自体が失敗したケース
    throw new ApiError(0, `graphwrangler server (${baseUrl}) に接続できません: ${String(err)}`);
  }

  const text = await res.text();
  const json = text.length > 0 ? JSON.parse(text) : {};

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
