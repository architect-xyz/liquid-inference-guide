import { isRecord, isTruthy, type JsonObject } from "./json.js";

/** The upstream failed, or returned something the reference cannot serve. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    /** The text for the `failed` event, when it differs from the generic one. */
    readonly report?: string,
  ) {
    super(message);
  }
}

export type UpstreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "usage"; raw: JsonObject }
  | { kind: "finish"; reason: string };

export interface UpstreamRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
  temperature: number | undefined;
  /** Longest wait for the next byte of the upstream. */
  idleTimeoutMs: number;
  /** Aborts the request, for example when the buyer's side of the dispatch closes. */
  signal: AbortSignal;
}

const REASONING_KEYS = ["reasoning", "reasoning_content", "reasoning_details"] as const;

function* eventsOf(data: string): Generator<UpstreamEvent> {
  let chunk: unknown;
  try {
    chunk = JSON.parse(data);
  } catch {
    throw new UpstreamError("upstream sent a chunk that is not JSON");
  }
  if (!isRecord(chunk)) throw new UpstreamError("upstream sent a chunk that is not an object");
  const usage = chunk["usage"];
  if (usage !== null && usage !== undefined) {
    if (!isRecord(usage)) throw new UpstreamError("upstream usage is not an object");
    yield { kind: "usage", raw: usage };
  }
  const choices = chunk["choices"];
  if (choices === undefined || choices === null) return;
  if (!Array.isArray(choices)) throw new UpstreamError("upstream choices is not a list");
  for (const choice of choices as unknown[]) {
    if (!isRecord(choice)) throw new UpstreamError("upstream choice is not an object");
    const delta = choice["delta"];
    if (isRecord(delta)) {
      if (isTruthy(delta["tool_calls"]) || isTruthy(delta["function_call"])) {
        throw new UpstreamError("upstream returned a tool call");
      }
      if (REASONING_KEYS.some((key) => isTruthy(delta[key]))) {
        throw new UpstreamError("upstream returned reasoning");
      }
      const content = delta["content"];
      if (typeof content === "string" && content !== "") yield { kind: "delta", text: content };
    }
    const reason = choice["finish_reason"];
    if (typeof reason === "string") yield { kind: "finish", reason };
  }
}

/** Streams one chat completion from an OpenAI-compatible upstream. */
export async function* streamChat(request: UpstreamRequest): AsyncGenerator<UpstreamEvent> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.idleTimeoutMs);
  };
  const forward = (): void => controller.abort();
  if (request.signal.aborted) controller.abort();
  request.signal.addEventListener("abort", forward, { once: true });
  arm();
  try {
    const body: JsonObject = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    let response: Response;
    try {
      response = await fetch(`${request.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new UpstreamError(timedOut ? "upstream timed out" : `upstream unreachable: ${String(error)}`);
    }
    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => "");
      throw new UpstreamError(
        `upstream returned ${response.status}`,
        `upstream returned ${response.status}: ${text.slice(0, 1000)}`,
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        let read: Awaited<ReturnType<typeof reader.read>>;
        try {
          read = await reader.read();
        } catch {
          throw new UpstreamError(timedOut ? "upstream timed out" : "upstream stream broke");
        }
        arm();
        buffer += decoder.decode(read.value, { stream: !read.done });
        const lines = buffer.split(/\r?\n/);
        buffer = read.done ? "" : (lines.pop() ?? "");
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          if (data !== "") yield* eventsOf(data);
        }
        if (read.done) return;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", forward);
    controller.abort();
  }
}
