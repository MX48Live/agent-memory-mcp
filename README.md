# Agent Memory MCP

Private, stateless memory tools for ChatGPT and Codex. All durable application data lives in **OpenAI Files and Vector Stores** in the existing **Personal / Agent Memory** OpenAI project. Sol extracts new-input captures and maintains a compiled wiki; Luna answers routine questions from wiki pages plus fresh captures. Sites runs the dependency-free JavaScript Worker on Cloudflare. There is no D1, R2, separate catalogue, local database, Python runtime, or persistent background job.

## Run and check

Requires Node 24+. No packages need installing.

```sh
npm test
npm run build
npm run smoke
npm run evaluate
```

The smoke check uses the ignored `.env.local`, creates a disposable namespace with synthetic knowledge, verifies write/retry/read/query, and deletes only that namespace's resources. It calls OpenAI and incurs API usage. Unit tests use an in-memory fake exclusively.

The evaluation command checks model behavior with synthetic inputs and in-memory storage fixtures; it creates no durable memory records. It calls the real models and incurs API usage. Passing this small sample is a baseline, not a guarantee of model accuracy or exhaustive semantic-conflict detection.

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
| `memory_query` | `project_key`, `query`; maintained wiki plus fresh captures by default; optional `include_history: true` only for explicit history questions; explicit logs, all-project scope, or complex synthesis |
| `memory_read` | `project_key`, `file_id`; verified exact Markdown; `status: saved` confirms availability while `currentness: not_evaluated` makes no freshness claim |
| `memory_complete` | Curated task completion and candidate knowledge; Sol extracts from new input only, without scanning prior memory for duplicates or conflicts |
| `memory_status` | `project_key`, `operation_id`, optional `resume: true` |
| `memory_maintain` | `project_key`, stable `task_key`; compile at most 20 captures per batch with one Sol call; resume interrupted work and migrate hosted legacy knowledge |
| `memory_audit` | `project_key`, optional continuation `cursor`; read-only structural integrity/coverage inspection returning `clean`, `findings`, `incomplete`, or `failed` |

Tools advertise human-readable MCP titles such as **Memory Query** and a shared database icon, while retaining stable callable names such as `memory_query`. Displaying these titles and icons depends on client support; clients may keep their own generic tool indicator. The icon is an inline SVG data URI, requiring no asset request.

Plugin listing artwork is declared separately in `plugin/.codex-plugin/plugin.json` through `interface.logo` and `interface.composerIcon`. The package retains the existing registered app mapping in `plugin/.app.json` and includes the self-contained `daily-memory-maintenance` skill. ZIP the contents of `plugin/` and use the existing plugin's **Upload new version** action; refreshing MCP tools alone does not install skills or listing assets. Source package version 1.1.0 does not itself prove that the account has installed it. The main listing icon remains unverified.

Create `global` and each application's project before use. These are application projects, not separate OpenAI API projects. Requests use stateless JSON-RPC `POST /mcp`, including Sites `server/discover`, `tools/list`, and `tools/call`. Standard initialization, ping, and notifications are also handled. Mutation tools are honestly annotated as not strictly idempotent.

### When clients call tools

Reuse known project keys and relevant memory within a chat. List projects only
when the key is unknown or invalid; query project plus global knowledge only
when missing or potentially stale prior context matters. Simple follow-ups and
self-contained tasks skip retrieval. Continue independent work on retrieval
failure. Submit one completion log per finished task, not per prompt. After
pending on an ordinary completion, attempt one resume, then report the operation ID and defer further
attempts until needed or requested. Explicit maintenance jobs instead repeat their stable job key across advancing bounded batches; indexing/no-progress stalls receive one resume before deferral. Nothing runs in the background. Individual
tool calls still wait for their results; save verification remains strict. Sol requests have a bounded three-minute timeout for extraction and synthesis; routine Luna requests and storage calls retain a 45-second timeout. A timeout does not confirm a saved operation or start background recovery.
See [client-instructions.md](docs/client-instructions.md) for the full policy.

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

Completion and maintenance return an `operation_id` and explicit save/coverage information. `saved` confirms the operation's own persisted records and log agree; it does not mean that every claim is factually correct or that a capture has already been compiled into the wiki. `pending` requires a later resume call. `memory_status` also returns `not_found`; failed tools return `isError: true` with a safe error code. A completion without reusable knowledge still writes a log. Follow actual tool results for recovery and never claim a pending or failed operation is saved.

## Capture, wiki, and daily maintenance

