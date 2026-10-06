import { timingSafeEqual } from "node:crypto";
import type {
  ProtocolExchange,
  ProtocolHarnessIdentity,
  ProtocolTranscript,
} from "./transcript.js";

export type ProtocolRecorderHeaders = Readonly<Record<string, string | undefined>>;

export type ProtocolRecorderRequest = {
  readonly method: string;
  readonly path: string;
  readonly headers: ProtocolRecorderHeaders;
  readonly body: Uint8Array;
};

export type ProtocolRecorderOptions = {
  readonly credential: string;
  readonly harness: ProtocolHarnessIdentity;
  readonly forward: (request: Request) => Promise<Response>;
  readonly clock?: () => number;
};

const secretHeaderNames = new Set([
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

function findHeader(headers: ProtocolRecorderHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function suppliedCredential(headers: ProtocolRecorderHeaders): string | null {
  const authorization = findHeader(headers, "authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const apiKey = findHeader(headers, "x-api-key")?.trim();
  if (bearer && apiKey && !sameSecret(bearer, apiKey)) return null;
  return bearer ?? apiKey ?? null;
}

function sanitizedForwardHeaders(headers: ProtocolRecorderHeaders): Headers {
  const output = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (secretHeaderNames.has(lower) || lower === "host" || lower === "content-length") {
      continue;
    }
    output.set(name, value);
  }
  return output;
}

function safeHeaderNames(headers: ProtocolRecorderHeaders): string[] {
  return Object.entries(headers)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name.toLowerCase())
    .filter((name) => !secretHeaderNames.has(name) && name !== "host" && name !== "content-length")
    .sort();
}

function normalizePath(path: string): string {
  try {
    return new URL(path, "https://recorder.invalid").pathname;
  } catch {
    return path.split("?", 1)[0] ?? path;
  }
}

function parseBodyShape(body: Uint8Array): {
  readonly topLevelFields: readonly string[];
  readonly requestedModel: string | null;
  readonly stream: boolean | null;
} {
  try {
    const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { topLevelFields: [], requestedModel: null, stream: null };
    }
    const object = parsed as Readonly<Record<string, unknown>>;
    return {
      topLevelFields: Object.keys(object).sort(),
      requestedModel: typeof object.model === "string" ? object.model : null,
      stream: typeof object.stream === "boolean" ? object.stream : null,
    };
  } catch {
    return { topLevelFields: [], requestedModel: null, stream: null };
  }
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: { code: "unauthorized", message: "invalid recorder credential" } }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

export class ProtocolRecorder {
  private readonly credential: string;
  private readonly harness: ProtocolHarnessIdentity;
  private readonly forward: (request: Request) => Promise<Response>;
  private readonly clock: () => number;
  private readonly exchanges: ProtocolExchange[] = [];

  constructor(options: ProtocolRecorderOptions) {
    if (!options.credential) throw new Error("protocol recorder credential is required");
    if (!options.harness.name.trim() || !options.harness.version.trim()) {
      throw new Error("protocol recorder harness name and version are required");
    }
    this.credential = options.credential;
    this.harness = { name: options.harness.name, version: options.harness.version };
    this.forward = options.forward;
    this.clock = options.clock ?? Date.now;
  }

  async handle(request: ProtocolRecorderRequest): Promise<Response> {
    const credential = suppliedCredential(request.headers);
    if (!credential || !sameSecret(credential, this.credential)) return unauthorized();

    const shape = parseBodyShape(request.body);
    const headers = sanitizedForwardHeaders(request.headers);
    const init: RequestInit = { method: request.method, headers };
    const upperMethod = request.method.toUpperCase();
    if (upperMethod !== "GET" && upperMethod !== "HEAD") {
      init.body = Buffer.from(request.body);
    }
    const response = await this.forward(
      new Request(new URL(request.path, "https://recorder.invalid"), init),
    );

    this.exchanges.push({
      timestampMs: this.clock(),
      method: upperMethod,
      path: normalizePath(request.path),
      headerNames: safeHeaderNames(request.headers),
      contentType: findHeader(request.headers, "content-type") ?? null,
      topLevelFields: shape.topLevelFields,
      requestedModel: shape.requestedModel,
      stream: shape.stream,
      responseStatus: response.status,
      responseContentType: response.headers.get("content-type"),
    });

    return response;
  }

  transcript(): ProtocolTranscript {
    return {
      schemaVersion: 1,
      harness: { ...this.harness },
      exchanges: this.exchanges.map((exchange) => ({ ...exchange })),
    };
  }
}
