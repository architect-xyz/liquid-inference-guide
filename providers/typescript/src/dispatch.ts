import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Settings } from "./config.js";
import type { Journal } from "./journal.js";
import { isCount, isRecord, isTruthy, isUnset, type JsonObject } from "./json.js";
import type { Logger } from "./log.js";
import type { DispatchEvent } from "./protocol.js";
import type { SessionClient, Snapshot } from "./session.js";
import { streamChat, UpstreamError } from "./upstream.js";
import { usageReport } from "./usage.js";

const MAX_BODY_BYTES = 1024 * 1024;
const AWARD_WAIT_MS = 2000;
const FINISH_REASONS = new Set(["stop", "length", "content_filter"]);
const ROLES = new Set(["system", "user", "assistant", "developer"]);

/** Fields the reference does not serve. The exchange sends them only to offers that declared them. */
const UNSUPPORTED = [
  "tools",
  "tool_choice",
  "response_format",
  "top_p",
  "stop",
  "seed",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "frequency_penalty",
  "presence_penalty",
  "reasoning",
  "image",
  "audio",
  "video",
  "pricing_unit",
] as const;

class InvalidDispatch extends Error {}

class JournalUnavailable extends Error {}

interface Validated {
  awardId: string;
  snapshot: Snapshot;
  messages: Array<{ role: string; content: string }>;
  maxOutputTokens: number;
  temperature: number | undefined;
}

