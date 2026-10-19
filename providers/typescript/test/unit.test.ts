import { describe, expect, it } from "vitest";
import { ConfigError, sessionUrl, settingsFromEnv } from "../src/config.js";
import { usageReport } from "../src/usage.js";

describe("usageReport", () => {
  it("moves cached tokens from the uncached meter to cache_read", () => {
    const report = usageReport(
      { prompt_tokens: 100, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 30 } },
      "tok",
    );
    expect(report.meters).toEqual({
      uncached_input: 70,
      cache_read: 30,
      cache_write_short: 0,
      cache_write_long: 0,
      generation: 9,
    });
    expect(report.tokenizer_id).toBe("tok");
  });

  it("treats absent details as no cache read", () => {
    const report = usageReport({ prompt_tokens: 5, completion_tokens: 1 }, "tok");
    expect(report.meters.uncached_input).toBe(5);
    expect(report.meters.cache_read).toBe(0);
  });

  it.each([
    ["a missing count", { prompt_tokens: 5 }],
    ["a fractional count", { prompt_tokens: 5.5, completion_tokens: 1 }],
    ["a negative count", { prompt_tokens: 5, completion_tokens: -1 }],
    ["a cache read above the input", { prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 6 } }],
    ["reasoning tokens", { prompt_tokens: 5, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 1 } }],
    ["cache writes", { prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cache_write_tokens: 1 } }],
  ])("refuses %s", (_name, raw) => {
    expect(() => usageReport(raw, "tok")).toThrow();
  });
});

describe("settingsFromEnv", () => {
  const env = {
    LIQUID_EXCHANGE_URL: "https://router.example.com/",
    LIQUID_PROVIDER_SLUG: "acme",
    LIQUID_PROVIDER_KEY: "k",
    LIQUID_DEPLOYMENT_NAME: "d",
    LIQUID_DISPATCH_BIND: "127.0.0.1:9110",
    LIQUID_DISPATCH_URL: "https://provider.example.com/dispatch",
    LIQUID_UPSTREAM_BASE_URL: "http://127.0.0.1:9200/v1/",
    LIQUID_UPSTREAM_API_KEY: "u",
    LIQUID_RATE_INPUT: "0.10",
    LIQUID_RATE_CACHE_READ: "0.02",
    LIQUID_RATE_OUTPUT: "0.200000001",
    LIQUID_RETENTION_POLICY: "allowed",
    LIQUID_AWARD_JOURNAL: "awards.journal",
  };

  it("reads the settings and applies the defaults", () => {
    const settings = settingsFromEnv(env);
    expect(settings.exchangeUrl).toBe("https://router.example.com");
    expect(settings.upstreamUrl).toBe("http://127.0.0.1:9200/v1");
    expect(settings.rateInput).toBe(0.1);
    expect(settings.dispatchPort).toBe(9110);
    expect(settings.quoteLifetimeMs).toBe(60000);
    expect(settings.upstreamTimeoutMs).toBe(30000);
    expect(settings.shutdownTimeoutMs).toBe(35000);
  });

  it("names the session address from the exchange address", () => {
    expect(sessionUrl("https://router.example.com")).toBe("wss://router.example.com/v1/provider/ws");
    expect(sessionUrl("http://127.0.0.1:1")).toBe("ws://127.0.0.1:1/v1/provider/ws");
  });

  it.each([
    ["LIQUID_PROVIDER_KEY", undefined, "LIQUID_PROVIDER_KEY is required"],
    ["LIQUID_RATE_INPUT", "-1", "non-negative"],
    ["LIQUID_RATE_INPUT", "0.1234567891", "nine decimal places"],
    ["LIQUID_RATE_INPUT", "1e3", "nine decimal places"],
    ["LIQUID_RETENTION_POLICY", "maybe", "none or allowed"],
    ["LIQUID_DISPATCH_BIND", "9110", "host:port"],
    ["LIQUID_DISPATCH_URL", "ftp://x/y", "HTTP URL"],
    ["LIQUID_EXCHANGE_URL", "https://user:pw@x", "HTTP URL"],
    ["LIQUID_QUOTE_LIFETIME_MS", "0", "between 1"],
  ])("refuses %s=%s", (name, value, message) => {
    const changed: Record<string, string | undefined> = { ...env, [name]: value };
    expect(() => settingsFromEnv(changed)).toThrow(ConfigError);
    expect(() => settingsFromEnv(changed)).toThrow(message);
  });
});
