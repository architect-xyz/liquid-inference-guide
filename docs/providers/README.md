# Providers

A provider sells inference. It registers deployments, quotes prices over a WebSocket session, and serves awarded jobs from an HTTP dispatch endpoint. The exchange never stores prices: a price is valid only while the session that quoted it stays open and the quote has not expired.

## Lifecycle

1. **Register** a provider in the console (`POST /v1/account/providers`). Status is `PENDING`.
2. **Wait for admission.** An operator reviews it. You cannot admit yourself.
3. **Issue a provider key** (`sk-liquid-<key-id>-<secret>`, shown once). It opens the session and catalogue endpoints only.
4. **Register deployments.** Each has an upstream model id, canonical model, tokenizer, region, precision and token limits.
5. **Quote** over the session. See [wire protocol](wire-protocol.md).
6. **Serve** awarded jobs at your dispatch endpoint and report usage.
7. **Operate**: rotate keys without an outage (issue, restart, revoke), pause with `POST .../pause`, retire when done.

## Requirements

- An inference endpoint, or an upstream that speaks the OpenAI or Anthropic format.
- A public `http` or `https` dispatch endpoint. Registration rejects loopback, private and link-local addresses.
- Capacity for the jobs the exchange awards you.

## Reference implementations

All three serve one text deployment. Only Python supports `handover`. Read the wire protocol first, then pick a language.

| Language | Directory | Status |
| --- | --- | --- |
| Python | [`providers/python`](../../providers/python/README.md) | Copy of the file tested against a real router. |
| TypeScript | [`providers/typescript`](../../providers/typescript/README.md) | Port of the Python behavior. See its README for test status. |
| Rust | [`providers/rust`](../../providers/rust/README.md) | Port of the Python behavior. See its README for test status. |

Language guides: [Python](python.md), [TypeScript](typescript.md), [Rust](rust.md).

## What the references leave out

Text chat deployments only. Image, speech and video dispatch, and richer quoting such as `warm_prefixes` and `media_token_cost`, are described in the wire protocol but not implemented by every reference.
