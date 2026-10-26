import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { settingsFromEnv, type DeploymentKind, type Settings } from "../src/config.js";
import type { JsonObject } from "../src/json.js";
import { silentLogger } from "../src/log.js";
import { Provider } from "../src/provider.js";
import { awardNotice, dispatchBody, events, FakeExchange, listedModel, until } from "./harness.js";

const FILE = Buffer.from("\x00\x00\x00\x18ftypmp42video-bytes", "latin1");
const KEY = "stable-content-key";
type MediaKind = Exclude<DeploymentKind, "chat">;

const KINDS: Record<MediaKind, { field: string; rate: number; completionMs: number }> = {
  image_generation: { field: "rate_per_image", rate: 0.04, completionMs: 90_000 },
  audio_speech: { field: "rate_per_character", rate: 0.000015, completionMs: 30_000 },
  video_generation: { field: "rate_per_video_second", rate: 0.05, completionMs: 300_000 },
};

type Mode = "ok" | "error" | "extra" | "empty" | "failed" | "not_video";

/** The media endpoints of an OpenAI-compatible upstream. */
class MediaUpstream {
  readonly calls: Array<{ path: string; body: JsonObject }> = [];
  polls = 0;
  mode: Mode = "ok";
  private readonly server: Server;

  private constructor(server: Server) {
    this.server = server;
    server.on("request", (req, res) => void this.handle(req, res));
  }

