# Super

Super is the sandboxed living-agent daemon layer for the Synax / AutoCareer
ecosystem.

Super is not Synax. Synax is the portable coding-agent runtime. Super is the
specialized daemon that owns world documents, self model, pulse and dream
cycles, channel adapters, and career/life operating behavior.

## What Super Owns

- `self.md`, `world.md`, `pulse.md`, and auditable world artifacts.
- Message-triggered runs through the Synax SDK.
- Pulse checks that skip LLM work when nothing is actionable.
- Dream cycles that consolidate memory and write patch suggestions.
- Channel adapter contracts for Discord, GitHub, email, API, and future sources.
- AutoCareer adapter contracts for profile, evidence, job, and career tools.

## What Super Does Not Own

- Generic coding-agent internals.
- Synax core orchestration, handoff, tools, or memory primitives.
- Relay job queue or local model process lifecycle.
- AutoCareer product UI, onboarding, dashboards, or domain database ownership.

## Layout

```txt
packages/
  super-core/
  super-daemon/
  super-channels/
  super-memory/
  super-autocareer-adapter/
apps/
  superd/
worlds/default/
docs/
```

## Commands

```sh
npm test
npm run typecheck
npm run superd
```

`superd` is the only runnable daemon entrypoint.

## Synax SDK

Super uses `SuperSynaxSdkAdapter` to call the Synax SDK. Configure model access
with:

```sh
SUPER_LLM_BASE_URL=http://127.0.0.1:1234/v1
SUPER_LLM_MODEL=qwen
npm run superd
```

Self/world modifications are patch-suggestion-first. Super does not auto-apply
changes to `self.md` or `world.md` unless an explicit external apply path is
enabled and reviewed.
