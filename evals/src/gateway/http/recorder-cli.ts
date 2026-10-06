import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { ProtocolRecorder, type ProtocolRecorderHeaders } from "./protocol-recorder.js";
import { writeProtocolTranscript } from "./transcript.js";

const maxRecorderBodyBytes = 8 * 1024 * 1024;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positivePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error("PROTOCOL_RECORDER_PORT must be a valid TCP port");
  }
  return parsed;
}

function requestHeaders(headers: IncomingHttpHeaders): ProtocolRecorderHeaders {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name] = value;
    else if (Array.isArray(value)) result[name] = value.join(", ");
  }
  return result;
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > maxRecorderBodyBytes) throw new Error("recorder request body exceeds 8 MiB");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function copyResponseHeaders(response: Response, target: ServerResponse): void {
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === "content-length") continue;
    target.setHeader(name, value);
  }
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  copyResponseHeaders(response, target);
  if (!response.body) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!target.write(Buffer.from(next.value))) {
        await new Promise<void>((resolveDrain) => target.once("drain", resolveDrain));
      }
    }
    target.end();
  } finally {
    reader.releaseLock();
  }
}

function safeFileSegment(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "harness";
}

function normalizedUpstream(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("PROTOCOL_RECORDER_UPSTREAM_URL must use HTTPS outside loopback");
  }
  return url;
}

async function runProtocolRecorderCli(): Promise<void> {
  const credential = requiredEnv("PROTOCOL_RECORDER_CREDENTIAL");
  const upstreamToken = requiredEnv("PROTOCOL_RECORDER_UPSTREAM_TOKEN");
  const upstream = normalizedUpstream(requiredEnv("PROTOCOL_RECORDER_UPSTREAM_URL"));
  const harnessName = requiredEnv("PROTOCOL_HARNESS_NAME");
  const harnessVersion = requiredEnv("PROTOCOL_HARNESS_VERSION");
  const port = positivePort(process.env.PROTOCOL_RECORDER_PORT, 8788);
  const transcriptPath = resolve(
    process.env.PROTOCOL_TRANSCRIPT_PATH?.trim() ||
      `evals/results/protocol/${safeFileSegment(harnessName)}-${safeFileSegment(harnessVersion)}.json`,
  );

  const recorder = new ProtocolRecorder({
    credential,
    harness: { name: harnessName, version: harnessVersion },
    forward: async (request) => {
      const source = new URL(request.url);
      const target = new URL(`${source.pathname}${source.search}`, upstream);
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${upstreamToken}`);
      const init: RequestInit = {
        method: request.method,
        headers,
        redirect: "manual",
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = Buffer.from(await request.arrayBuffer());
      }
      return await fetch(target, init);
    },
  });

  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const recordedResponse = await recorder.handle({
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: requestHeaders(request.headers),
        body,
      });
      const evidence = await writeProtocolTranscript(transcriptPath, recorder.transcript());
      console.error(`protocol transcript updated: ${evidence.path} sha256=${evidence.sha256}`);
      await writeResponse(recordedResponse, response);
    } catch {
      if (!response.headersSent) {
        response.statusCode = 502;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ error: { code: "recorder_error", message: "protocol recorder request failed" } }),
        );
      } else {
        response.destroy();
      }
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  console.error(`protocol recorder listening on 127.0.0.1:${port}`);

  const shutdown = () => server.close();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void runProtocolRecorderCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "protocol recorder failed";
  console.error(message);
  process.exitCode = 1;
});