function sendJson(res: ServerResponse, status: number, body: JsonObject): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new InvalidDispatch("request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export class DispatchServer {
  private readonly server: Server;
  private readonly inflight = new Set<Promise<void>>();
  private accepting = true;

  constructor(
    private readonly settings: Settings,
    private readonly session: SessionClient,
    private readonly journal: Journal,
    private readonly log: Logger,
  ) {
    this.server = createServer((req, res) => {
      const task = this.route(req, res).catch((error: unknown) => {
        this.log("dispatch_handler_error", { error: error instanceof Error ? error.name : "unknown" });
        if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
        else res.end();
      });
      this.inflight.add(task);
      void task.finally(() => this.inflight.delete(task));
    });
  }

  listen(): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.settings.dispatchPort, this.settings.dispatchHost, () => {
        this.server.off("error", reject);
        resolve(this.server.address() as AddressInfo);
      });
    });
  }

  /** Stops new connections, then waits for the dispatches in progress. The buyer pays for them. */
  async close(timeoutMs: number): Promise<void> {
    this.accepting = false;
    this.server.close();
    this.server.closeIdleConnections();
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), timeoutMs);
    });
    const drained = Promise.allSettled([...this.inflight]).then(() => "drained" as const);
    const result = await Promise.race([drained, limit]);
    clearTimeout(timer);
    if (result === "late") this.log("dispatch_shutdown_timeout", { inflight: this.inflight.size });
    this.server.closeAllConnections();
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/health" && req.method === "GET") {
      sendJson(res, 200, {
        connected: this.session.connected,
        standby: this.session.standby,
        deployment: this.settings.deploymentName,
      });
      return;
    }
    if (path === "/dispatch") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      await this.dispatch(req, res);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  }

  private async validate(body: JsonObject, awardId: string): Promise<Validated> {
    let notice;
    try {
      notice = await this.session.awaitAward(awardId, AWARD_WAIT_MS);
    } catch {
      throw new InvalidDispatch("no award notice for this dispatch");
    }
    for (const key of ["award_id", "job_id", "offer_id", "served_model"] as const) {
      if (body[key] !== notice.notice[key]) {
        throw new InvalidDispatch(`dispatch ${key} does not match the award`);
      }
    }
    const reference = body["execution_ref"];
    const snapshot = typeof reference === "string" ? this.session.snapshots.get(reference) : undefined;
    if (snapshot === undefined || !notice.references.has(snapshot.reference)) {
      throw new InvalidDispatch("dispatch execution_ref does not match the award");
    }
    if (snapshot.modelId !== body["offer_id"] || snapshot.model !== body["served_model"]) {
      throw new InvalidDispatch("dispatch does not match the deployment");
    }
    const limit = body["max_output_tokens"];
    if (!isCount(limit)) throw new InvalidDispatch("usage must contain non-negative integer counts");
    let allowed = notice.notice.max_output_tokens;
    if (snapshot.maxOutputTokens !== null) allowed = Math.min(allowed, snapshot.maxOutputTokens);
    if (limit <= 0 || limit > allowed) throw new InvalidDispatch("dispatch exceeds the output limit");
    if (UNSUPPORTED.some((key) => !isUnset(body[key]))) {
      throw new InvalidDispatch("dispatch requires an unsupported feature");
    }
    const cache = isTruthy(body["cache"]) ? body["cache"] : {};
    if (!isRecord(cache)) throw new InvalidDispatch("dispatch requires a valid cache object");
    if (isTruthy(cache["breakpoints"]) || isTruthy(cache["key"]) || isTruthy(cache["scope"])) {
      throw new InvalidDispatch("dispatch requires prompt cache support");
    }
    const raw = body["messages"];
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new InvalidDispatch("dispatch requires text messages");
    }
    const messages: Array<{ role: string; content: string }> = [];
    for (const message of raw as unknown[]) {
      if (!isRecord(message)) throw new InvalidDispatch("dispatch requires a message object");
      const role = message["role"];
      const content = message["content"];
      if (typeof role !== "string" || !ROLES.has(role)) {
        throw new InvalidDispatch("dispatch requires a text role");
      }
      if (typeof content !== "string") throw new InvalidDispatch("dispatch requires text content");
      if (
        isTruthy(message["tool_calls"]) ||
        isTruthy(message["tool_call_id"]) ||
        isTruthy(message["reasoning"])
      ) {
        throw new InvalidDispatch("dispatch requires an unsupported message feature");
      }
      const parts = message["parts"] ?? [];
      if (
        !Array.isArray(parts) ||
        (parts as unknown[]).some((part) => !isRecord(part) || part["type"] !== "text")
      ) {
        throw new InvalidDispatch("dispatch requires an unsupported input modality");
      }
      messages.push({ role, content });
    }
    const temperature = body["temperature"];
    if (temperature !== null && temperature !== undefined && typeof temperature !== "number") {
      throw new InvalidDispatch("dispatch temperature must be a number");
    }
    return {
      awardId,
      snapshot,
      messages,
      maxOutputTokens: limit,
      temperature: typeof temperature === "number" ? temperature : undefined,
    };
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.accepting) {
      sendJson(res, 503, { error: "shutting_down" });
      return;
    }
    let job: Validated;
    let providerId: string;
    try {
      const body: unknown = JSON.parse((await readBody(req)).toString("utf8"));
      const awardId = isRecord(body) ? body["award_id"] : undefined;
      if (!isRecord(body) || typeof awardId !== "string") {
        throw new InvalidDispatch("dispatch requires an award_id");
      }
      if (req.headers["idempotency-key"] !== awardId) {
        throw new InvalidDispatch("idempotency-key must match award_id");
      }
      if (this.session.providerId === undefined) {
        sendJson(res, 503, { error: "session_unavailable" });
        return;
      }
      providerId = this.session.providerId;
      if (this.journal.contains(providerId, awardId)) {
        sendJson(res, 409, { error: "duplicate_award" });
        return;
      }
      job = await this.validate(body, awardId);
      // The claim comes after validation and before any upstream work. It is
      // synchronous, so two deliveries cannot both pass it.
      let claimed: boolean;
      try {
        claimed = this.journal.claim(providerId, awardId);
      } catch {
        throw new JournalUnavailable();
      }
      if (!claimed) {
        sendJson(res, 409, { error: "duplicate_award" });
        return;
      }
    } catch (error) {
      if (error instanceof JournalUnavailable) {
        this.log("journal_unavailable");
        sendJson(res, 503, { error: "journal_unavailable" });
      } else if (error instanceof InvalidDispatch || error instanceof SyntaxError) {
        sendJson(res, 400, { error: "invalid_dispatch", message: error.message });
      } else {
        throw error;
      }
      return;
    }
    await this.stream(res, job);
  }

  private async stream(res: ServerResponse, job: Validated): Promise<void> {
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.flushHeaders();

    const emit = async (event: DispatchEvent): Promise<void> => {
      if (res.destroyed) throw new UpstreamError("buyer side closed");
      if (!res.write(`${JSON.stringify(event)}\n`)) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.on("drain", done);
          res.on("close", done);
        });
      }
    };

    try {
      let raw: JsonObject | undefined;
      let finishReason: string | undefined;
      let outputSent = false;
      for await (const event of streamChat({
        baseUrl: this.settings.upstreamUrl,
        apiKey: this.settings.upstreamKey,
        model: job.snapshot.model,
        messages: job.messages,
        maxTokens: job.maxOutputTokens,
        temperature: job.temperature,
        idleTimeoutMs: this.settings.upstreamTimeoutMs,
        signal: abort.signal,
      })) {
        if (event.kind === "usage") raw = event.raw;
        else if (event.kind === "finish") finishReason = event.reason;
        else {
          await emit({ type: "delta", text: event.text });
          if (!outputSent) {
            this.log("first_output", { award_id: job.awardId });
            outputSent = true;
          }
        }
      }
      if (raw === undefined || finishReason === undefined || !FINISH_REASONS.has(finishReason)) {
        throw new UpstreamError("upstream ended without valid usage and finish_reason");
      }
      await emit({
        type: "done",
        finish_reason: finishReason as "stop" | "length" | "content_filter",
        usage: usageReport(raw, job.snapshot.tokenizerId),
      });
    } catch (error) {
      this.log("dispatch_failed", {
        award_id: job.awardId,
        error: error instanceof Error ? error.name : "unknown",
        reason: error instanceof Error ? error.message : undefined,
      });
      if (!res.destroyed) {
        const report = error instanceof UpstreamError ? error.report : undefined;
        await emit({
          type: "failed",
          code: "upstream_failed",
          message: report ?? "the upstream did not return a valid text response",
        }).catch(() => {});
      }
    }
    res.end();
  }
}
