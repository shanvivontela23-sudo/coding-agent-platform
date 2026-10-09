import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type Context = { readonly params: Promise<{ readonly taskId: string }> };

async function cookieHeader(): Promise<string> {
  const store = await cookies();
  return store.getAll().map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join("; ");
}

async function proxy(path: string, method: "GET" | "POST"): Promise<NextResponse> {
  const cookie = await cookieHeader();
  const response = await fetch(`${apiOrigin}${path}`, { method, headers: cookie ? { cookie } : {}, cache: "no-store" });
  const text = await response.text();
  return new NextResponse(text, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
}

export async function GET(_request: Request, context: Context) {
  const { taskId } = await context.params;
  return await proxy(`/api/tasks/${encodeURIComponent(taskId)}/execution`, "GET");
}

export async function POST(request: Request, context: Context) {
  const { taskId } = await context.params;
  let action: unknown;
  try { action = (await request.json() as { readonly action?: unknown }).action; } catch { action = null; }
  if (action !== "start" && action !== "cancel") return NextResponse.json({ code: "INVALID_ACTION", error: "Invalid implementation action." }, { status: 400 });
  return await proxy(`/api/tasks/${encodeURIComponent(taskId)}/execution/${action}`, "POST");
}
