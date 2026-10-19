import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Settings } from "../src/config.js";
import { isRecord, type JsonObject } from "../src/json.js";
import { Provider } from "../src/provider.js";
import { silentLogger } from "../src/log.js";

export const MODEL_ID = "3f0c0000-0000-4000-8000-000000000001";
export const PROVIDER_ID = "7c9e0000-0000-4000-8000-000000000002";

export function listedModel(overrides: JsonObject = {}): JsonObject {
  return {
    model_id: MODEL_ID,
    unverified: false,
    deployment_name: "test-deployment",
    model: "upstream-model",
    precision: "fp8",
    region: "eu-west",
    max_input_tokens: 128000,
    max_output_tokens: 4096,
    tokenizer_id: "o200k_base",
    ...overrides,
  };
}

export async function until<T>(read: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out in test");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function parse(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("frame is not an object");
  return value;
}

/** A WebSocket server that plays the exchange side of the session. */
export class FakeExchange {
  readonly received: JsonObject[] = [];
  readonly sockets: WebSocket[] = [];
  models: JsonObject[] = [listedModel()];
  autoAck = true;
  ackValidForMs: number | undefined;
  private readonly wss: WebSocketServer;

  private constructor(wss: WebSocketServer) {
    this.wss = wss;
    wss.on("connection", (socket) => {
      this.sockets.push(socket);
      socket.on("message", (data) => {
        const frame = parse(data.toString());
        this.received.push(frame);
        if (frame["type"] === "login") {
          this.send(socket, { type: "login_ack", provider_id: PROVIDER_ID, slug: frame["slug"] });
          this.send(socket, { type: "listed", models: this.models });
        } else if (frame["type"] === "quote" && this.autoAck) {
          const target = frame["target"];
          this.send(socket, {
            type: "quote_ack",
            offer_id: isRecord(target) ? target["model_id"] : null,
            revision: frame["revision"],
            activation_seq: 1,
            valid_for_ms: this.ackValidForMs ?? frame["valid_for_ms"],
          });
        }
      });
    });
  }

  static async start(): Promise<FakeExchange> {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/v1/provider/ws" });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    return new FakeExchange(wss);
  }

  get url(): string {
    return `http://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }

  send(socket: WebSocket, frame: JsonObject): void {
    socket.send(JSON.stringify(frame));
  }

  frames(type: string): JsonObject[] {
    return this.received.filter((frame) => frame["type"] === type);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

export interface UpstreamCall {
  headers: IncomingMessage["headers"];
  body: JsonObject;
  /** Whether the award claim was on disk when the request arrived. */
  journalAtArrival: string;
}

export type UpstreamMode = "ok" | "http500" | "slow" | "no-usage";

/** An OpenAI-compatible streaming upstream. */
export class FakeUpstream {
  readonly calls: UpstreamCall[] = [];
  mode: UpstreamMode = "ok";
  usage: JsonObject = {
    prompt_tokens: 100,
    completion_tokens: 7,
    total_tokens: 107,
    prompt_tokens_details: { cached_tokens: 60 },
  };
  gate: Promise<void> = Promise.resolve();
  journalPath = "";
  private readonly server: Server;

  private constructor(server: Server) {
    this.server = server;
    server.on("request", (req, res) => void this.handle(req, res));
  }

  static async start(): Promise<FakeUpstream> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return new FakeUpstream(server);
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    this.calls.push({
      headers: req.headers,
      body: parse(Buffer.concat(chunks).toString("utf8")),
      journalAtArrival: this.journalPath !== "" && existsSync(this.journalPath) ? readFileSync(this.journalPath, "utf8") : "",
    });
    if (this.mode === "http500") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"boom"}');
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const data = (value: JsonObject): void => void res.write(`data: ${JSON.stringify(value)}\n\n`);
    data({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    data({ choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] });
    await this.gate;
    data({ choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] });
    data({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    if (this.mode !== "no-usage") data({ choices: [], usage: this.usage });
    res.write("data: [DONE]\n\n");
    res.end();
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export interface Rig {
  exchange: FakeExchange;
  upstream: FakeUpstream;
  provider: Provider;
  settings: Settings;
  dispatchUrl: string;
  journalPath: string;
  stop(): Promise<void>;
}

/** Starts the fake exchange and upstream and a provider. `setup` runs before the provider logs in. */
export async function startRig(
  overrides: Partial<Settings> = {},
  setup: (exchange: FakeExchange) => void = () => {},
): Promise<Rig> {
  const exchange = await FakeExchange.start();
  setup(exchange);
  const upstream = await FakeUpstream.start();
  const dir = mkdtempSync(join(tmpdir(), "liquid-provider-"));
  const journalPath = join(dir, "awards.journal");
  upstream.journalPath = journalPath;
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
    rateInput: 0.1,
    rateCacheRead: 0.02,
    rateOutput: 0.2,
    retention: "allowed",
    journalPath,
    quoteLifetimeMs: 60000,
    upstreamTimeoutMs: 5000,
    shutdownTimeoutMs: 5000,
    ...overrides,
  };
  const provider = new Provider(settings, silentLogger);
  const address = await provider.start();
  let stopped = false;
  return {
    exchange,
    upstream,
    provider,
    settings,
    dispatchUrl: `http://127.0.0.1:${address.port}/dispatch`,
    journalPath,
    async stop() {
      if (stopped) return;
      stopped = true;
      await provider.stop();
      await upstream.close();
      await exchange.close();
    },
  };
}

/** Waits for the first quote to be acknowledged, and returns its execution reference. */
export async function readyReference(rig: Rig): Promise<string> {
  const quote = await until(() => rig.exchange.frames("quote")[0]);
  const reference = quote["execution_ref"];
  if (typeof reference !== "string") throw new Error("quote has no execution_ref");
  await until(() => (rig.provider.session.snapshots.has(reference) ? true : undefined));
  return reference;
}

export function awardNotice(awardId: string, overrides: JsonObject = {}): JsonObject {
  return {
    type: "award_notice",
    award_id: awardId,
    job_id: `job_${awardId}`,
    offer_id: MODEL_ID,
    served_model: "upstream-model",
    cap_usd: 0.0184,
    max_output_tokens: 1024,
    schema_version: "2026-09",
    ...overrides,
  };
}

export function dispatchBody(awardId: string, reference: string, overrides: JsonObject = {}): JsonObject {
  return {
    execution_ref: reference,
    award_id: awardId,
    job_id: `job_${awardId}`,
    offer_id: MODEL_ID,
    served_model: "upstream-model",
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "Say hello." },
    ],
    max_output_tokens: 256,
    temperature: 0.2,
    stream: true,
    ...overrides,
  };
}

export async function post(rig: Rig, body: JsonObject, headers: Record<string, string> = {}): Promise<Response> {
  const awardId = body["award_id"];
  return fetch(rig.dispatchUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(typeof awardId === "string" ? { "idempotency-key": awardId } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

export async function events(response: Response): Promise<JsonObject[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map(parse);
}

/** Sends the award notice on the session, then waits until the agent has recorded it. */
export async function award(rig: Rig, awardId: string, overrides: JsonObject = {}): Promise<void> {
  const socket = rig.exchange.sockets.at(-1);
  if (socket === undefined) throw new Error("no session");
  rig.exchange.send(socket, awardNotice(awardId, overrides));
  await until(() => (rig.provider.session.awards.has(awardId) ? true : undefined));
}