  static async start(): Promise<MediaUpstream> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return new MediaUpstream(server);
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  private json(res: ServerResponse, status: number, body: JsonObject): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    const text = Buffer.concat(chunks).toString("utf8");
    const path = (req.url ?? "").replace(/^\/v1\//, "");
    if (req.method === "POST") this.calls.push({ path, body: JSON.parse(text) as JsonObject });
    if (path === "images/generations") {
      if (this.mode === "error") return this.json(res, 503, { error: "fixture" });
      const data =
        this.mode === "extra"
          ? [{ b64_json: "YQ==" }, { b64_json: "Yg==" }, { b64_json: "Yw==" }]
          : [{ b64_json: "aGVsbG8=" }, { revised_prompt: "no image here" }];
      return this.json(res, 200, { data });
    }
    if (path === "audio/speech") {
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(this.mode === "empty" ? Buffer.alloc(0) : Buffer.from("ID3-audio"));
      return;
    }
    if (path === "videos") return this.json(res, 200, { id: "vid_1", status: "queued" });
    if (path === "videos/vid_1") {
      this.polls += 1;
      if (this.mode === "failed") return this.json(res, 200, { id: "vid_1", status: "failed" });
      const done = this.polls >= 2;
      return this.json(res, 200, {
        id: "vid_1",
        status: done ? "completed" : "in_progress",
        expires_at: 4102444800,
      });
    }
    if (path === "videos/vid_1/content") {
      if (this.mode === "not_video") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>");
        return;
      }
      res.writeHead(200, { "content-type": "video/mp4", "content-length": FILE.length });
      res.end(FILE);
      return;
    }
    this.json(res, 404, { error: "not_found" });
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

interface Peer {
  exchange: FakeExchange;
  upstream: MediaUpstream;
  provider: Provider;
  terms: JsonObject;
  reference: string;
  base: string;
  stop(): Promise<void>;
}

let peer: Peer | undefined;

afterEach(async () => {
  await peer?.stop();
  peer = undefined;
});

async function start(kind: MediaKind, mode: Mode = "ok", overrides: Partial<Settings> = {}): Promise<Peer> {
  const exchange = await FakeExchange.start();
  exchange.models = [listedModel({ kind, max_output_tokens: 1 })];
  const upstream = await MediaUpstream.start();
  upstream.mode = mode;
  const settings: Settings = {
    exchangeUrl: exchange.url,
    slug: "acme",
    providerKey: "test-provider-key",
    deploymentName: "test-deployment",
    dispatchHost: "127.0.0.1",
    dispatchPort: 0,
    dispatchUrl: "https://provider.example.com/dispatch",
    upstreamUrl: upstream.url,
    upstreamKey: "test-upstream-key",
    rateInput: 0,
    rateCacheRead: 0,
    rateOutput: 0,
    kind,
    unitRate: KINDS[kind].rate,
    completionMs: KINDS[kind].completionMs,
    contentKey: KEY,
    pollMs: 10,
    renderTimeoutMs: 5000,
    retention: "allowed",
    journalPath: join(mkdtempSync(join(tmpdir(), "liquid-provider-")), "awards.journal"),
    quoteLifetimeMs: 60000,
    upstreamTimeoutMs: 5000,
    shutdownTimeoutMs: 5000,
    ...overrides,
  };
  const provider = new Provider(settings, silentLogger);
  const address = await provider.start();
  const terms = await until(() => exchange.frames("quote")[0]);
  const reference = String(terms["execution_ref"]);
  await until(() => (provider.session.snapshots.has(reference) ? true : undefined));
  let stopped = false;
  return {
    exchange,
    upstream,
    provider,
    terms,
    reference,
    base: `http://127.0.0.1:${address.port}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await provider.stop();
      await upstream.close();
      await exchange.close();
    },
  };
}

async function award(p: Peer, awardId: string): Promise<void> {
  const socket = p.exchange.sockets.at(-1);
  if (socket === undefined) throw new Error("no session");
  p.exchange.send(socket, awardNotice(awardId, { served_model: "upstream-model", max_output_tokens: 1 }));
  await until(() => (p.provider.session.awards.has(awardId) ? true : undefined));
}

async function dispatch(p: Peer, bound: JsonObject, awardId = "aw_1"): Promise<JsonObject[]> {
  await award(p, awardId);
  const body = dispatchBody(awardId, p.reference, {
    messages: [{ role: "user", content: "A trading floor made of water" }],
    max_output_tokens: 1,
    temperature: undefined,
    stream: undefined,
    ...bound,
  });
  const response = await fetch(`${p.base}/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": awardId },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return events(response);
}

function content(p: Peer, body: JsonObject): Promise<Response> {
  return fetch(`${p.base}/content`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("media quotes", () => {
  it.each(Object.keys(KINDS) as MediaKind[])("%s quotes only its own rate", async (kind) => {
    peer = await start(kind);
    const { field, rate, completionMs } = KINDS[kind];
    expect(peer.terms[field]).toBe(rate);
    expect(peer.terms["service_class"]).toEqual({ ttft_ms: completionMs, completion_ms: completionMs });
    for (const key of ["rate_uncached_input", "rate_cache_read", "rate_generation"]) {
      expect(key in peer.terms).toBe(false);
    }
    expect(peer.terms["supported_features"]).toEqual(["text"]);
  });

  it("does not select a listed deployment of another kind", async () => {
    const exchange = await FakeExchange.start();
    exchange.models = [listedModel({ kind: "chat" })];
    const upstream = await MediaUpstream.start();
    const dir = mkdtempSync(join(tmpdir(), "liquid-provider-"));
    const provider = new Provider(
      settingsFromEnv({
        ...mediaEnv("image_generation", join(dir, "j")),
        LIQUID_EXCHANGE_URL: exchange.url,
        LIQUID_UPSTREAM_BASE_URL: upstream.url,
      }),
      silentLogger,
    );
    await provider.start();
    await until(() => exchange.frames("login")[0]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exchange.frames("quote")).toHaveLength(0);
    await provider.stop();
    await upstream.close();
    await exchange.close();
  });
});

describe("image jobs", () => {
  it("count only the images that they send", async () => {
    peer = await start("image_generation");
    const list = await dispatch(peer, { image: { count: 2, size: "1024x1024", output_format: "webp" } });
    expect(list[0]).toEqual({ type: "image", index: 0, b64_json: "aGVsbG8=", mime: "image/webp" });
    expect(list.at(-1)).toEqual({
      type: "done",
      finish_reason: "stop",
      usage: { meters: { images: 1 }, tokenizer_id: "o200k_base", raw: {} },
    });
    expect(peer.upstream.calls[0]?.body).toEqual({
      model: "upstream-model",
      prompt: "A trading floor made of water",
      n: 2,
      size: "1024x1024",
      output_format: "webp",
    });
  });

  it.each(["error", "extra"] as const)("never report success after %s", async (mode) => {
    peer = await start("image_generation", mode);
    const list = await dispatch(peer, { image: { count: 1 } });
    expect(list.at(-1)?.["type"]).toBe("failed");
    expect(list.every((event) => event["type"] !== "done")).toBe(true);
  });
});

describe("speech jobs", () => {
  it("send the clip with its own type and the character count", async () => {
    peer = await start("audio_speech");
    const list = await dispatch(peer, { audio: { characters: 29, voice: "alloy", response_format: "mp3" } });
    expect(list[0]).toEqual({
      type: "audio",
      b64_audio: Buffer.from("ID3-audio").toString("base64"),
      mime: "audio/wav",
    });
    expect(list.at(-1)).toMatchObject({ usage: { meters: { characters: 29 } } });
    expect(peer.upstream.calls[0]?.body["voice"]).toBe("alloy");
  });

  it("fail the job on an empty clip", async () => {
    peer = await start("audio_speech", "empty");
    const list = await dispatch(peer, { audio: { characters: 29, voice: "a" } });
    expect(list.map((event) => event["type"])).toEqual(["failed"]);
  });
});

describe("video jobs", () => {
  it("wait for the render and serve the file with the token", async () => {
    peer = await start("video_generation");
    const list = await dispatch(peer, { video: { seconds: 8, size: "1280x720" } });
    const ready = list.find((event) => event["type"] === "video_ready");
    if (ready === undefined) throw new Error("no video_ready");
    expect(ready).toMatchObject({ handle: "vid_1", mime: "video/mp4", bytes: FILE.length });
    expect(String(ready["expires_at"])).toMatch(/^2100-01-01/);
    const token = createHmac("sha256", KEY).update("vid_1").digest("hex");
    expect(ready["token"]).toBe(token);
    expect(list.at(-1)).toMatchObject({ type: "done", usage: { meters: { video_seconds: 8 } } });
    expect(list.indexOf(ready)).toBeLessThan(list.length - 1);
    expect(peer.upstream.calls[0]?.body["seconds"]).toBe("8");

    const answer = await content(peer, { handle: "vid_1", token });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await answer.arrayBuffer())).toEqual(FILE);
    expect((await content(peer, { handle: "vid_1", token: "00" })).status).toBe(403);
    const traversal = { handle: "../x", token: createHmac("sha256", KEY).update("../x").digest("hex") };
    expect((await content(peer, traversal)).status).toBe(403);
    expect((await content(peer, { handle: 1 })).status).toBe(400);
  });

  it("write a blank line for each poll", async () => {
    peer = await start("video_generation");
    await award(peer, "aw_blank");
    const response = await fetch(`${peer.base}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "aw_blank" },
      body: JSON.stringify(
        dispatchBody("aw_blank", peer.reference, { max_output_tokens: 1, video: { seconds: 4 } }),
      ),
    });
    const lines = (await response.text()).split("\n").slice(0, -1);
    const blanks = lines.filter((line) => line === "").length;
    expect(blanks).toBe(peer.upstream.polls);
  });

  it.each(["failed", "not_video"] as const)("never report success after %s", async (mode) => {
    peer = await start("video_generation", mode);
    const list = await dispatch(peer, { video: { seconds: 4 } });
    expect(list.at(-1)?.["type"]).toBe("failed");
    expect(list.every((event) => event["type"] !== "done" && event["type"] !== "video_ready")).toBe(true);
  });

  it("fail the job when the render outlasts the timeout", async () => {
    peer = await start("video_generation", "ok", { renderTimeoutMs: 15 });
    const list = await dispatch(peer, { video: { seconds: 4 } });
    expect(list.at(-1)?.["type"]).toBe("failed");
  });

  it("serve no content route on other kinds", async () => {
    peer = await start("image_generation");
    expect((await content(peer, { handle: "x", token: "y" })).status).toBe(404);
  });
});

describe("media dispatch validation", () => {
  it("starts no upstream work without the bound of its kind", async () => {
    peer = await start("image_generation");
    await award(peer, "aw_nobound");
    const response = await fetch(`${peer.base}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "aw_nobound" },
      body: JSON.stringify(dispatchBody("aw_nobound", peer.reference, { max_output_tokens: 1 })),
    });
    expect(response.status).toBe(400);
    expect(peer.upstream.calls).toEqual([]);
  });

  it("still refuses a token-only feature", async () => {
    peer = await start("image_generation");
    await award(peer, "aw_tools");
    const response = await fetch(`${peer.base}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "aw_tools" },
      body: JSON.stringify(
        dispatchBody("aw_tools", peer.reference, { image: { count: 1 }, stop: ["x"] }),
      ),
    });
    expect(response.status).toBe(400);
    expect(peer.upstream.calls).toEqual([]);
  });
});

function mediaEnv(kind: string, journal: string): Record<string, string> {
  return {
    LIQUID_EXCHANGE_URL: "http://127.0.0.1:1",
    LIQUID_PROVIDER_SLUG: "local",
    LIQUID_PROVIDER_KEY: "k",
    LIQUID_DEPLOYMENT_NAME: "test-deployment",
    LIQUID_DEPLOYMENT_KIND: kind,
    LIQUID_DISPATCH_BIND: "127.0.0.1:0",
    LIQUID_DISPATCH_URL: "http://127.0.0.1:1/dispatch",
    LIQUID_UPSTREAM_BASE_URL: "http://127.0.0.1:1/v1",
    LIQUID_UPSTREAM_API_KEY: "u",
    LIQUID_RATE_PER_IMAGE: "0.04",
    LIQUID_RATE_PER_CHARACTER: "0.000015",
    LIQUID_RATE_PER_VIDEO_SECOND: "0.05",
    LIQUID_CONTENT_KEY: "k",
    LIQUID_RETENTION_POLICY: "allowed",
    LIQUID_AWARD_JOURNAL: journal,
  };
}

describe("media settings", () => {
  const base = mediaEnv("video_generation", "j");

  it("reads the media terms and applies the defaults of each kind", () => {
    const video = settingsFromEnv(base);
    expect(video).toMatchObject({
      kind: "video_generation",
      unitRate: 0.05,
      completionMs: 300_000,
      pollMs: 2000,
      renderTimeoutMs: 540_000,
      rateInput: 0,
    });
    expect(settingsFromEnv(mediaEnv("image_generation", "j")).completionMs).toBe(90_000);
    expect(settingsFromEnv(mediaEnv("audio_speech", "j")).completionMs).toBe(30_000);
    expect(settingsFromEnv({ ...base, LIQUID_COMPLETION_MS: "1000" }).completionMs).toBe(1000);
  });

  it("needs no media rate for chat and no token rates for media", () => {
    expect(() => settingsFromEnv({ ...base, LIQUID_DEPLOYMENT_KIND: "chat" })).toThrow("LIQUID_RATE_INPUT");
    expect(settingsFromEnv(base).kind).toBe("video_generation");
  });

  it.each([
    [{ LIQUID_DEPLOYMENT_KIND: "embedding" }, "LIQUID_DEPLOYMENT_KIND"],
    [{ LIQUID_CONTENT_KEY: "" }, "LIQUID_CONTENT_KEY"],
    [{ LIQUID_RATE_PER_VIDEO_SECOND: "" }, "LIQUID_RATE_PER_VIDEO_SECOND"],
    [{ LIQUID_RATE_PER_VIDEO_SECOND: "0.1234567891" }, "nine decimal places"],
    [{ LIQUID_UPSTREAM_POLL_SECONDS: "0" }, "LIQUID_UPSTREAM_POLL_SECONDS"],
  ])("refuses a media deployment with %j", (change, message) => {
    expect(() => settingsFromEnv({ ...base, ...change })).toThrow(message);
  });

  it("does not need a content key for a deployment that serves no video", () => {
    expect(settingsFromEnv({ ...mediaEnv("image_generation", "j"), LIQUID_CONTENT_KEY: "" }).contentKey).toBe("");
  });
});
