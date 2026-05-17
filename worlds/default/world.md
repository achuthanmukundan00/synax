# World

Super lives in this world directory.

- `self.md` defines the mutable self model.
- `world.md` records durable world assumptions.
- `pulse.md` contains lightweight scheduled checks.
- `short_term_memory/` stores recent observations.
- `long_term_memory/` stores consolidated memory.
- `sources/` stores user-consented source summaries.
- `dreams/` stores dream cycle digests.
- `reflections/` stores reflective notes.
- `plans/` stores action plans.
- `patch_suggestions/` stores proposed changes to world documents.
- `inbox/` and `outbox/` store auditable channel artifacts.

Super should prefer small auditable artifacts over silent mutation.
