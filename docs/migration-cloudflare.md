# Cloudflare migration proposal (withdrawn)

Status: withdrawn on 2026-11-07. After considering managed AI Search and then R2/Vectorize with custom hybrid retrieval, the user chose to keep the existing OpenAI ecosystem to avoid additional infrastructure and search-maintenance complexity. Retain OpenAI Files, Vector Stores and Responses, the existing Sites-hosted stateless MCP, and the current private plugin connection. No Cloudflare migration, new endpoint, custom BM25 index, or separate reranking pipeline is planned.

The sections below preserve the earlier managed AI Search proposal as historical reference only. They are not current instructions or authorization to provision resources, migrate data, or switch clients. Later discussion selected `agent-memory` resource names, `memory.11mm.dev`, and GitHub sign-in for a possible direct Vectorize rewrite; those choices are also inactive following withdrawal. No Cloudflare resources were created as part of preparing this proposal.

## Target and defaults

Move the stateless MCP runtime into the user's Cloudflare account, original documents/metadata into R2, and retrieval into managed Cloudflare AI Search. Keep the existing Personal / Agent Memory OpenAI API project, Sol medium writes/complex synthesis, and Luna low routine answers. Configure OpenAI `text-embedding-3-small` for AI Search through AI Gateway; use AI Search for retrieval only. Disable non-OpenAI generation, query rewriting and reranking in the search pipeline. Changing the embedding model later requires a new/rebuilt index; changing compatible generation models remains server configuration.

Use a single Worker for the MCP and OAuth endpoints to minimize deployed services. Use Cloudflare's maintained OAuth provider rather than custom token/security code, backed by KV for OAuth state only. Memory data and operation state remain in R2. No D1, Durable Objects, custom queues, local databases, Python hooks, or separate memory catalogue service. Stateless refers to the MCP process; durable records and tokens are external.

The new endpoint requires standard Streamable HTTP MCP initialization, discovery, tools, notifications and OAuth behavior. Do not copy the Sites-specific server/discover handshake as the only transport. Never accept Sites identity headers as authentication on a public standalone Worker.

### Naming checklist

Suggested base name: `agent-memory`. The user can replace the base once and derive the remaining names automatically, or override individual names.

| Named resource | Suggested name | Role |
| --- | --- | --- |
| Cloudflare Worker | `agent-memory-mcp` | Stateless MCP and OAuth endpoints |
| R2 bucket | `agent-memory-files` | Original knowledge, revisions, task logs, operations and manifests |
| AI Search namespace | `agent-memory` | Container for this service's search instance |
| AI Search instance | `agent-memory-search` | Managed project-scoped knowledge and log retrieval |
| AI Gateway | `agent-memory-ai` | OpenAI provider key for search embeddings |
| Workers KV namespace | `agent-memory-oauth` | OAuth clients, grants and tokens; no memory documents |
| AI Search R2 service-token label | `agent-memory-search-reader` | Least-privilege access for indexing the chosen bucket |
| Upstream sign-in application | `agent-memory-sign-in` | Suggested GitHub OAuth app, restricted to the owner's immutable identity |
| Private plugin display name | `Agent Memory MCP` | Replacement ChatGPT/Codex connection, not a public plugin release |

Suggested endpoint without custom DNS: `https://agent-memory-mcp.mx48live.workers.dev/mcp`. A custom hostname is optional and must be supplied before final OAuth callback URLs are registered. Internal binding names (`MEMORY_BUCKET`, `AI_SEARCH`, `OAUTH_KV`) and secret variable names are implementation details, not extra names the user needs to choose. Any temporary test resources get a generated suffix under the selected base.

Read-only preflight on 2026-11-07 found one account through the Personal connection, worker subdomain `mx48live`, no AI Search namespaces or AI Gateways, and no collisions with the suggested Worker/bucket/KV names in the returned inventory. The existing `remote-agent-memory` and `remote-agent-memory-preview` Workers are a different project; do not reuse, modify or delete them. Recheck availability and permissions before creating resources. Listing resources does not establish billing, entitlement, or write permissions.

### Inputs to confirm

