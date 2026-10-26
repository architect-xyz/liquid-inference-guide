import { isRecord, type JsonObject } from "./json.js";

/** Frames the agent sends on the session. */
export interface LoginFrame {
  type: "login";
  slug: string;
  api_key: string;
  dispatch_url: string;
  capabilities: string[];
}

export interface QuoteFrame {
  type: "quote";
  target: { kind: "registered"; model_id: string };
  execution_ref: string;
  execution_limits: { max_input_tokens: number; max_output_tokens: number | null };
  /** A chat quote carries the three token rates. A media quote carries one unit rate instead. */
  rate_uncached_input?: number;
  rate_cache_read?: number;
  rate_generation?: number;
  rate_per_image?: number;
  rate_per_character?: number;
  rate_per_video_second?: number;
  fixed_fee: number;
  service_class: { ttft_ms: number; completion_ms: number };
  supported_features: string[];
  retention_policy_supported: RetentionPolicy[];
  valid_for_ms: number;
  revision: number;
}

export interface WithdrawQuoteFrame {
  type: "withdraw_quote";
  target: { kind: "registered"; model_id: string };
}

export type AgentFrame =
  | LoginFrame
  | QuoteFrame
  | WithdrawQuoteFrame
  | { type: "mass_withdraw" }
  | { type: "heartbeat" };

export type RetentionPolicy = "none" | "allowed";

/** One entry of the `listed` frame, reduced to the fields the reference reads. */
export interface ListedModel {
  modelId: string;
  deploymentName: string;
  model: string;
  tokenizerId: string;
  maxInputTokens: number;
  maxOutputTokens: number | null;
  /** The kind that the exchange lists, `chat` when it states none. */
  kind: string;
  pricingUnit: string | undefined;
}

export interface QuoteAckFrame {
  type: "quote_ack";
  offer_id: string;
  revision: number;
  valid_for_ms: number | undefined;
  fields: JsonObject;
}

export interface QuoteRejectFrame {
  type: "quote_reject";
  code: string | undefined;
  fields: JsonObject;
}

export interface AwardNoticeFrame {
  type: "award_notice";
  award_id: string;
  job_id: string;
  offer_id: string;
  served_model: string;
  max_output_tokens: number;
}

/** Frames the exchange sends on the session. Unknown types are ignored. */
export type ExchangeFrame =
  | { type: "login_ack"; provider_id: string; slug: string | undefined }
  | { type: "login_reject"; reason: string | undefined }
  | { type: "listed"; models: ListedModel[] }
  | QuoteAckFrame
  | QuoteRejectFrame
  | AwardNoticeFrame
  | { type: "settlement_notice"; award_id: string; fields: JsonObject }
  | { type: "risk_notice"; severity: string | undefined; message: string | undefined }
  | { type: "heartbeat" }
  | { type: "handover" }
  | { type: "superseded" }
  | { type: "unknown"; kind: string };

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function without(frame: JsonObject, key: string): JsonObject {
  const rest: JsonObject = {};
  for (const [name, value] of Object.entries(frame)) {
    if (name !== key) rest[name] = value;
  }
  return rest;
}

function parseListedModel(value: unknown): ListedModel | undefined {
  if (!isRecord(value)) return undefined;
  const modelId = str(value["model_id"]);
  const model = str(value["model"]);
  const tokenizerId = str(value["tokenizer_id"]);
  const maxInputTokens = int(value["max_input_tokens"]);
  // The wire docs show `model_deployment` ("handle/name"); the frame types
  // and the Python reference use `deployment_name`. Accept both.
  const deployment = str(value["deployment_name"]);
  const qualified = str(value["model_deployment"]);
  const deploymentName = deployment ?? qualified?.slice(qualified.indexOf("/") + 1);
  if (
    modelId === undefined ||
    model === undefined ||
    tokenizerId === undefined ||
    maxInputTokens === undefined ||
    deploymentName === undefined
  ) {
    return undefined;
  }
  const rawOutput = value["max_output_tokens"];
  const maxOutputTokens = rawOutput === null || rawOutput === undefined ? null : int(rawOutput);
  if (maxOutputTokens === undefined) return undefined;
  const kind = str(value["kind"]) ?? "chat";
  return {
    modelId,
    deploymentName,
    model,
    tokenizerId,
    maxInputTokens,
    maxOutputTokens,
    kind,
    pricingUnit: str(value["pricing_unit"]),
  };
}

