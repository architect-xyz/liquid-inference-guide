import { createHmac, timingSafeEqual } from "node:crypto";
import { isRecord, type JsonObject } from "./json.js";
import type { DispatchEvent, MediaMeters } from "./protocol.js";
import { UpstreamError } from "./upstream.js";

/** Writes one event to the buyer. `null` writes a blank line, which tells the exchange that the render is alive. */
export type Emit = (event: DispatchEvent | null) => Promise<void>;

export interface MediaRequest {
  baseUrl: string;
  apiKey: string;
  /** Longest wait for one upstream call. */
  timeoutMs: number;
  /** Aborts the calls, for example when the buyer's side of the dispatch closes. */
  signal: AbortSignal;
}

export interface ImageBound {
  count: number;
  size?: string;
  output_format?: string;
  quality?: string;
  response_format?: string;
}

export interface AudioBound {
  voice: string;
  response_format?: string;
  speed?: number;
}

export interface VideoBound {
  seconds: number;
  size?: string;
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
};

const AUDIO_TYPES: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  pcm: "audio/pcm",
};

/** The prompt of a media job is the last user turn. */
export function promptOf(messages: ReadonlyArray<{ role: string; content: string }>): string {
  const turns = messages.filter((message) => message.role === "user");
  const prompt = turns.at(-1)?.content;
  if (prompt === undefined || prompt === "") {
    throw new UpstreamError("a media dispatch needs a user prompt");
  }
  return prompt;
}

/** The last event of a media job. The meter is the unit that the deployment is priced in. */
export function mediaDone(meters: MediaMeters, tokenizerId: string): DispatchEvent {
  return {
    type: "done",
    finish_reason: "stop",
    usage: { meters, tokenizer_id: tokenizerId, raw: {} },
  };
}

interface Call {
  response: Response;
  /** Ends the wait for the headers, for a body that the caller streams for as long as it takes. */
  headersDone(): void;
  abort(): void;
  release(): void;
}

