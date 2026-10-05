import type { ModelUsage, ModelWireApi } from "./types.js";

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asNonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

export function normalizeModelUsage(
  wireApi: ModelWireApi,
  body: Readonly<Record<string, unknown>>,
): ModelUsage {
  const usage = asObject(body.usage);

  if (wireApi === "anthropic-messages") {
    const uncachedInputTokens = asNonnegativeInteger(usage.input_tokens);
    const cachedInputTokens = asNonnegativeInteger(
      usage.cache_read_input_tokens,
    );
    const cacheWriteInputTokens = asNonnegativeInteger(
      usage.cache_creation_input_tokens,
    );
    const outputDetails = asObject(usage.output_tokens_details);

    return {
      inputTokens:
        uncachedInputTokens + cachedInputTokens + cacheWriteInputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens: asNonnegativeInteger(usage.output_tokens),
      reasoningTokens: asNonnegativeInteger(outputDetails.reasoning_tokens),
    };
  }

  const inputDetails = asObject(
    wireApi === "chat-completions"
      ? usage.prompt_tokens_details
      : usage.input_tokens_details,
  );
  const outputDetails = asObject(
    wireApi === "chat-completions"
      ? usage.completion_tokens_details
      : usage.output_tokens_details,
  );

  return {
    inputTokens: asNonnegativeInteger(
      wireApi === "chat-completions"
        ? usage.prompt_tokens
        : usage.input_tokens,
    ),
    cachedInputTokens: asNonnegativeInteger(inputDetails.cached_tokens),
    cacheWriteInputTokens: 0,
    outputTokens: asNonnegativeInteger(
      wireApi === "chat-completions"
        ? usage.completion_tokens
        : usage.output_tokens,
    ),
    reasoningTokens: asNonnegativeInteger(outputDetails.reasoning_tokens),
  };
}

export const emptyModelUsage: ModelUsage = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});
