import { createHash } from "node:crypto";
import type { ModelCallRequest } from "./types.js";

function canonicalize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("model request must contain only finite JSON numbers");
      }
      return JSON.stringify(value);
    case "object": {
      if (seen.has(value)) {
        throw new Error("model request must not contain circular values");
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => canonicalize(item, seen)).join(",")}]`;
        }

        const record = value as Record<string, unknown>;
        const entries = Object.keys(record)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`,
          );
        return `{${entries.join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new Error("model request must be JSON-serializable");
  }
}

export function hashModelCallRequest(request: ModelCallRequest): string {
  const canonical = canonicalize(
    {
      wireApi: request.wireApi,
      model: request.model,
      modelSettings: request.modelSettings,
      body: request.body,
    },
    new WeakSet<object>(),
  );

  return createHash("sha256").update(canonical).digest("hex");
}
