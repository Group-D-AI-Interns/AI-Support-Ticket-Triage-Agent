import type { NextRequest } from "next/server";

const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH"]);

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  if (!allowedMethods.has(request.method)) return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "This method is not supported." } }, { status: 405 });
  const base = process.env.BACKEND_API_URL ?? "http://127.0.0.1:3000";
  let origin: URL;
  try { origin = new URL(base); } catch { return Response.json({ error: { code: "BACKEND_URL_INVALID", message: "Backend API URL is not configured correctly." } }, { status: 503 }); }
  const { path } = await context.params;
  if (!path.length || path.some(part => part === "." || part === "..")) return Response.json({ error: { code: "INVALID_PATH", message: "The API path is invalid." } }, { status: 400 });
  const target = new URL(`/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`, origin);
  const headers = new Headers();
  for (const name of ["authorization", "x-organisation-id", "content-type", "accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const upstream = await fetch(target, { method: request.method, headers, ...(request.method === "GET" ? {} : { body: await request.arrayBuffer() }), cache: "no-store", signal: AbortSignal.timeout(30_000) });
    const responseHeaders = new Headers({
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    });
    for (const name of ["x-request-id", "retry-after", "content-disposition", "content-length", "x-content-type-options"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return Response.json({ error: { code: "BACKEND_UNAVAILABLE", message: "The backend could not be reached." } }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
