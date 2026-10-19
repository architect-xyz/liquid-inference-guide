import type { RetentionPolicy } from "./protocol.js";

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
    rateInput: rate("RATE_INPUT"),
    rateCacheRead: rate("RATE_CACHE_READ"),
    rateOutput: rate("RATE_OUTPUT"),
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