async function open(
  request: MediaRequest,
  method: "GET" | "POST",
  path: string,
  body?: JsonObject,
): Promise<Call> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  const forward = (): void => controller.abort();
  if (request.signal.aborted) controller.abort();
  request.signal.addEventListener("abort", forward, { once: true });
  const release = (): void => {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", forward);
  };
  let response: Response;
  try {
    response = await fetch(`${request.baseUrl}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } catch (error) {
    release();
    throw new UpstreamError(timedOut ? "upstream timed out" : `upstream unreachable: ${String(error)}`);
  }
  const call: Call = {
    response,
    headersDone: () => clearTimeout(timer),
    abort: () => controller.abort(),
    release,
  };
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    call.abort();
    release();
    throw new UpstreamError(
      `upstream returned ${response.status}`,
      `upstream returned ${response.status}: ${text.slice(0, 1000)}`,
    );
  }
  return call;
}

/** One upstream call whose whole answer is read before it returns. */
async function call<T>(
  request: MediaRequest,
  method: "GET" | "POST",
  path: string,
  body: JsonObject | undefined,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const opened = await open(request, method, path, body);
  try {
    return await read(opened.response);
  } catch (error) {
    throw error instanceof UpstreamError ? error : new UpstreamError("upstream stream broke");
  } finally {
    opened.abort();
    opened.release();
  }
}

async function jsonOf(response: Response): Promise<JsonObject> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new UpstreamError("upstream sent a body that is not JSON");
  }
  if (!isRecord(value)) throw new UpstreamError("upstream sent a body that is not an object");
  return value;
}

function mimeOf(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
}

export async function generateImages(
  request: MediaRequest,
  model: string,
  prompt: string,
  bound: ImageBound,
  emit: Emit,
): Promise<number> {
  const body: JsonObject = { model, prompt, n: bound.count };
  for (const key of ["size", "output_format", "quality", "response_format"] as const) {
    if (bound[key]) body[key] = bound[key];
  }
  const answer = await call(request, "POST", "images/generations", body, jsonOf);
  const data = answer["data"] ?? [];
  if (!Array.isArray(data)) throw new UpstreamError("upstream data is not a list");
  const mime = IMAGE_TYPES[(bound.output_format || "png").toLowerCase()] ?? "image/png";
  let sent = 0;
  for (const [index, item] of (data as unknown[]).entries()) {
    if (!isRecord(item)) throw new UpstreamError("upstream image is not an object");
    const b64 = item["b64_json"];
    const url = item["url"];
    // An entry with neither field is not an image, so the buyer does not pay for it.
    if (!b64 && !url) continue;
    await emit({
      type: "image",
      index,
      ...(b64 && typeof b64 === "string" ? { b64_json: b64 } : {}),
      ...(url && typeof url === "string" ? { url } : {}),
      mime,
    });
    sent += 1;
  }
  if (sent <= 0 || sent > bound.count) {
    throw new UpstreamError("the upstream returned no image, or more than were asked for");
  }
  return sent;
}

export async function synthesizeSpeech(
  request: MediaRequest,
  model: string,
  text: string,
  bound: AudioBound,
  emit: Emit,
): Promise<void> {
  const body: JsonObject = { model, input: text, voice: bound.voice };
  for (const key of ["response_format", "speed"] as const) {
    if (bound[key] !== undefined && bound[key] !== null) body[key] = bound[key];
  }
  const { clip, mime } = await call(request, "POST", "audio/speech", body, async (response) => ({
    clip: Buffer.from(await response.arrayBuffer()),
    mime: mimeOf(response),
  }));
  if (clip.length === 0) throw new UpstreamError("the upstream returned no audio");
  // The buyer needs the type of the file that came back, not the one that was asked for.
  await emit({
    type: "audio",
    b64_audio: clip.toString("base64"),
    mime: mime || AUDIO_TYPES[bound.response_format ?? "mp3"] || "audio/mpeg",
  });
}

export function signHandle(contentKey: string, handle: string): string {
  return createHmac("sha256", contentKey).update(handle).digest("hex");
}

/** Whether `token` is the signature of `handle`, compared in constant time. */
export function tokenMatches(contentKey: string, handle: string, token: string): boolean {
  const expected = Buffer.from(signHandle(contentKey, handle));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A handle is a path segment of the upstream, so it cannot carry a path, a query or a fragment. */
export function usableHandle(handle: string): boolean {
  return handle !== "" && !/[/?#]/.test(handle);
}

export interface VideoSettings {
  contentKey: string;
  pollMs: number;
  renderTimeoutMs: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new UpstreamError("upstream render timed out"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = (): void => {
      clearTimeout(timer);
      reject(new UpstreamError("upstream render timed out"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** Asks about the render until it ends. A blank line each time keeps the dispatch open. */
async function render(
  request: MediaRequest,
  settings: VideoSettings,
  videoId: string,
  emit: Emit,
): Promise<JsonObject> {
  const limit = AbortSignal.timeout(settings.renderTimeoutMs);
  const bounded: MediaRequest = { ...request, signal: AbortSignal.any([request.signal, limit]) };
  for (;;) {
    await sleep(settings.pollMs, bounded.signal);
    await emit(null);
    const job = await call(bounded, "GET", `videos/${videoId}`, undefined, jsonOf).catch((error) => {
      throw limit.aborted && !request.signal.aborted
        ? new UpstreamError("upstream render timed out")
        : error;
    });
    if (job["status"] === "completed") return job;
    if (job["status"] !== "queued" && job["status"] !== "in_progress") {
      throw new UpstreamError(`the upstream ended the render as ${JSON.stringify(job["status"])}`);
    }
  }
}

export async function renderVideo(
  request: MediaRequest,
  settings: VideoSettings,
  model: string,
  prompt: string,
  bound: VideoBound,
  emit: Emit,
  log: () => void,
): Promise<void> {
  const body: JsonObject = { model, prompt, seconds: String(bound.seconds) };
  if (bound.size) body["size"] = bound.size;
  const created = await call(request, "POST", "videos", body, jsonOf);
  const videoId = created["id"];
  if (typeof videoId !== "string" || !usableHandle(videoId)) {
    throw new UpstreamError("the upstream accepted the video job and returned no usable id");
  }
  log();
  const finished = await render(request, settings, videoId, emit);
  // Read the file's headers before the exchange hears of it. A file that the upstream
  // cannot serve fails the job now, and not as a failed download after the buyer paid.
  const opened = await open(request, "GET", `videos/${videoId}/content`);
  let mime: string;
  let size: number;
  let hasLength: boolean;
  try {
    opened.headersDone();
    mime = mimeOf(opened.response);
    hasLength = opened.response.headers.has("content-length");
    size = Number(opened.response.headers.get("content-length") || 0);
  } finally {
    opened.abort();
    opened.release();
  }
  if (!mime.startsWith("video/") || (size === 0 && hasLength)) {
    throw new UpstreamError("the upstream did not return a video file");
  }
  const expires = finished["expires_at"];
  await emit({
    type: "video_ready",
    handle: videoId,
    token: signHandle(settings.contentKey, videoId),
    mime,
    ...(size ? { bytes: size } : {}),
    ...(Number.isSafeInteger(expires) ? { expires_at: new Date((expires as number) * 1000).toISOString() } : {}),
  });
}

/** Opens the finished video of a handle. The caller streams the body and then calls `close`. */
export async function openVideo(
  request: MediaRequest,
  handle: string,
): Promise<{ response: Response; close(): void }> {
  const opened = await open(request, "GET", `videos/${handle}/content`);
  opened.headersDone();
  return {
    response: opened.response,
    close: () => {
      opened.abort();
      opened.release();
    },
  };
}
