# Agent Memory MCP

Private, stateless memory tools for ChatGPT and Codex. All durable application data lives in **OpenAI Files and Vector Stores** in the existing **Personal / Agent Memory** OpenAI project. Sol extracts/reconciles writes; Luna answers routine questions. Sites runs the dependency-free JavaScript Worker on Cloudflare. There is no D1, R2, local database, Python runtime, or background job.

## Run and check

Requires Node 24+. No packages need installing.

```sh
npm test
npm run build
npm run smoke
npm run evaluate
```

The smoke check uses the ignored `.env.local`, creates a disposable namespace with synthetic knowledge, verifies write/retry/read/query, and deletes only that namespace's resources. It calls OpenAI and incurs API usage. Unit tests use an in-memory fake exclusively.

The evaluation command checks Sol on no-op, duplicate, contradictory, and explicitly corrected knowledge, plus Luna on a cited answer. It calls the real models with synthetic inputs but replaces storage with in-memory evaluation fixtures; it creates no durable memory records. Passing this small sample is a baseline, not a guarantee of model accuracy.

For local development, configure `MEMORY_LOCAL_TOKEN` in your ignored env file and run `npm run dev`. The server binds only to `127.0.0.1:8787`; send its token as a Bearer credential. Production relies on authenticated caller identity supplied by the owner-private Sites gateway. Never expose the Worker independently while trusting arbitrary identity headers.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `OPENAI_API_KEY` | Required; project-scoped key, server-side only |
| `OPENAI_PROJECT_ID` | Existing Agent Memory project ID; set explicitly in production |
| `MEMORY_NAMESPACE` | `personal`; isolates this app's collections and files |
| `MEMORY_WRITE_MODEL` | `gpt-6.1-sol` |
| `MEMORY_QUERY_MODEL` | `gpt-6-luna` |
| `MEMORY_WRITE_REASONING` | `medium` |
| `MEMORY_QUERY_REASONING` | `low` |
| `MEMORY_OWNER_ID` | Optional additional Site-scoped owner restriction |
| `MEMORY_LOCAL_TOKEN` | Local development only; do not configure in production |

Production secrets belong in Sites environment settings, not source or the hosting manifest. `.env.local` is ignored. Changes to model settings require a compatibility/quality check but no memory migration. Exact reads do not invoke a model; embedding/ranking models are managed by OpenAI.

## Tools

| Tool | Input and behavior |
| --- | --- |
| `memory_projects` | `action: list/create`, optional `project_key`; create a named collection explicitly |
| `memory_query` | `project_key`, `query`; optional `record_type: knowledge/log`, `mode: routine/complex`, `include_global`, `all_projects` |
| `memory_read` | `project_key`, `file_id`; verified exact Markdown plus revision status |
| `memory_complete` | `project_key`, `task_key`, `summary`, `sources`, `validation`, `duration`, `caveats`; optional candidate `knowledge` and explicit `corrections` |
| `memory_status` | `project_key`, `operation_id`, optional `resume: true` |

Create `global` and each application's project before use. These are application projects, not separate OpenAI API projects. Requests use stateless JSON-RPC `POST /mcp`, including Sites `server/discover`, `tools/list`, and `tools/call`. Standard initialization, ping, and notifications are also handled. Mutation tools are honestly annotated as not strictly idempotent.

### Example completion

```json
{
  "project_key": "agent-memory-mcp",
  "task_key": "chat-123:model-selection",
  "summary": "Selected configurable write and query models.",
  "knowledge": ["Use Sol medium for writes and Luna low for routine queries."],
  "sources": ["User-approved decision in chat-123"],
  "validation": "Architecture reviewed; runtime evaluation pending.",
  "duration": "~5m",
  "caveats": ["Not yet deployed."]
}
```

The result contains an `operation_id`, `status` (`saved`, `pending`, or `conflict`), revision identifiers, and a log file ID when committed. `memory_status` also returns `not_found`; failed tools return `isError: true` with a safe error code. Conflicted knowledge is retained with the log, but it is not presented as an established fact. A completion without reusable knowledge still writes a log.

## Storage and consistency

One named Vector Store per project (`memory-global`, `memory-xircle`, etc.). Files API itself is flat. Uploaded filenames include the app namespace, project, record type, and stable operation/revision IDs. Knowledge files contain JSON-valued Markdown frontmatter with sources and predecessor references; logs record work, validation, duration, caveats, and resulting revisions. Operation plans contain JSON inside Markdown files indexed as `record_type=operation`, excluded from ordinary knowledge/log searches.

Live checks established that this account rejects raw content downloads for `user_data` and `assistants` uploads. The service therefore reads through Vector Store's parsed-content endpoint. Each uploaded Markdown file includes a base64 source envelope and SHA-256 checksum, allowing exact original text to be reconstructed even if parsing normalizes surrounding whitespace. Missing, corrupted, or incomplete source envelopes fail explicitly. This adds indexing/storage overhead; it avoids introducing another storage provider or pretending parsed text is byte-exact source. Multi-page content returns `content_incomplete` rather than guessing an undocumented pagination parameter.

Writes persist the plan first, upload/index immutable revisions, then upload/index the completion log. Reads validate log/plan/document agreement before accepting a completed operation. Current knowledge is derived from predecessor relationships, not a mutable `current=true` flag or search ranking. Explicit corrections must replace every known current revision. Unknown contradictions preserve competing branches; no timestamp winner is chosen. Search hits select topics; verified current revisions supply the answer. Citation IDs are checked against supplied evidence (this does not itself prove every generated sentence).

No cross-file transactions or exactly-once guarantee. Concurrent retries can create duplicates or incompatible plans; matching records are collapsed, incompatible plans/branches are surfaced. Collections and Files listings are fully paginated with a 2,000-item v1 limit. Exceeding it fails explicitly rather than returning a falsely current answer. This intentionally trades scalability/latency for OpenAI-only storage. Revisit the scan strategy as collections grow.

Nothing continues after a pending response. Resume in a later call, including from another server instance. Failed uploads may leave unreferenced Files records; v1 retains them for inspection rather than automatically deleting potentially useful data. The service has no destructive cleanup/delete tool.

## Deployment and client cutover

The `.openai/hosting.json` manifest declares only MCP hosting, with no storage bindings. `npm run build` emits `dist/server/index.js` plus `dist/.openai/hosting.json`. Publish with the Sites source workflow and retain owner-private access. Reuse the generated private plugin in ChatGPT/Codex; do not add a second MCP connection.

See [client-instructions.md](docs/client-instructions.md) for replacing the old local-memory rules without Python scripts. Existing local instructions remain active until the hosted workflow is validated. Keep the old vault as an archive; no historical import or synchronization is performed.

## Proposed Cloudflare migration

The [migration plan and resource naming checklist](docs/migration-cloudflare.md) describe a proposed move to Cloudflare-owned Workers, R2 and AI Search while retaining OpenAI models. Resource names and connection choices are pending; the deployed storage/runtime configuration has not changed.
