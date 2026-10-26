import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { MEDIA, sessionUrl, type DeploymentKind, type Settings } from "./config.js";
import type { Logger } from "./log.js";
import {
  parseExchangeFrame,
  type AgentFrame,
  type AwardNoticeFrame,
  type ExchangeFrame,
  type ListedModel,
  type QuoteFrame,
} from "./protocol.js";

const HEARTBEAT_MS = 1000;
const TICK_MS = 250;
const MAX_FRAME_BYTES = 1024 * 1024;
const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 5000;

/** The state of one registered deployment at the time it was quoted. */
export interface Snapshot {
  modelId: string;
  model: string;
  tokenizerId: string;
  maxInputTokens: number;
  /** Null when the deployment states no output limit. */
  maxOutputTokens: number | null;
  /** Names this snapshot in the quote and in the dispatch. */
  reference: string;
  kind: DeploymentKind;
}

export interface AwardRecord {
  notice: AwardNoticeFrame;
  providerId: string | undefined;
  /** The execution references that the exchange had acknowledged at notice time. */
  references: ReadonlySet<string>;
}

type End = "closed" | "failed" | "superseded";

interface PendingQuote {
  snapshot: Snapshot;
  sentAt: number;
}

/** The state of one socket. The exchange never has more than one for this agent. */
interface Connection {
  socket: WebSocket;
  loggedIn: boolean;
  selected: Snapshot | undefined;
  pending: Map<number, PendingQuote>;
  revision: number;
  refreshAt: number;
  retiring: boolean;
  superseded: boolean;
  lastSent: number;
}

/** Whether the listed deployment is one that this agent serves: its kind and its pricing unit must match. */
function serves(model: ListedModel, kind: DeploymentKind): boolean {
  if (model.kind !== kind) return false;
  return model.pricingUnit === undefined || (model.pricingUnit === "tokens") === (kind === "chat");
}

function snapshotOf(model: ListedModel, kind: DeploymentKind): Snapshot {
  return {
    modelId: model.modelId,
    model: model.model,
    tokenizerId: model.tokenizerId,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    reference: randomUUID(),
    kind,
  };
}

function sameIdentity(a: Snapshot, b: Snapshot): boolean {
  return (
    a.modelId === b.modelId &&
    a.model === b.model &&
    a.tokenizerId === b.tokenizerId &&
    a.maxInputTokens === b.maxInputTokens &&
    a.maxOutputTokens === b.maxOutputTokens
  );
}

/**
 * The session with the exchange: login, quotes, awards and settlements. It
 * reconnects after a failure, with a wait that doubles up to five seconds.
 */
export class SessionClient {
  providerId: string | undefined;
  /** Snapshots that the exchange acknowledged, by execution reference. */
  readonly snapshots = new Map<string, Snapshot>();
  readonly awards = new Map<string, AwardRecord>();
  standby = false;

  private current: Connection | undefined;
  private stopping = false;
  private runPromise: Promise<void> | undefined;
  private wakeStop: () => void = () => {};
  private readonly stopped = new Promise<void>((resolve) => {
    this.wakeStop = resolve;
  });
  private readonly waiters = new Map<string, Array<(record: AwardRecord) => void>>();

  constructor(
    private readonly settings: Settings,
    private readonly log: Logger,
  ) {}

  get connected(): boolean {
    return this.current?.socket.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.runPromise ??= this.run();
  }

  /** Withdraws every quote, closes the socket and waits for the run loop to end. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wakeStop();
    const connection = this.current;
    if (connection !== undefined && connection.socket.readyState === WebSocket.OPEN) {
      this.send(connection, { type: "mass_withdraw" });
      connection.socket.close(1000);
    }
    if (this.runPromise === undefined) return;
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), 2000);
    });
    const result = await Promise.race([this.runPromise.then(() => "done" as const), grace]);
    clearTimeout(timer);
    if (result === "late") {
      connection?.socket.terminate();
      await this.runPromise;
    }
  }

  /** Resolves with the notice of an award, which can arrive after the dispatch. */
  awaitAward(awardId: string, timeoutMs: number): Promise<AwardRecord> {
    const known = this.awards.get(awardId);
    if (known !== undefined) return Promise.resolve(known);
    return new Promise((resolve, reject) => {
      const waiter = (record: AwardRecord): void => {
        clearTimeout(timer);
        resolve(record);
      };
      const timer = setTimeout(() => {
        const list = (this.waiters.get(awardId) ?? []).filter((entry) => entry !== waiter);
        if (list.length === 0) this.waiters.delete(awardId);
        else this.waiters.set(awardId, list);
        reject(new Error("no award notice for this dispatch"));
      }, timeoutMs);
      this.waiters.set(awardId, [...(this.waiters.get(awardId) ?? []), waiter]);
    });
  }

