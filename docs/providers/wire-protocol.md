# Provider wire protocol

Condensed from the Liquid Inference provider docs. The OpenAPI document at `https://router.inference.ai.exchange/v1/openapi.json` names agent frames `ProviderMessage` and exchange frames `ExchangeMessage`. When this page and the OpenAPI document disagree, the OpenAPI document wins.

Two channels carry a job:

1. A **WebSocket session** for login, quotes, award notices and settlement notices.
2. An **HTTP dispatch endpoint** that the exchange calls with the job, and that streams the answer back.

All session frames are JSON objects with a `type` field.

## Session

Connect to `wss://router.inference.ai.exchange/v1/provider/ws`. No headers are needed. The exchange closes the socket if `login` is more than five seconds late or any frame is 1 MiB or larger.

### Login

The first frame must be `login`. Any other frame gets `login_reject` and a close.

```json
{
  "type": "login",
  "slug": "acme",
  "api_key": "sk-liquid-...",
  "dispatch_url": "https://provider.example.com/dispatch",
  "capabilities": []
}
```

`dispatch_url` must match the registered `declared_endpoint` in scheme, host and port. The path is free. Send `["handover"]` in `capabilities` only if the agent supports a gapless move to a new exchange process. A new login for the same provider replaces the current session and removes its offers, unless `handover` applies.

The exchange answers `login_ack` (with `provider_id`, `slug`, `server_time`) and then `listed`.

### Listed deployments

`listed` carries every `LISTED` deployment and every `UNLISTED` one (`"unverified": true`). Quote only the deployments in the newest `listed` frame.

```json
{
  "type": "listed",
  "models": [{
    "model_id": "3f0c...",
    "unverified": false,
    "deployment_name": "acme/gpt-oss-120b",
    "model": "gpt-oss-120b",
    "creator": "OpenAI",
    "precision": "fp8",
    "region": "eu-west",
    "max_input_tokens": 128000,
    "max_output_tokens": 4096,
    "tokenizer_id": "o200k_base",
    "markup_bps": 1500
  }]
}
```

`model` is the upstream identifier. `canonical_model` is the public name. The reference code reads `deployment_name`; older provider docs show the same field as `model_deployment`, so accept either.

### Quote

Send one `quote` per listed deployment, and again each time the price changes.

```json
{
  "type": "quote",
  "target": { "kind": "registered", "model_id": "3f0c..." },
  "rate_uncached_input": 0.12,
  "rate_cache_read": 0.03,
  "rate_generation": 0.48,
  "fixed_fee": 0,
  "service_class": { "ttft_ms": 1500, "completion_ms": 30000 },
  "supported_features": ["text"],
  "retention_policy_supported": ["none"],
  "valid_for_ms": 600000,
  "revision": 7
}
```

Rates are JSON numbers in USD per million tokens (`fixed_fee` is USD per job). Required fields: `target`, `service_class`, `retention_policy_supported` and `revision`. `revision` must increase within a session. Missing a `ttft_ms` or `completion_ms` deadline earns the buyer a credit. A quote can change only prices, deadlines and declared capabilities; model, precision, region, limits and tokenizer come from registration.

The Python reference also sends `execution_ref` and `execution_limits` copied from the `listed` entry. See `providers/python/provider.py` and the OpenAPI document for their exact shape.

Each quote gets exactly one answer:

- `quote_ack`: `offer_id`, `revision`, `activation_seq`, `valid_for_ms` (a duration from now, so clock skew does not matter) and optional `notes`.
- `quote_reject`: `model_id`, `reason`, a stable `code`, and sometimes `field`. Branch on `code` and `field`, never parse `reason`.

Quote again well before `valid_for_ms` ends. The references re-quote at half the lifetime.

### Award

When an offer wins, the session receives:

```json
{
  "type": "award_notice",
  "award_id": "aw_...",
  "job_id": "job_...",
  "offer_id": "3f0c...",
  "served_model": "gpt-oss-120b",
  "cap_usd": 0.0184,
  "max_output_tokens": 1024,
  "schema_version": "2026-09"
}
```

`cap_usd` is the maximum charge, fixed before the buyer sees output.

### Other frames from the exchange

| Frame | Meaning |
| --- | --- |
| `login_reject` | Login refused, with `reason`. The socket closes. |
| `settlement_notice` | A job settled: `meters`, `supplier_charge_usd`, `credit_usd`, `status`. |
| `risk_notice` | Information or warning with `severity` and `message`. |
| `heartbeat` | Reply to the agent's `heartbeat`. |
| `handover` | This exchange process stops soon. |
| `superseded` | A newer session holds all offers. Do not reconnect. |

## Dispatch

The exchange sends `POST` to the session's `dispatch_url`. The `idempotency-key` header holds the award id.

```json
{
  "award_id": "aw_...",
  "job_id": "job_...",
  "offer_id": "3f0c...",
  "served_model": "gpt-oss-120b",
  "messages": [
    { "role": "system", "content": "You are terse." },
    { "role": "user", "content": "Hello" }
  ],
  "max_output_tokens": 1024,
  "temperature": 0.2,
  "stream": true
}
```

The exchange sends a parameter only to offers that declared support for it. Optional fields include `tools`, `tool_choice`, `response_format`, sampling parameters, `reasoning`, `cache` and attachment `parts`. The full list is in the OpenAPI document.

### Response

Reply `200` with `Content-Type: application/x-ndjson`, one JSON event per line. Always stream, whatever `stream` says.

```
{"type":"delta","text":"There is a "}
{"type":"delta","text":"red bicycle."}
{"type":"done","finish_reason":"stop","usage":{"meters":{"uncached_input":412,"cache_read":0,"cache_write_short":0,"cache_write_long":0,"generation":6},"tokenizer_id":"o200k_base","reasoning_tokens":null,"raw":{}}}
```

| Event | Fields | Notes |
| --- | --- | --- |
| `delta` | `text` | The first one stops the time-to-first-token clock. |
| `reasoning` | `text` | Does not stop the clock. After it, the job cannot change provider. |
| `tool_call_start`, `tool_call_delta` | `index`, `id`, `name`, `arguments` | Join argument parts per `index`. |
| `done` | `finish_reason`, `usage` | Success. Terminal. |
| `failed` | `code`, `message` | Failure. Terminal. |

`usage.meters` counts each token in exactly one meter: `uncached_input`, `cache_read`, `cache_write_short`, `cache_write_long`, `generation`. `tokenizer_id` must equal the registered one. `raw` is the upstream usage object, kept as evidence. Never estimate counts you were not given.

### Idempotency and failures

- Record award ids. Refuse a repeated delivery before any upstream work with `409 {"error":"duplicate_award"}`.
- A non-`2xx` status or a connection that fails ends the attempt. The exchange charges nothing and tries the next offer.
- If the response stops with no terminal event after the exchange accepted the dispatch, the job fails with `503 provider_failed` and no other offer is tried.
- Report an upstream error with a `failed` event whose `message` starts `<upstream> returned <status>: `. Codes: `tools_unsupported`, `request_rejected`, `upstream_account_limited`.

### Settlement

The exchange settles on the `done` meters at the winning quote's rates, plus `fixed_fee`, minus buyer credits. Output above the award's `max_output_tokens` is charged to you. Failed jobs earn nothing. A `settlement_notice` follows `done`.

## Not covered here

Image, speech and video dispatch, logprobs, reasoning blocks, prompt-cache breakpoints, attachments, payout onboarding and the `handover` procedure. Read the OpenAPI document and the Liquid Inference provider docs for those.
