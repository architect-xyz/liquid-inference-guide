---
name: liquid-troubleshoot
description: Diagnose Liquid Inference API errors (401, 402, 403, 404, no_eligible_offer, provider_failed, invalid_header, unsupported_parameter and more). Use when a request to the exchange fails or a harness/SDK pointed at it misbehaves.
---

# Troubleshooting Liquid Inference

Match on `error.code`, not the message. The OpenAI-format body is:

```json
{"error": {"message": "...", "type": "liquid_error", "code": "unsupported_parameter", "param": "reasoning.effort", "eligibility": {"excluded": []}}}
```

`/v1/messages` returns the Anthropic error format but keeps `code`, `param`, `eligibility` and `provider`. A `502`/`504` with an HTML body is the network in front of the exchange, not the exchange.

## Common codes

| Status | Code | Fix |
| --- | --- | --- |
| 401 | `invalid_api_key` | Key missing, unknown, revoked or expired. Re-export `LIQUID_API_KEY`. |
| 403 | `insufficient_permission` | Key scope too low. Placing jobs needs `spend`. |
| 404 | `model_not_found` | Name not on the book. Check `GET /v1/models`. Also check the base URL ends in `/v1` (OpenAI) or has none (Anthropic). |
| 400 | `invalid_request` | Bad body or unknown `exchange` field; `param` names it. |
| 400 | `invalid_header` | An `x-liquid-*` header could not be parsed. |
| 400 | `unsupported_parameter` | No offer for the model supports `param`. Remove it or pick another model. |
| 400 | `unsupported_content` | An attachment no offer can serve (remote non-image URL, unreadable header, video input). |
| 400 | `no_eligible_offer` | The request's own rules excluded every offer, for example a cap below every estimate. Do not retry unchanged. |
| 503 | `no_eligible_offer` | A cause outside the rules excluded offers. See `eligibility.excluded`. Retry later or loosen. |
| 503 | `model_unavailable` | No seller can serve that single model right now. |
| 503 | `provider_failed` | Awarded provider failed. The exchange already tried the next offer if no output had started. |
| 402 | `insufficient_balance` | Cheapest eligible cap exceeds the balance (`needed_usd`, `balance_usd`). Add funds. |
| 402 | `budget_exhausted` | The key's spending limit or a guardrail budget is spent. |
| 403 | `guardrail_violation`, `content_blocked` | A workspace guardrail refused the request. |
| 409 | `idempotency_conflict` | `idempotency-key` reused with a different body. |
| 413 | `request_too_large` | Body over 20 MB by default (base64 is a third larger). |
| 429 | `rate_limited` | Too many requests from the address. |

## Harness and SDK symptoms

- Requests go to Anthropic or another gateway: a settings file `env` block overrides yours. For the Claude Agent SDK pass `setting_sources=[]`.
- `stop_reason: max_tokens` or cap refusals right after setup: the client asked for more output than offers allow. Lower the client's max output tokens.
- Anthropic client 404 on `/v1/v1/messages`: remove `/v1` from the base URL.
- `unsupported_parameter` on a response-state field (`previous_response_id`, `conversation`): the exchange keeps no state; resend full history.
- LangChain embeddings refused: set `check_embedding_ctx_length=False`.