  private async run(): Promise<void> {
    let backoff = BACKOFF_START_MS;
    while (!this.stopping) {
      const end = await this.connectOnce();
      if (this.stopping) return;
      if (end === "superseded") {
        this.standby = true;
        this.log("standby");
        await this.stopped;
        return;
      }
      if (end === "failed") {
        await this.pause(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      } else {
        backoff = BACKOFF_START_MS;
      }
    }
  }

  private async pause(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const elapsed = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    await Promise.race([elapsed, this.stopped]);
    clearTimeout(timer);
  }

  private send(connection: Connection, frame: AgentFrame): void {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    connection.socket.send(JSON.stringify(frame));
    connection.lastSent = performance.now();
  }

  private connectOnce(): Promise<End> {
    return new Promise((resolve) => {
      const socket = new WebSocket(sessionUrl(this.settings.exchangeUrl), {
        maxPayload: MAX_FRAME_BYTES,
      });
      const connection: Connection = {
        socket,
        loggedIn: false,
        selected: undefined,
        pending: new Map(),
        revision: 0,
        refreshAt: Infinity,
        retiring: false,
        superseded: false,
        lastSent: performance.now(),
      };
      this.current = connection;
      const timer = setInterval(() => this.tick(connection), TICK_MS);

      socket.on("open", () => {
        this.send(connection, {
          type: "login",
          slug: this.settings.slug,
          api_key: this.settings.providerKey,
          dispatch_url: this.settings.dispatchUrl,
          capabilities: [],
        });
      });
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const frame = parseExchangeFrame(data.toString());
        if (frame === undefined) {
          this.log("bad_frame");
          return;
        }
        this.receive(connection, frame);
      });
      socket.on("error", (error) => {
        this.log("session_error", { error: error.name, message: error.message });
      });
      socket.on("close", () => {
        clearInterval(timer);
        if (this.current === connection) this.current = undefined;
        this.log("session_closed");
        if (connection.superseded) resolve("superseded");
        else resolve(connection.loggedIn ? "closed" : "failed");
      });
    });
  }

  private tick(connection: Connection): void {
    const now = performance.now();
    if (connection.socket.readyState !== WebSocket.OPEN || this.stopping) return;
    if (now >= connection.refreshAt) this.quote(connection);
    if (now - connection.lastSent >= HEARTBEAT_MS) this.send(connection, { type: "heartbeat" });
  }

  private quote(connection: Connection): void {
    const model = connection.selected;
    if (model === undefined || connection.retiring) return;
    connection.revision += 1;
    const sentAt = performance.now();
    connection.pending.set(connection.revision, { snapshot: model, sentAt });
    const frame: QuoteFrame = {
      type: "quote",
      target: { kind: "registered", model_id: model.modelId },
      execution_ref: model.reference,
      execution_limits: {
        max_input_tokens: model.maxInputTokens,
        max_output_tokens: model.maxOutputTokens,
      },
      ...this.terms(),
      fixed_fee: 0,
      supported_features: ["text"],
      retention_policy_supported: [this.settings.retention],
      valid_for_ms: this.settings.quoteLifetimeMs,
      revision: connection.revision,
    };
    this.send(connection, frame);
    connection.refreshAt = sentAt + this.settings.quoteLifetimeMs / 2;
  }

  /** The prices and deadlines of a quote. Each kind quotes its own unit. */
  private terms(): Pick<
    QuoteFrame,
    | "rate_uncached_input"
    | "rate_cache_read"
    | "rate_generation"
    | "rate_per_image"
    | "rate_per_character"
    | "rate_per_video_second"
    | "service_class"
  > {
    const { kind, completionMs } = this.settings;
    if (kind === "chat") {
      return {
        rate_uncached_input: this.settings.rateInput,
        rate_cache_read: this.settings.rateCacheRead,
        rate_generation: this.settings.rateOutput,
        service_class: { ttft_ms: 1500, completion_ms: 30000 },
      };
    }
    // A media job arrives whole, so its first output and its end are one time.
    return {
      [MEDIA[kind].field]: this.settings.unitRate,
      service_class: { ttft_ms: completionMs, completion_ms: completionMs },
    };
  }

  private receive(connection: Connection, frame: ExchangeFrame): void {
    switch (frame.type) {
      case "login_ack":
        this.providerId = frame.provider_id;
        connection.loggedIn = true;
        this.log("login_ack", { provider_id: frame.provider_id, slug: frame.slug });
        break;
      case "login_reject":
        this.log("login_reject", { reason: frame.reason });
        connection.socket.close();
        break;
      case "listed":
        this.onListed(connection, frame.models);
        break;
      case "quote_ack": {
        const pending = connection.pending.get(frame.revision);
        connection.pending.delete(frame.revision);
        if (pending !== undefined && frame.offer_id === pending.snapshot.modelId) {
          this.snapshots.set(pending.snapshot.reference, pending.snapshot);
          const lifetime =
            frame.valid_for_ms !== undefined && frame.valid_for_ms > 0
              ? frame.valid_for_ms
              : this.settings.quoteLifetimeMs;
          if (connection.selected === pending.snapshot) {
            connection.refreshAt = pending.sentAt + lifetime / 2;
          }
        }
        this.log("quote_ack", frame.fields);
        break;
      }
      case "quote_reject":
        // One deployment is quoted, so a refusal answers every quote in flight.
        connection.pending.clear();
        if (frame.code === "superseded") {
          connection.retiring = true;
          connection.refreshAt = Infinity;
        }
        this.log("quote_reject", frame.fields);
        break;
      case "award_notice":
        this.onAward(frame);
        break;
      case "settlement_notice":
        this.awards.delete(frame.award_id);
        this.log("settlement_notice", frame.fields);
        break;
      case "risk_notice":
        this.log("risk_notice", { severity: frame.severity, message: frame.message });
        break;
      case "superseded":
        this.log("superseded");
        connection.superseded = true;
        connection.socket.close();
        break;
      case "handover":
        // The login does not offer the handover capability, so the exchange
        // does not send this frame. The session closes with its process.
        this.log("handover_ignored");
        break;
      case "heartbeat":
      case "unknown":
        break;
    }
  }

  private onListed(connection: Connection, models: ListedModel[]): void {
    if (!connection.loggedIn) {
      this.log("listed_before_login_ack");
      connection.socket.close();
      return;
    }
    const matches = models.filter((model) => model.deploymentName === this.settings.deploymentName);
    const match = matches.length === 1 ? matches[0] : undefined;
    const previous = connection.selected;
    connection.retiring = false;
    connection.refreshAt = Infinity;
    const supported = match !== undefined && serves(match, this.settings.kind);
    if (match !== undefined && !supported) {
      this.log("deployment_unsupported", { deployment: this.settings.deploymentName });
    }
    let selected = match !== undefined && supported ? snapshotOf(match, this.settings.kind) : undefined;
    if (selected !== undefined && previous !== undefined && sameIdentity(selected, previous)) {
      selected = previous;
    } else if (previous !== undefined) {
      this.send(connection, {
        type: "withdraw_quote",
        target: { kind: "registered", model_id: previous.modelId },
      });
    }
    connection.selected = selected;
    this.log("listed", { deployment: this.settings.deploymentName, available: selected !== undefined });
    this.quote(connection);
  }

  private onAward(frame: AwardNoticeFrame): void {
    const record: AwardRecord = {
      notice: frame,
      providerId: this.providerId,
      references: new Set(this.snapshots.keys()),
    };
    this.awards.set(frame.award_id, record);
    for (const waiter of this.waiters.get(frame.award_id) ?? []) waiter(record);
    this.waiters.delete(frame.award_id);
    this.log("award_notice", { award_id: frame.award_id, job_id: frame.job_id });
  }
}
