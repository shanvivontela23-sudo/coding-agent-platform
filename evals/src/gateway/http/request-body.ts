export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds configured limit");
    this.name = "RequestBodyTooLargeError";
  }
}

export async function readJsonBodyWithinLimit(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Readonly<Record<string, unknown>>> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive integer");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new RequestBodyTooLargeError();
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}