- Base name or individual resource-name overrides.
- Cloudflare connection: Personal (recommended for this personal memory service) or Pi R SQUARE. Account IDs must come from live discovery after the connection is chosen.
- Endpoint: workers.dev initially (recommended) or an exact custom hostname.
- Sign-in: owner-restricted GitHub (recommended) or a specified alternative. Confirm the allowed identity before authorizing production access; never assign ownership to the first arbitrary visitor.

## 1. Prepare the target alongside the live service

1. Confirm names/account/hostname/sign-in and verify Workers, R2, AI Search, AI Gateway, KV and API permissions. Use the existing Cloudflare connector where sufficient. If a CLI is needed, use `cf` because this repository currently has no Wrangler configuration; do not install/configure Wrangler just to follow older examples.
2. Create only the named target resources. Configure the R2 indexing service credential for this bucket and the OpenAI embedding provider through AI Gateway. Keep API and sign-in secrets out of source, artifacts, diagnostics and chat. Disable unnecessary prompt/body logging and response caches containing memory content.
3. Add direct Cloudflare configuration and deployment scripts while preserving `.openai/hosting.json` as the old service's rollback identity. Retain JavaScript ESM; add only the maintained OAuth/MCP packages actually required for standards-compliant authorization/transport.
4. Deploy the target without making it the active memory backend. Keep production writes disabled until data verification/cutover. Run synthetic tests in an isolated prefix and temporary search instance so test data cannot be returned as real knowledge.
5. Implement owner authentication, consent, token audience/scope checks, logout/revocation and invalid-token responses. Exercise the browser login and MCP authorization flow before moving real memory.

## 2. Implement R2 storage and managed retrieval

Preserve the five tool names and their existing request fields: memory_projects, memory_query, memory_read, memory_complete and memory_status. Keep existing application project keys, memory/revision/operation IDs, task keys, payload hashes, source provenance, conflicts and timestamps.

Use one R2 bucket, with keys shaped as follows:

```text
projects/<project-key>/knowledge/<memory-id>/<revision-id>.md
projects/<project-key>/logs/<date>/<operation-id>.md
projects/<project-key>/operations/<operation-id>/plan.json
projects/<project-key>/operations/<operation-id>/receipt.json
projects/<project-key>/manifest.json
migrations/<run-id>/source-map.json
migrations/<run-id>/verification.json
```

- Original UTF-8 Markdown is canonical in R2; remove the base64 source envelope on the destination after validating it during export. Read exact content directly from R2 without embedding/model calls.
- Keep project/revision/operation metadata in R2 JSON records, not a new database. Use conditional object writes for per-project manifest updates so concurrent writers do not silently overwrite current state. Detect a failed precondition and re-read/reconcile; do not last-write-wins by timestamp. Immutable documents may exist before commit, but queries only accept committed records. There is no transaction spanning R2 and search.
- Index knowledge and logs with separate record types and explicit project metadata. Define the AI Search metadata schema for `project_key`, `record_type`, `memory_id`, `revision_id` and `operation_id`. Exclude manifests, recovery plans, receipts, migration records and test paths using path filters.
- Continue to validate retrieved hits against authoritative R2 revision/commit metadata. Never trust index freshness to decide current truth. Knowledge queries include the requested project plus global; log and cross-project queries remain explicit. Return pending/incomplete/conflict when necessary.
- Preserve existing input `file_id` as an opaque source identifier and store legacy OpenAI-file-ID aliases in the migration map. New records receive provider-neutral source IDs. Return a provider-neutral collection identifier rather than fabricating OpenAI vector-store IDs. Validate every citation against authorized evidence.

Keep the recovery contract: save an operation plan first, upload immutable documents, verify indexing, then publish completion evidence/current-state metadata. A bounded tool call may return pending; a later memory_status call resumes it. Managed AI Search performs indexing in the background, but no application work should depend on an abandoned Worker invocation continuing after its response.

## 3. Preserve and transfer existing hosted memory

This is a migration of the current hosted MCP records, including global knowledge and task history. It is not another fresh start. Do not import the archived local vault.

