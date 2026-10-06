import { z } from "zod";
import type { HarnessCostEstimator, HarnessDispatchRequest } from "./handler.js";

export type ModelListPrice = {
  readonly inputUsdPerMillionTokens: number;
  readonly outputUsdPerMillionTokens: number;
  readonly defaultMaxOutputTokens: number;
};

export type ModelListPrices = Readonly<Record<string, ModelListPrice>>;

const priceSchema = z.object({
  inputUsdPerMillionTokens: z.number().nonnegative(),
  outputUsdPerMillionTokens: z.number().nonnegative(),
  defaultMaxOutputTokens: z.number().int().positive(),
});

const pricesSchema = z.record(z.string().min(1), priceSchema);

export function parseModelListPrices(value: string): ModelListPrices {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("HARNESS_MODEL_PRICES_JSON must be valid JSON");
  }
  const prices = pricesSchema.parse(parsed);
  if (Object.keys(prices).length === 0) {
    throw new Error("HARNESS_MODEL_PRICES_JSON must contain at least one model");
  }
  return prices;
}

function requestedOutputLimit(
  request: HarnessDispatchRequest,
  price: ModelListPrice,
): number {
  for (const field of ["max_output_tokens", "max_tokens"] as const) {
    const value = request.body[field];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      return value;
    }
  }
  return price.defaultMaxOutputTokens;
}

export function createListPriceCostEstimator(
  prices: ModelListPrices,
): HarnessCostEstimator {
  return async (request) => {
    const price = prices[request.model];
    if (!price) throw new Error(`no list price configured for model ${request.model}`);

    // Reserve one uncached input token per UTF-8 request byte. This is intentionally
    // conservative and provider-tokenizer-independent for the pre-dispatch guard.
    // Authoritative usage and money are still reconciled from LiteLLM afterward.
    const reservedInputTokens = Buffer.byteLength(JSON.stringify(request.body), "utf8");
    const reservedOutputTokens = requestedOutputLimit(request, price);
    return (
      reservedInputTokens * price.inputUsdPerMillionTokens +
      reservedOutputTokens * price.outputUsdPerMillionTokens
    ) / 1_000_000;
  };
}
