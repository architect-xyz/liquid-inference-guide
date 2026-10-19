import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_ID, PROVIDER_ID, listedModel, startRig, until, type Rig } from "./harness.js";

let rig: Rig;

afterEach(async () => {
  await rig.stop();
});

describe("session", () => {
  describe("login and first quote", () => {
    beforeEach(async () => {
      rig = await startRig();
    });

    it("logs in with the slug, key and dispatch url", async () => {
      const login = await until(() => rig.exchange.frames("login")[0]);
      expect(login).toEqual({
        type: "login",
        slug: "acme",
        api_key: "test-provider-key",
        dispatch_url: "https://provider.example.com/dispatch",
        capabilities: [],
      });
    });

    it("quotes the listed deployment with rates as JSON numbers", async () => {
      const quote = await until(() => rig.exchange.frames("quote")[0]);
      expect(quote).toMatchObject({
        type: "quote",
        target: { kind: "registered", model_id: MODEL_ID },
        execution_limits: { max_input_tokens: 128000, max_output_tokens: 4096 },
        rate_uncached_input: 0.1,
        rate_cache_read: 0.02,
        rate_generation: 0.2,
        fixed_fee: 0,
        service_class: { ttft_ms: 1500, completion_ms: 30000 },
        supported_features: ["text"],
        retention_policy_supported: ["allowed"],
        valid_for_ms: 60000,
        revision: 1,
      });
      expect(typeof quote["execution_ref"]).toBe("string");
      await until(() => (rig.provider.session.providerId === PROVIDER_ID ? true : undefined));
      await until(() => (rig.provider.session.snapshots.size === 1 ? true : undefined));
    });

    it("sends heartbeats while it has nothing else to send", async () => {
      await until(() => rig.exchange.frames("heartbeat")[0], 3000);
    });
  });

  it("does not quote a deployment that the listed frame omits", async () => {
    rig = await startRig();
    await until(() => rig.exchange.frames("quote")[0]);
    const socket = rig.exchange.sockets[0];
    if (socket === undefined) throw new Error("no session");
    rig.exchange.send(socket, { type: "listed", models: [] });
    const withdraw = await until(() => rig.exchange.frames("withdraw_quote")[0]);
    expect(withdraw).toEqual({
      type: "withdraw_quote",
      target: { kind: "registered", model_id: MODEL_ID },
    });
    expect(rig.exchange.frames("quote")).toHaveLength(1);
  });

  it("does not quote an image deployment", async () => {
    rig = await startRig({}, (exchange) => {
      exchange.models = [listedModel({ kind: "image", pricing_unit: "images" })];
    });
    await until(() => rig.exchange.frames("login")[0]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(rig.exchange.frames("quote")).toHaveLength(0);
  });

  it("quotes again with a higher revision before the quote expires", async () => {
    rig = await startRig({ quoteLifetimeMs: 600 });
    const quotes = await until(() => {
      const found = rig.exchange.frames("quote");
      return found.length >= 3 ? found : undefined;
    });
    expect(quotes.map((quote) => quote["revision"])).toEqual([1, 2, 3].slice(0, quotes.length));
    expect(quotes[1]?.["execution_ref"]).toBe(quotes[0]?.["execution_ref"]);
  });

  it("schedules the next quote from the lifetime that the exchange accepted", async () => {
    rig = await startRig({ quoteLifetimeMs: 60000 }, (exchange) => {
      exchange.ackValidForMs = 400;
    });
    await until(() => (rig.exchange.frames("quote").length >= 2 ? true : undefined));
  });

  it("stops quoting after a superseded refusal until the next listed frame", async () => {
    rig = await startRig({ quoteLifetimeMs: 400 });
    rig.exchange.autoAck = false;
    const socket = await until(() => rig.exchange.sockets[0]);
    await until(() => rig.exchange.frames("quote")[0]);
    rig.exchange.send(socket, {
      type: "quote_reject",
      model_id: MODEL_ID,
      reason: "newer session",
      code: "superseded",
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(rig.exchange.frames("quote")).toHaveLength(1);
    rig.exchange.send(socket, { type: "listed", models: [listedModel()] });
    await until(() => (rig.exchange.frames("quote").length === 2 ? true : undefined));
  });

  it("connects again after the exchange closes the session, and quotes from revision 1", async () => {
    rig = await startRig();
    await until(() => rig.exchange.frames("quote")[0]);
    rig.exchange.sockets[0]?.close();
    const second = await until(() => rig.exchange.sockets[1]);
    expect(second).toBeDefined();
    await until(() => (rig.exchange.frames("login").length === 2 ? true : undefined));
    await until(() => (rig.exchange.frames("quote").length === 2 ? true : undefined));
    expect(rig.exchange.frames("quote")[1]?.["revision"]).toBe(1);
  });

  it("stays in standby after superseded and does not log in again", async () => {
    rig = await startRig();
    await until(() => rig.exchange.frames("quote")[0]);
    const socket = rig.exchange.sockets[0];
    if (socket === undefined) throw new Error("no session");
    rig.exchange.send(socket, { type: "superseded" });
    await until(() => (rig.provider.session.standby ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(rig.exchange.frames("login")).toHaveLength(1);
  });

  it("withdraws every quote when it stops", async () => {
    rig = await startRig();
    await until(() => rig.exchange.frames("quote")[0]);
    await rig.provider.stop();
    expect(rig.exchange.frames("mass_withdraw")).toHaveLength(1);
  });
});
