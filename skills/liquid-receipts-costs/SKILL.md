---
name: liquid-receipts-costs
description: Read Liquid Inference job receipts and explain what a request cost, which provider served it and why. Use when the user asks about charges, cap vs actual cost, a job id, spend by team, or wants to verify a client is routed through the exchange.
---

# Liquid Inference receipts and costs

Every settled job has an immutable receipt.

```bash
curl https://router.inference.ai.exchange/v1/exchange/jobs/<job_id> \
  -H "Authorization: Bearer $LIQUID_API_KEY"
```

Needs a key with `read` scope or higher. The route returns the charge breakdown, the `exchange` block and the purchase requested. `GET /v1/jobs/{job_id}` returns only the `exchange` block. The receipt is written just after the answer, so an immediate call can return `404`; retry.

## Where the job id comes from

The `x-liquid-job-id` response header, or `exchange.job_id` in the response body. `x-liquid-cap-usd` is the cap.

## Cap vs charge

- `cap_usd`: the maximum, fixed before the first token. It covers the cold worst case.
- `buyer_charge_usd`: what the job actually cost, from measured use.

A client's own cost display (for example `total_cost_usd` in the Claude Agent SDK) is an estimate from token counts. Report the receipt's number.

## Verify the routing

The receipt names the client (for example Claude Agent SDK, Vercel AI SDK) from the user agent or `X-Title` header, and shows its cap. If a harness's requests do not appear in the console, they are going somewhere else; check for settings files that override the base URL.

## Attribute spend

Send `x-liquid-tag: <label>` to group spend by team or project. Give each unattended process its own key with a spending limit.

## Debug routing

Send `x-liquid-explain: true` to get a `routing` object: serving provider id, pricing rule, offers considered and eligible, counts of exclusions. For a refused request, `error.eligibility.excluded` lists each excluded offer and why.

## Prompt-cache charges

Cached input is priced at the offer's cache-read rate. Written tokens are billed at the offer's cache-write rate, or as uncached input when the offer has none or the buyer set no cache breakpoint.
