import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  award,
  dispatchBody,
  events,
  post,
  readyReference,
  startRig,
  until,
  type Rig,
} from "./harness.js";

let rig: Rig;
let reference: string;

beforeEach(async () => {
  rig = await startRig();
  reference = await readyReference(rig);
});

afterEach(async () => {
  await rig.stop();
});

describe("dispatch", () => {
  it("streams ndjson deltas and a done event with meters", async () => {
    await award(rig, "aw_1");
    const response = await post(rig, dispatchBody("aw_1", reference));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const list = await events(response);
    expect(list).toEqual([
      { type: "delta", text: "Hello" },
      { type: "delta", text: " world" },
      {
        type: "done",
        finish_reason: "stop",
        usage: {
          meters: {
            uncached_input: 40,
            cache_read: 60,
            cache_write_short: 0,
            cache_write_long: 0,
            generation: 7,
          },
          tokenizer_id: "o200k_base",
          reasoning_tokens: null,
          raw: {
            prompt_tokens: 100,
            completion_tokens: 7,
            total_tokens: 107,
            prompt_tokens_details: { cached_tokens: 60 },
          },
        },
      },
    ]);
  });

  it("calls the upstream with the served model, the cap and usage streaming", async () => {
    await award(rig, "aw_2");
    await events(await post(rig, dispatchBody("aw_2", reference)));
    const call = rig.upstream.calls[0];
    expect(call?.headers["authorization"]).toBe("Bearer test-upstream-key");
    expect(call?.body).toEqual({
      model: "upstream-model",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "Say hello." },
      ],
      max_tokens: 256,
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("claims the award on disk before the upstream request", async () => {
    await award(rig, "aw_3");
    await events(await post(rig, dispatchBody("aw_3", reference)));
    expect(rig.upstream.calls[0]?.journalAtArrival).toContain("aw_3");
    expect(readFileSync(rig.journalPath, "utf8")).toContain("aw_3");
  });

  it("answers a repeated award with 409 and makes no second upstream call", async () => {
    await award(rig, "aw_4");
    await events(await post(rig, dispatchBody("aw_4", reference)));
    const again = await post(rig, dispatchBody("aw_4", reference));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "duplicate_award" });
    expect(rig.upstream.calls).toHaveLength(1);
  });

  it("serves only one of two concurrent deliveries of the same award", async () => {
    await award(rig, "aw_5");
    const [first, second] = await Promise.all([
      post(rig, dispatchBody("aw_5", reference)),
      post(rig, dispatchBody("aw_5", reference)),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    await Promise.all([first.text(), second.text()]);
    expect(rig.upstream.calls).toHaveLength(1);
  });

  it("refuses a repeat after a restart because the journal survives", async () => {
    await award(rig, "aw_6");
    await events(await post(rig, dispatchBody("aw_6", reference)));
    const { Journal } = await import("../src/journal.js");
    const reopened = new Journal(rig.journalPath);
    expect(reopened.contains("7c9e0000-0000-4000-8000-000000000002", "aw_6")).toBe(true);
    expect(reopened.claim("7c9e0000-0000-4000-8000-000000000002", "aw_6")).toBe(false);
    reopened.close();
  });

  it("sends a failed event when the upstream answers with an error", async () => {
    rig.upstream.mode = "http500";
    await award(rig, "aw_7");
    const response = await post(rig, dispatchBody("aw_7", reference));
    expect(response.status).toBe(200);
    const list = await events(response);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      type: "failed",
      code: "upstream_failed",
      message: 'upstream returned 500: {"error":"boom"}',
    });
  });

  it("sends a failed event when the upstream ends without usage, after its output", async () => {
    rig.upstream.mode = "no-usage";
    await award(rig, "aw_8");
    const list = await events(await post(rig, dispatchBody("aw_8", reference)));
    expect(list.map((event) => event["type"])).toEqual(["delta", "delta", "failed"]);
  });

  it("sends a failed event when the usage reports a cache write", async () => {
    rig.upstream.usage = {
      prompt_tokens: 10,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 4 },
    };
    await award(rig, "aw_9");
    const list = await events(await post(rig, dispatchBody("aw_9", reference)));
    expect(list.at(-1)?.["type"]).toBe("failed");
  });

  it("refuses a dispatch with no award notice", async () => {
    const response = await post(rig, dispatchBody("aw_none", reference));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_dispatch" });
    expect(rig.upstream.calls).toHaveLength(0);
  });

  it("accepts an award notice that arrives just after the dispatch", async () => {
    const pending = post(rig, dispatchBody("aw_late", reference));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await award(rig, "aw_late");
    expect((await pending).status).toBe(200);
  });

  it("refuses an idempotency key that differs from the award id", async () => {
    await award(rig, "aw_10");
    const response = await post(rig, dispatchBody("aw_10", reference), { "idempotency-key": "other" });
    expect(response.status).toBe(400);
  });

  it.each([
    ["a field that differs from the award", { job_id: "job_other" }],
    ["an unknown execution_ref", { execution_ref: "00000000-0000-4000-8000-000000000000" }],
    ["output above the award limit", { max_output_tokens: 2048 }],
    ["zero output tokens", { max_output_tokens: 0 }],
    ["tools", { tools: [{ name: "lookup" }] }],
    ["a seed of zero", { seed: 0 }],
    ["an image part", { messages: [{ role: "user", content: "x", parts: [{ type: "image_url", url: "u" }] }] }],
    ["a tool role", { messages: [{ role: "tool", content: "x" }] }],
    ["prompt cache breakpoints", { cache: { breakpoints: [{ anchor: { at: "tools" }, ttl: "5m" }] } }],
  ])("refuses %s before it claims the award", async (_name, overrides) => {
    const id = "aw_bad";
    await award(rig, id);
    const response = await post(rig, dispatchBody(id, reference, overrides));
    expect(response.status).toBe(400);
    expect(rig.upstream.calls).toHaveLength(0);
    const ok = await post(rig, dispatchBody(id, reference));
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it("forgets an award when the settlement notice arrives", async () => {
    await award(rig, "aw_11");
    await events(await post(rig, dispatchBody("aw_11", reference)));
    const socket = rig.exchange.sockets[0];
    if (socket === undefined) throw new Error("no session");
    rig.exchange.send(socket, { type: "settlement_notice", award_id: "aw_11", job_id: "job_aw_11", status: "settled" });
    await until(() => (rig.provider.session.awards.has("aw_11") ? undefined : true));
  });

  it("reports health", async () => {
    const address = new URL(rig.dispatchUrl);
    const response = await fetch(`${address.origin}/health`);
    expect(await response.json()).toEqual({
      connected: true,
      standby: false,
      deployment: "test-deployment",
    });
  });

  it("finishes a dispatch in progress during a graceful shutdown", async () => {
    let release: () => void = () => {};
    rig.upstream.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await award(rig, "aw_12");
    const response = await post(rig, dispatchBody("aw_12", reference));
    expect(response.status).toBe(200);
    const body = events(response);
    await until(() => (rig.upstream.calls.length === 1 ? true : undefined));
    const stopping = rig.provider.stop();
    await until(() => (rig.exchange.frames("mass_withdraw").length === 1 ? true : undefined));
    const refused = await post(rig, dispatchBody("aw_13", reference)).catch(() => undefined);
    expect(refused === undefined || refused.status === 503).toBe(true);
    release();
    const list = await body;
    expect(list.at(-1)?.["type"]).toBe("done");
    await stopping;
  });
});
