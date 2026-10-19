import { isCount, isRecord, type JsonObject } from "./json.js";
import type { UsageReport } from "./protocol.js";

function count(value: unknown): number {
  if (!isCount(value)) throw new Error("usage must contain non-negative integer counts");
  return value;
}

function optionalCount(value: unknown): number {
  return value === null || value === undefined ? 0 : count(value);
}

function details(value: unknown): JsonObject {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) throw new Error("usage details must be an object");
  return value;
}

/**
 * Maps an OpenAI-style usage object to the exchange's meters. Exactly one
 * meter counts each token, so cached input leaves the uncached meter. The
 * raw object goes back unchanged as evidence.
 */
export function usageReport(raw: JsonObject, tokenizerId: string): UsageReport {
  const prompt = count(raw["prompt_tokens"]);
  const output = count(raw["completion_tokens"]);
  const input = details(raw["prompt_tokens_details"]);
  const outputDetails = details(raw["completion_tokens_details"]);
  const cached = optionalCount(input["cached_tokens"]);
  if (cached > prompt) throw new Error("cached input exceeds total input");
  if (optionalCount(outputDetails["reasoning_tokens"]) > 0) {
    throw new Error("the reference does not support reasoning");
  }
  if (optionalCount(input["cache_write_tokens"]) > 0) {
    throw new Error("the reference does not support cache writes");
  }
  return {
    meters: {
      uncached_input: prompt - cached,
      cache_read: cached,
      cache_write_short: 0,
      cache_write_long: 0,
      generation: output,
    },
    tokenizer_id: tokenizerId,
    reasoning_tokens: null,
    raw,
  };
}
