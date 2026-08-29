# ADR-0029: Scope every TLS opt-out to one network surface; add no union switch

## Status

accepted

**Domains**: llm, analyzer, cli

## Context

OpenLore has two outbound surfaces (LLM providers, embedding endpoints). Their operator levers were inverted: embeddings had an env-only opt-out (EMBED_SKIP_SSL_VERIFY), the LLM path had a flag-only one (--insecure). So the surfaces that never parse a command line — the `openlore mcp` daemon and the pre-commit decisions gate — had no operator lever at all for LLM TLS.

Closing that gap by adding LLM_SKIP_SSL_VERIFY, deliberately WITHOUT a global union key such as OPENLORE_INSECURE_TLS. Needing to relax one surface and not the other is the ordinary case, not the exception: an internal self-signed embedding server sits alongside an LLM vendor presenting a perfectly valid certificate. A union switch would force the operator to relax BOTH to fix one — a strictly larger exposure than the problem requires — and it would be the broadest ambient lever in the codebase while a long-lived daemon is running. The case a union key would serve (every outbound endpoint behind one internal CA) is served correctly by NODE_EXTRA_CA_CERTS, which makes certificates VERIFY rather than skipping the check; verified empirically that Node's built-in fetch honours it (Node 24.15.0).

Corollary enforced in code: every relaxable request site must consult a surface helper (llmTlsRelaxed / embeddingTlsRelaxed). Passing an explicit `false` to withRelaxedTls silently opts a site out of the CLI flag, and omitting the argument silently opts it out of the env key — the codebase had one of each, which is why --insecure did not reach embeddings and the LLM env key did not reach the viewer's chat and model-listing requests (six sites).

The repo-config trust boundary is unchanged: llm.sslVerify:false and embedding.skipSslVerify:true stay refused, because a clone must not disable certificate verification on the machine analyzing it. Only the operator's flags and environment can. This strengthens, and does not contradict, the existing api requirement ApiGenerateDoesNotMutateProcessTls.

## Decision

The system SHALL provide scoped TLS opt-out capabilities for each network surface without introducing a global union switch.

## Consequences

Two scoped env keys (EMBED_SKIP_SSL_VERIFY, LLM_SKIP_SSL_VERIFY) and no union key. A new outbound surface must add its own scoped key plus a surface helper, not reuse another surface's. Docs lead with NODE_EXTRA_CA_CERTS as the preferred fix. A policy test (src/tls-opt-out-policy.test.ts) fails if a union key is reintroduced or a variable stops being documented as surface-scoped.

> Recorded by openlore decisions on 2026-08-28
> Decision ID: b8520b68


