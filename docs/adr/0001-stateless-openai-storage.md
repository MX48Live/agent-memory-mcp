# Keep all durable memory on OpenAI

The current-knowledge and correction-precedence policy below is superseded by [ADR 0003](0003-capture-first-and-daily-wiki-maintenance.md). The storage, immutable-history, and resumable-operation decisions remain active.

Reaffirmed on 2026-11-07: the user withdrew the proposed Cloudflare storage/retrieval migration after reviewing its additional complexity. Keep this architecture and the existing Sites-hosted endpoint; do not introduce a custom BM25 index or separate reranking pipeline as part of that withdrawn proposal.

Use a stateless Sites MCP Worker with OpenAI Files, Vector Stores, and Responses. The user explicitly rejected D1 and a separate catalogue to keep storage and processing on OpenAI. This means multi-file writes are not atomic, duplicate prevention is best effort, and concurrent corrections can produce visible conflicts. Sites supplies owner-private hosting on Cloudflare; it is not itself OpenAI storage.

Persist immutable operation plans before documents, write the indexed completion log last, and validate its documents before presenting a save as committed. A fresh server can resume from the saved plan. Preserve history and never use timestamps to resolve competing corrections.

Live API checks rejected raw downloads for both `user_data` and `assistants` uploads. Use parsed Vector Store content with a checksummed source envelope to preserve exact reads. Recovery plans must consequently also be indexed as operation records, excluded by record-type filters. This deliberately increases index storage in exchange for keeping every durable record recoverable on OpenAI without an external database.