1. Inventory every application project, committed operation, knowledge revision, conflict, task log and pending operation. Export through the existing verified parsed-content/source-envelope path; do not assume raw OpenAI Files downloads work. Inventory failures and missing/corrupt envelopes stop the migration rather than skipping records.
2. Transfer originals directly to R2 and record source IDs, destination keys, SHA-256 hashes, record counts, predecessor relationships and payload hashes in a resumable migration manifest. Keep retries deterministic; do not submit historical tasks through memory_complete, re-extract facts, or append new completion logs for old tasks.
3. Verify hashes and lineage, then index the transferred source content with the explicitly selected OpenAI embedding model. Preserve historical documents but prevent stale/conflicted revisions from becoming established current facts.
4. Before final cutover, enable a controlled source write freeze, drain existing pending operations, and perform a final delta export. The old server needs an explicit maintenance/read-only guard; do not assume an unused environment variable freezes writes. Verify a stable final inventory after accounting for source listing/indexing delays. Do not dual-write independent facts to both backends.
5. If an operation cannot be drained, resolve it explicitly before cutover. Never classify unfinished operations as completed or erase their saved recovery plans.

## 4. Acceptance and client cutover

Run `npm test` and the new Cloudflare build on final runtime changes. Add storage/auth integration coverage and a disposable paid-model smoke check proportionate to the changed pipeline.

Required acceptance scenarios:

1. Exact source/hash/record-count agreement for all exported records; global/project/log separation; preserved conflicts and historical reads through old source IDs.
2. Repeated submissions, changed-payload task-key reuse, concurrent manifest updates, conflicting corrections, interruption/restart/resume, failed embeddings and delayed/stale index results.
3. Missing/expired/revoked tokens, wrong audience/scope, unauthorized identities, and forged Sites identity headers cannot read or mutate memory. No public R2 bucket or public unauthenticated AI Search endpoint.
4. Luna answers with validated citations; Sol handles extraction and explicit complex synthesis; no unexpected non-OpenAI model calls. Model-quality checks cover duplicate facts, explicit corrections, contradictions and no reusable knowledge.
5. Standard MCP Inspector and authenticated fresh-chat tests in both ChatGPT and Codex pass, including save, resume, read, query and explicit logs. Refresh/install one replacement private plugin connection; do not create a duplicate local MCP configuration. Update the active personal/plugin instructions to the new endpoint and preserve unrelated style instructions.

After acceptance and the final source freeze/delta verification, make the Cloudflare endpoint the sole writer, disable the old plugin connection for routine use, and complete one synthetic save/query through each client. Preserve the existing task-key namespace and historical source aliases. Push the tested implementation and configuration to GitHub with Conventional Commits; keep the existing service read-only as rollback material. Do not delete OpenAI files/vector stores or the Sites project during cutover.

## 5. Rollback and completion

Before the new target accepts real writes, rollback is a connection switch to the frozen source. After real Cloudflare writes begin, first freeze destination writes and reconcile/export the new destination-only operations back into the source using the preserved identifiers, then verify hashes/lineage before reopening source writes. Never blindly switch clients back and lose work created after cutover.

The migration is complete only after the active connection, personal instructions, data verification, source write protection and GitHub synchronization agree. Report remaining pending/conflicted records accurately. Deletion of retained source resources is a separate later decision.

## References and current limits

- R2 source and metadata: https://developers.cloudflare.com/ai-search/configuration/data-source/r2/
- Managed retrieval: https://developers.cloudflare.com/ai-search/concepts/how-ai-search-works/
- OpenAI embedding support: https://developers.cloudflare.com/ai-search/configuration/models/supported-models/
- MCP OAuth/KV: https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
- Private ChatGPT/Codex connection and testing: https://developers.openai.com/plugins/deploy/connect-chatgpt
- Conditional R2 operations: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/

Account entitlement, full connection write permissions, login-provider setup, indexing latency, cost and migration performance remain unvalidated. No Cloudflare resources were created while preparing this plan. The active implementation/ADR remains OpenAI-backed until implementation explicitly supersedes it.
