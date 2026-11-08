# Start fresh and use instructions instead of local memory scripts

[ADR 0003](0003-capture-first-and-daily-wiki-maintenance.md) adds an explicitly scheduled daily wiki-maintenance caller and replaces the earlier contradiction-precedence policy. Ordinary completed-task capture stays in the originating chat; the daily caller is not a per-task completion worker.

Begin with empty hosted collections. Do not import or continuously synchronize the old vault. Clients retrieve when missing or potentially stale prior context matters and submit one curated summary per genuinely completed task through MCP. The conditional call policy below supersedes the original unconditional retrieval rule. No Python hooks, completion writers, qmd installation, or local embedding models are needed by the new service.

At cutover, replace only the old memory instructions and reminder registrations. Retain the old vault and scripts as an archive and preserve unrelated personal instructions/hooks. Automatic capture depends on instruction following; the server does not observe a client lifecycle or run after returning pending.


## Conditional calls instead of a per-prompt gate (2026-11-07)

Reuse resolved project keys and relevant memory in the current chat. Discover
projects only when their key is unknown or invalid; query only when prior
context could affect the work and is missing or may be stale. Simple follow-ups
and self-contained tasks skip retrieval. Retrieval failure does not block
independent work, but missing context must be disclosed when material.

Keep one completion submission per finished task, including tasks with no new
knowledge. After pending, attempt one resume and then report the operation ID
for later recovery instead of repeatedly polling. Deferred work does not run
in the background and cannot be called saved before verification. This reduces
call frequency without relaxing authorization, project boundaries, immutable
history, conflict handling, or verification. Reused context can become stale;
refresh when a project/topic changes, recall is requested, or newer memory
could materially change the answer. No server caching or storage changes.