/** Parses one text frame. Returns undefined when it is not a JSON object with a string `type`. */
export function parseExchangeFrame(text: string): ExchangeFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const kind = str(value["type"]);
  if (kind === undefined) return undefined;
  switch (kind) {
    case "login_ack": {
      const providerId = str(value["provider_id"]);
      if (providerId === undefined) return undefined;
      return { type: kind, provider_id: providerId, slug: str(value["slug"]) };
    }
    case "login_reject":
      return { type: kind, reason: str(value["reason"]) };
    case "listed": {
      const models = value["models"];
      if (!Array.isArray(models)) return undefined;
      const parsed: ListedModel[] = [];
      for (const entry of models as unknown[]) {
        const model = parseListedModel(entry);
        if (model !== undefined) parsed.push(model);
      }
      return { type: kind, models: parsed };
    }
    case "quote_ack": {
      const offerId = str(value["offer_id"]);
      const revision = int(value["revision"]);
      if (offerId === undefined || revision === undefined) return undefined;
      return {
        type: kind,
        offer_id: offerId,
        revision,
        valid_for_ms: int(value["valid_for_ms"]),
        fields: without(value, "type"),
      };
    }
    case "quote_reject":
      return { type: kind, code: str(value["code"]), fields: without(value, "type") };
    case "award_notice": {
      const awardId = str(value["award_id"]);
      const jobId = str(value["job_id"]);
      const offerId = str(value["offer_id"]);
      const served = str(value["served_model"]);
      const max = int(value["max_output_tokens"]);
      if (
        awardId === undefined ||
        jobId === undefined ||
        offerId === undefined ||
        served === undefined ||
        max === undefined
      ) {
        return undefined;
      }
      return {
        type: kind,
        award_id: awardId,
        job_id: jobId,
        offer_id: offerId,
        served_model: served,
        max_output_tokens: max,
      };
    }
    case "settlement_notice": {
      const awardId = str(value["award_id"]);
      if (awardId === undefined) return undefined;
      return { type: kind, award_id: awardId, fields: without(value, "type") };
    }
    case "risk_notice":
      return { type: kind, severity: str(value["severity"]), message: str(value["message"]) };
    case "heartbeat":
    case "handover":
    case "superseded":
      return { type: kind };
    default:
      return { type: "unknown", kind };
  }
}

/** The events the agent streams back from a dispatch, one JSON object per line. */
export interface Meters {
  uncached_input: number;
  cache_read: number;
  cache_write_short: number;
  cache_write_long: number;
  generation: number;
}

export interface UsageReport {
  meters: Meters;
  tokenizer_id: string;
  reasoning_tokens: number | null;
  raw: JsonObject;
}

/** The unit that a media deployment is priced in. */
export type MediaMeters = { images: number } | { characters: number } | { video_seconds: number };

export interface MediaUsage {
  meters: MediaMeters;
  tokenizer_id: string;
  raw: JsonObject;
}

export type DispatchEvent =
  | { type: "delta"; text: string }
  | { type: "done"; finish_reason: "stop" | "length" | "content_filter"; usage: UsageReport }
  | { type: "done"; finish_reason: "stop"; usage: MediaUsage }
  | { type: "image"; index: number; b64_json?: string; url?: string; mime: string }
  | { type: "audio"; b64_audio: string; mime: string }
  | { type: "video_ready"; handle: string; token: string; mime: string; bytes?: number; expires_at?: string }
  | { type: "failed"; code: string; message: string };
