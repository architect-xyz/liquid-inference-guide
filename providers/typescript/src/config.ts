import type { RetentionPolicy } from "./protocol.js";

export const KINDS = ["chat", "image_generation", "audio_speech", "video_generation"] as const;

export type DeploymentKind = (typeof KINDS)[number];

export type MediaKind = Exclude<DeploymentKind, "chat">;

/** The rate that each media kind quotes, the quote field that carries it, and the time in which the kind commits to finish a job. */
export const MEDIA: Readonly<Record<MediaKind, { rate: string; field: string; completionMs: number }>> = {
  image_generation: { rate: "RATE_PER_IMAGE", field: "rate_per_image", completionMs: 90_000 },
  audio_speech: { rate: "RATE_PER_CHARACTER", field: "rate_per_character", completionMs: 30_000 },
  video_generation: {
    rate: "RATE_PER_VIDEO_SECOND",
    field: "rate_per_video_second",
    completionMs: 300_000,
  },
};

export interface Settings {
  exchangeUrl: string;
  slug: string;
  providerKey: string;
  deploymentName: string;
  dispatchHost: string;
  dispatchPort: number;
  dispatchUrl: string;
  upstreamUrl: string;
  upstreamKey: string;
  /** USD per million tokens, passed through to the quote as JSON numbers. */
  rateInput: number;
  rateCacheRead: number;
  rateOutput: number;
  kind: DeploymentKind;
  /** USD per unit of the deployment's kind. A chat deployment uses the token rates. */
  unitRate: number;
  /** The time in which a media job commits to finish. Chat quotes its own deadlines. */
  completionMs: number;
  /** Signs the handles of finished videos. Empty unless the deployment is a video deployment. */
  contentKey: string;
  pollMs: number;
  renderTimeoutMs: number;
  retention: RetentionPolicy;
  journalPath: string;
  quoteLifetimeMs: number;
  upstreamTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export class ConfigError extends Error {}

type Env = Readonly<Record<string, string | undefined>>;

function httpUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an HTTP URL without credentials`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname === "" ||
    parsed.username !== ""
  ) {
    throw new ConfigError(`${name} must be an HTTP URL without credentials`);
  }
  return value;
}

export function settingsFromEnv(env: Env): Settings {
  const required = (name: string): string => {
    const value = (env[`LIQUID_${name}`] ?? "").trim();
    if (value === "") throw new ConfigError(`LIQUID_${name} is required`);
    return value;
  };
  const rate = (name: string): number => {
    const text = required(name);
    if (!/^\d+(\.\d{1,9})?$/.test(text)) {
      throw new ConfigError(
        `LIQUID_${name} must be non-negative with at most nine decimal places`,
      );
    }
    return Number(text);
  };
  const whole = (name: string, fallback: string, max: number): number => {
    const text = (env[`LIQUID_${name}`] ?? fallback).trim();
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0 || value > max) {
      throw new ConfigError(`LIQUID_${name} must be between 1 and ${max}`);
    }
    return value;
  };

  const seconds = (name: string, fallback: string): number => {
    const value = Number((env[`LIQUID_${name}`] ?? fallback).trim());
    if (!(value > 0 && value <= 3600)) {
      throw new ConfigError(`LIQUID_${name} must be between zero and 3600 seconds`);
    }
    return value * 1000;
  };

  const kind = (env["LIQUID_DEPLOYMENT_KIND"] ?? "").trim() || "chat";
  if (!(KINDS as readonly string[]).includes(kind)) {
    throw new ConfigError(`LIQUID_DEPLOYMENT_KIND must be one of ${KINDS.join(", ")}`);
  }
  const media = kind === "chat" ? undefined : MEDIA[kind as MediaKind];
  const contentKey = (env["LIQUID_CONTENT_KEY"] ?? "").trim();
  if (kind === "video_generation" && contentKey === "") {
    throw new ConfigError("LIQUID_CONTENT_KEY is required for a video deployment");
  }
  const exchangeUrl = httpUrl("LIQUID_EXCHANGE_URL", required("EXCHANGE_URL")).replace(/\/+$/, "");
  const upstreamUrl = httpUrl("LIQUID_UPSTREAM_BASE_URL", required("UPSTREAM_BASE_URL")).replace(
    /\/+$/,
    "",
  );
  const dispatchUrl = httpUrl("LIQUID_DISPATCH_URL", required("DISPATCH_URL"));
  const retention = required("RETENTION_POLICY");
  if (retention !== "none" && retention !== "allowed") {
    throw new ConfigError("LIQUID_RETENTION_POLICY must be none or allowed");
  }
  const bind = required("DISPATCH_BIND");
  const split = bind.lastIndexOf(":");
  const dispatchHost = bind.slice(0, split).replace(/^\[|\]$/g, "");
  const portText = bind.slice(split + 1);
  const dispatchPort = Number(portText);
  if (split <= 0 || !/^\d+$/.test(portText) || dispatchPort > 65535) {
    throw new ConfigError("LIQUID_DISPATCH_BIND must be host:port");
  }
  return {
    exchangeUrl,
    slug: required("PROVIDER_SLUG"),
    providerKey: required("PROVIDER_KEY"),
    deploymentName: required("DEPLOYMENT_NAME"),
    dispatchHost,
    dispatchPort,
    dispatchUrl,
    upstreamUrl,
    upstreamKey: required("UPSTREAM_API_KEY"),
    rateInput: media === undefined ? rate("RATE_INPUT") : 0,
    rateCacheRead: media === undefined ? rate("RATE_CACHE_READ") : 0,
    rateOutput: media === undefined ? rate("RATE_OUTPUT") : 0,
    kind: kind as DeploymentKind,
    unitRate: media === undefined ? 0 : rate(media.rate),
    completionMs: whole("COMPLETION_MS", String(media?.completionMs ?? 30_000), 3_600_000),
    contentKey,
    pollMs: seconds("UPSTREAM_POLL_SECONDS", "2"),
    renderTimeoutMs: seconds("UPSTREAM_RENDER_TIMEOUT_SECONDS", "540"),
    retention,
    journalPath: required("AWARD_JOURNAL"),
    quoteLifetimeMs: whole("QUOTE_LIFETIME_MS", "60000", 600_000),
    upstreamTimeoutMs: whole("UPSTREAM_TIMEOUT_SECONDS", "30", 3600) * 1000,
    shutdownTimeoutMs: whole("SHUTDOWN_TIMEOUT_SECONDS", "35", 3600) * 1000,
  };
}

/** The exchange address of the session socket, from the HTTP address of the exchange. */
export function sessionUrl(exchangeUrl: string): string {
  return `${exchangeUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/v1/provider/ws`;
}
