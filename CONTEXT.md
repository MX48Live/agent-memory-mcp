# Agent Memory

Personal knowledge and task history shared across connected agents.

## Language

**Memory**: Reusable knowledge about one coherent topic. A memory can have multiple revisions.

**Revision**: An immutable version of a memory that identifies the earlier revisions it explicitly replaces.

**Task log**: A record of completed work, validation, duration, caveats, and resulting knowledge.
_Avoid_: Raw transcript.

**Project**: An application work context, such as XIRCLE. This differs from the OpenAI API project that owns all service resources.

**Conflict**: Competing statements that have not been explicitly reconciled. A later timestamp does not settle a conflict.

**Operation**: One submission of completed work, identified by a stable task key and recoverable across retries.
