# Use Notion for client task/time logs

Accepted on 2026-11-08. Supersedes the automatic Codex retrieval, completion capture, and maintenance-caller policy in ADRs 0002 and 0003. Their server storage, immutable history, security, and recovery contracts remain unchanged.

The user found the local LLM Wiki of limited benefit and potentially confusing for shared codebases, and uses task/time logs for reporting. Codex should inspect the current repository checkout and shared docs for implementation facts. Keep one Notion Personal Time Logs database with Project labels and Repository URLs, rather than project knowledge collections. Do not infer that log content is current code state.

Record one meaningful completed work segment per row, using Asia/Bangkok work dates. Preserve measured, estimated, and unknown time separately; do not treat elapsed chat duration as measured work. Stable Entry IDs support retry checks but provide no atomic uniqueness guarantee. Prefer paginated saved views for reports, and disclose incomplete coverage. The schema, destination, view IDs, and full client policy live in docs/client-instructions.md.

The cutover replaces the personal memory block and the current repository's client invocation policy while retaining unrelated instructions. Other project instruction files require scoped authorization. No runtime change, deployment, plugin removal, old-data deletion/import, ChatGPT account change, or external schedule change is implied. Future chats must verify the new personal instructions; old chats may retain stale context.
