# Super World Model

The default world is under `worlds/default`.

- `self.md`: mutable self model. Changes are patch-suggestion-first.
- `world.md`: durable facts and operating assumptions.
- `pulse.md`: scheduled lightweight checks. Empty or non-actionable content
  should short-circuit without an LLM call.
- `short_term_memory/`: recent observations.
- `long_term_memory/`: consolidated durable memory.
- `sources/`: summaries of user-consented sources.
- `dreams/`: 48-hour cycle digests by default.
- `reflections/`: reflective notes.
- `plans/`: action plans.
- `patch_suggestions/`: proposed diffs for `self.md`, `world.md`, or
  `pulse.md`.
- `inbox/`, `outbox/`: auditable channel artifacts.

Dream cycles should be idempotent and logged. By default they write digests and
patch suggestions only.

## Self Modification

Super treats self modification as a reviewed artifact workflow:

1. Read `self.md`, `world.md`, recent memory, and relevant AutoCareer context.
2. Produce a digest or action plan.
3. Write proposed changes as files under `patch_suggestions/`.
4. Do not apply changes unless an external operator explicitly enables and
   reviews an apply step.

The default runtime mode is `propose_only`.
