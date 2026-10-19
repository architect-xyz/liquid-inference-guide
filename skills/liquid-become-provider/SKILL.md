---
name: liquid-become-provider
description: Sell inference on Liquid Inference as a provider: registration, keys, the WebSocket quote session, dispatch endpoint and usage reporting, with reference agents in Python, TypeScript and Rust. Use when the user wants to list a model, write a provider agent, or debug login_reject/quote_reject.
---

# Becoming a Liquid Inference provider

Reference docs and code: `https://github.com/architect-xyz/liquid-inference-guide` (`docs/providers/`, `providers/python`, `providers/typescript`, `providers/rust`). Read `docs/providers/wire-protocol.md` first.

## Lifecycle

1. Register a provider in the console (status `PENDING`). An operator must admit it; you cannot admit yourself.
2. Issue a provider key (shown once). It opens the session and catalogue endpoints only. Rotate by issuing a new key, restarting the agent, then revoking the old one.
3. Register deployments (upstream model id, tokenizer, region, precision, token limits).
4. Run an agent: WebSocket `wss://router.inference.ai.exchange/v1/provider/ws`, an HTTP dispatch endpoint that is publicly reachable and matches the registered `declared_endpoint` in scheme, host and port.

## Session flow

`login` (within 5 s) -> `login_ack` -> `listed` -> one `quote` per listed deployment (strictly increasing `revision`) -> `quote_ack` / `quote_reject` (branch on `code`) -> `award_notice` -> `settlement_notice`. Re-quote well before `valid_for_ms` ends (references do it at half). A new login for the same provider replaces the old session unless `handover` is used.

## Dispatch rules

- The exchange POSTs the job; `idempotency-key` is the award id.
- Claim the award id durably before any upstream work. A repeat gets `409 {"error":"duplicate_award"}`.
- Reply `200 application/x-ndjson`: `delta` events, then `done` with `usage.meters` (`uncached_input`, `cache_read`, `cache_write_short`, `cache_write_long`, `generation`), `tokenizer_id` equal to the registered one, and the upstream usage in `raw`. Never estimate counts; if the upstream gives no final usage, fail.
- On upstream error send a `failed` event whose message starts `<upstream> returned <status>: `.
- On shutdown, stop quoting first and let in-flight dispatches finish; the buyer pays for them.

## Pick a reference

| Language | Path | Notes |
| --- | --- | --- |
| Python | `providers/python/provider.py` | Tested against a real router; supports handover; SQLite journal. |
| TypeScript | `providers/typescript` | Port; offline tests only; no handover. |
| Rust | `providers/rust` | Port; offline tests only; no handover. |

## Debug

| Symptom | Check |
| --- | --- |
| `login_reject` | Admission, key, handle, registered endpoint. |
| Deployment missing from `listed` | Exact name, pause or suspension state. |
| Accepted quote, no jobs | Buyer's model, features, retention policy, deadlines and cap versus your quote. |
| `quote_reject` | Read `code` and `field`, not `reason`. |
