# Agent Memory

Personal knowledge and task history shared across connected agents.

## Language

**Capture**: An immutable collection of reusable assertions extracted from one curated task completion, with their sources and original recorded time.

**Assertion**: A statement about a scoped fact. A current assertion describes an established present state; historical assertions, plans, and uncertain claims have different meanings.

**Scoped fact**: One property of a particular subject within a project and context, such as the backend runtime rather than its package manager.

**Recorded time**: The time an assertion was first accepted into memory. It does not change when the assertion is retried, compiled, or migrated.

**Wiki page**: A maintained synthesis of related knowledge, with references to the captures or legacy knowledge from which it was compiled.
_Avoid_: Raw transcript, task log

**Revision**: An immutable version of a memory document. Older revisions remain part of its history.

**Task log**: A record of completed work, validation, duration, caveats, and resulting knowledge.

**Project**: An application work context, such as XIRCLE. This differs from the OpenAI API project that owns all service resources.

**Ambiguity**: An unresolved question about a statement's identity, meaning, or precedence. A newer current assertion replacing an older one is ordinary change, not by itself an ambiguity.

**Maintenance**: Compilation of captured knowledge into wiki pages and migration of hosted legacy knowledge, preserving original provenance and recorded times.

**Audit**: A read-only inspection of memory integrity and coverage that returns findings and explicitly identifies incomplete inspection.

**Source coverage**: The exact source records represented by a compiled wiki page.

**Maintenance job**: The compilation of one project's frozen source scope, completed through one or more bounded batches under the same task key.

**Operation**: A persisted unit of save or maintenance work, recoverable across retries.

## Client workflow cutover

As of 2026-11-08, Codex records completed-work time logs in Notion Personal and reads project source/docs directly. No automatic knowledge capture, project/global memory retrieval, or wiki maintenance is part of that client workflow. The glossary above describes the preserved memory service. See ADR 0004.

**Time log**: A Notion row for one logged work segment, with its work date, Project label, duration provenance, references, and retry Entry ID. This is distinct from the memory service's existing Task log.

**Log Project**: A reporting label reused across related Repository URLs. It is not a memory collection or an OpenAI API project.