The [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern accumulates maintained topic summaries and connections rather than assembling raw facts again for every question. Here, task completion produces immutable captures quickly; daily maintenance compiles them into persisted wiki pages with exact source coverage. Reads use both wiki pages and fresh captures, so new information is available before the next daily run.

For the same scoped fact, use the newest **recorded current assertion**. A later current statement that the backend uses Bun supersedes an older statement that the same backend uses Node. A plan to try Bun, a historical statement, or a statement about the package manager does not necessarily change the runtime. Preserve older assertions for history. Original recorded times survive retries, hosted legacy migration, and compilation; a freshly generated wiki page cannot make an old claim newer. Report ambiguous identity or ordering instead of choosing by retrieval rank. See [ADR 0003](docs/adr/0003-capture-first-and-daily-wiki-maintenance.md).

Default queries include selected current facts and separately typed planned, historical, or question context when relevant; those contexts never override current state. Use `include_history: true` only when the user explicitly asks about history: this additionally supplies superseded formerly-current assertions, labelled historical. Exact `memory_read` verifies that a file was saved, not that its statements are still current; use `memory_query` to evaluate current state.

An explicitly scheduled external ChatGPT/Dot caller is intended to run at **03:00 Asia/Bangkok**. A maintenance call automatically discovers/resumes the project's oldest unfinished job and returns its actual task key, even when called with a new daily key. Reuse that returned project/job key across bounded batches while coverage advances; do not create a new key per batch. Each new job freezes its source scope on its first call. Attempt one resume for indexing/no-progress stalls, then report/defer instead of polling indefinitely. After maintenance, follow read-only audit cursors; changed inventory requires a restart or an explicitly incomplete report. Healthy completed runs stay quiet; report ambiguity, incomplete coverage, and failure. The packaged skill describes this workflow but does not create or verify the schedule. Structural audit is deterministic; bounded model-assisted semantic review does not guarantee detection of every contradiction.

## Storage and consistency

One named Vector Store per project (`memory-global`, `memory-xircle`, etc.). Files API itself is flat. Uploaded filenames include the app namespace, project, record type, and stable operation/revision IDs. Captures retain scoped assertions and their source information; wiki pages retain compilation provenance; task logs record work, validation, duration, caveats, and resulting documents. Operation plans contain JSON inside Markdown files indexed as `record_type=operation`, excluded from ordinary knowledge/log searches. All records are append-only; no separate persistent catalogue is introduced.

Live checks established that this account rejects raw content downloads for `user_data` and `assistants` uploads. The service therefore reads through Vector Store's parsed-content endpoint. Each uploaded Markdown file includes a base64 source envelope and SHA-256 checksum, allowing exact original text to be reconstructed even if parsing normalizes surrounding whitespace. Missing, corrupted, or incomplete source envelopes fail explicitly. This adds indexing/storage overhead; it avoids introducing another storage provider or pretending parsed text is byte-exact source. Multi-page content returns `content_incomplete` rather than guessing an undocumented pagination parameter.

Writes persist the plan first, upload/index immutable documents, then upload/index the completion log. Validate the current operation's plan/log/documents before claiming a save, without rescanning unrelated historical operations. Search hits select relevant topics; current assertions of those topics are resolved using their original recorded times and scope, not search ranking or wiki generation time. Citation IDs are checked against supplied evidence (this does not itself prove every generated sentence).

Maintenance migrates existing hosted legacy knowledge without deleting or rewriting its original files or logs; its operation plan's `created_at` supplies the original recorded time. Existing interrupted legacy operations remain resumable. This hosted migration does not import or synchronize the archived local vault.

No cross-file transactions or exactly-once guarantee. Concurrent retries can create duplicates or incompatible plans; incompatible operations and ambiguous current assertions are surfaced. Paginated scans and bounded audits must report incomplete coverage when they cannot finish; they must not return a falsely current or clean result. New arrivals during maintenance remain available to queries and need not be included in a project's frozen compilation scope. This deliberately trades some indexing and verification overhead for OpenAI-only storage.

Nothing continues after a pending response. Resume in a later call, including from another server instance. Failed uploads may leave unreferenced Files records; v1 retains them for inspection rather than automatically deleting potentially useful data. The service has no destructive cleanup/delete tool.

## Deployment and client cutover

The `.openai/hosting.json` manifest declares only MCP hosting, with no storage bindings. `npm run build` emits `dist/server/index.js` plus `dist/.openai/hosting.json`. Publish with the Sites source workflow and retain owner-private access. Reuse the generated private plugin in ChatGPT/Codex; do not add a second MCP connection.

See [client-instructions.md](docs/client-instructions.md) for the exact replacement personal memory block and cutover checklist. Codex's local-memory workflow was retired on 2026-11-07. Updating the repo or Codex personal rules does not update ChatGPT Custom Instructions: inspect and verify them separately, then test fresh chats. Keep the old vault archived; no historical import or synchronization is performed. Deployment, plugin installation, and daily schedule activation each require their own observed verification.

## Withdrawn Cloudflare migration

The [Cloudflare migration proposal](docs/migration-cloudflare.md) is withdrawn. On 2026-11-07, the user chose to retain OpenAI Files, Vector Stores and Responses with the existing Sites-hosted MCP, avoiding custom keyword indexing and retrieval infrastructure. The proposal is historical reference only; no migration or deployment is required.
