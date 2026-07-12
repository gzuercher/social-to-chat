import { request } from "undici";

export interface HttpResponse {
  statusCode: number;
  body: string;
}

/** Dünner Wrapper um undici für die REST-Aufrufe der Plattform-APIs. */
export async function httpJson(
  url: string,
  init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown } = {},
): Promise<HttpResponse> {
  const res = await request(url, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.body.text();
  return { statusCode: res.statusCode, body };
}
