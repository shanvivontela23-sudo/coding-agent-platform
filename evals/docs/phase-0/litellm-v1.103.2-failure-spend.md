# LiteLLM v1.103.2 failed-request spend rows

This note records the source verification used by P0-05B spend reconciliation.

## Exact source checked

LiteLLM tag `v1.103.2`, file:

`litellm/proxy/hooks/proxy_track_cost_callback.py`

Git blob checked: `425466396f42ec210e3b4481b972ab67c53b3e89`.

## Finding

`_ProxyDBLogger.async_post_call_failure_hook` does have a database-spend path for failed requests, but it is conditional:

- failure tracking must be enabled by `_should_track_errors_in_db()`;
- when a request route is known, it must be an LLM API or info route;
- when those checks pass, the hook calls the spend writer's `update_database(...)` for the failed request.

For a failed request with no recovered streamed usage, `recovered_stream_cost` is `0.0`. The written response cost is therefore zero apart from any separately attributable guardrail cost. This is the normal shape expected for provider-side rejections such as rate-limit and context-length failures that consumed no model tokens.

The important consequence is that LiteLLM v1.103.2 is designed to write a zero-cost spend row for tracked LLM failures, but a spend row is not an unconditional invariant for every failed request.

## Gateway reconciliation rule

P0-05B therefore keeps the strict paid-call audit with one narrow exception:

- only a paid call explicitly recorded from an upstream non-2xx response, with no observed usage, can tolerate a missing LiteLLM spend row;
- `reconcileRun` still waits through the normal bounded reconciliation window, so a delayed failure row has time to appear;
- if a row appears, that LiteLLM row is authoritative and its spend is applied normally;
- if no row appears by the reconciliation deadline, that eligible failure is settled at `$0`;
- timeout, interruption, transport failure, malformed successful responses, and all other paid calls still require authoritative reconciliation under the existing rules.

This keeps missing spend fail-closed everywhere except the provider-rejection case where the gateway has positive evidence that no usage was observed and LiteLLM's own failure-log path is conditional.
