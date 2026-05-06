# Synax TUI RunState + PhaseTransition Spec (v0.1)

This spec defines the one-page runtime contract for the next-generation Synax TUI run control surface.

## Scope

- Primary unit: `Run`
- Secondary unit: `Objective`
- Tertiary unit: `phase transition + verification outcome`

Any UI element that does not answer "Is this run progressing safely?" is out of scope.

## RunState Fields

```ts
type Severity = 'S0' | 'S1' | 'S2' | 'S3';

type RunPhase =
  | 'idle'
  | 'thinking'
  | 'tool_execution'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'error';

interface RunState {
  runId: string;
  startedAtMs: number;
  nowMs: number;
  mode: string;
  providerLabel: string; // model + endpoint/provider

  objective: {
    label: string; // "Working on..."
    currentPhase: RunPhase;
    nextCheckpoint: string;
  };

  phase: RunPhase;
  phaseTransitions: Array<{ atMs: number; from: RunPhase; to: RunPhase; note: string }>;

  timeline: Array<{ atMs: number; phase: RunPhase; summary: string; severity: Severity }>;

  changes: {
    items: Array<{ path: string; op: 'create' | 'edit' | 'delete' | 'read' | 'test' | 'other' }>;
    overflowCount: number;
  };

  verification: {
    state: 'planned' | 'running' | 'passed' | 'failed' | 'skipped';
    checksPlanned: number;
    checksRunning: number;
    checksPassed: number;
    checksFailed: number;
    checksSkipped: number;
    summary: string;
  };

  riskLine: string; // surfaced S2+ health summary
  statusNote: string; // surfaced S1 subtle note
  terminalIssue?: string; // S3 detail

  severity: Severity; // highest active severity
  terminal: 'running' | 'completed' | 'failed' | 'blocked';
}
```

## Objective State

- `objective.label`: task string from `task_started.task`.
- `objective.currentPhase`: mirrors `phase`.
- `objective.nextCheckpoint`: deterministic hint:
  - idle/thinking -> `awaiting model output`
  - tool_execution -> `awaiting tool result`
  - verifying -> `awaiting verification result`
  - completed -> `run finalized`
  - blocked/error -> `operator decision required`

## Phase Enum + Transition Rules

- Initial: `idle`.
- `task_started` -> `thinking`.
- `model_step_started` -> `thinking`.
- `tool_started` -> `tool_execution`.
- `tool_finished`:
  - if tool failed -> `error` (or keep `tool_execution` for recoverable S0/S1 turbulence)
  - else -> `thinking`.
- `task_finished`:
  - if verification starts -> `verifying` then terminal phase
  - completed -> `completed`
  - blocked/budget/model/tool/user state -> `blocked` or `error`
- fatal `error` event -> `error`.

Transitions are appended with `(from,to,note)` and compressed for display.

## Verification State

- Before any edits: `planned`.
- During check execution: `running`.
- End states: `passed` / `failed` / `skipped`.
- Verification health is always visible as compact counters and summary string.

## Change Summary Model

- Normalize file operations into op classes: `create/edit/delete/read/test/other`.
- Keep insertion order for recent changes.
- De-duplicate by `(path, op)` in visible window.
- Overflow collapses deterministically into `+N prior changes`.

## Severity Ladder

- `S0`: silent internal turbulence, auto-recovered.
- `S1`: subtle status note.
- `S2`: surfaced in verification/risk line.
- `S3`: interrupting issue requiring operator decision.

Highest active severity controls risk presentation and AI core error posture.

## Compression Rules

- Timeline shows high-signal transitions only; max window (6-10 lines in UI).
- Tool spam, retries, parser turbulence, and raw model output are hidden unless escalated (`S2+`).
- Long paths are clipped with right-edge preservation.
- Repeated events coalesce into count summaries.

## Render Invariants

- Single stable frame with fixed regions.
- No layout shift from content growth.
- No full repaint except terminal resize or hard desync recovery.
- Virtual screen buffer (`Cell[][]`) diffed against previous frame.
- Minimal cursor movement + changed-span writes only.
- AI core rendered as fixed overlay after main pass, never participates in layout.
