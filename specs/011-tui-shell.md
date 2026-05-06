# Synax Next-Generation Interactive TUI Spec

## 0. Pushback / Alignment Corrections

The current implementation is a useful foundation, but it is **not the aligned product**.

What exists now is:

```text
synax run --task "..." --tui
```

That is a **single-shot passive renderer**. It consumes agent events and paints a terminal status surface. It does not own input, does not run as the default Synax surface, and does not provide a stateful interactive coding-agent experience. The pasted repo summary confirms the current TUI is only activated through `synax run --task ... --tui`, receives an `AgentEvent` stream, and converts it into a live state snapshot via `tui-state.ts`. 

The intended product is:

```text
synax
```

opens a **full-screen interactive local intelligence runtime**.

Not chat. Not logs. Not a dashboard.

A controlled terminal cockpit for running a contained local agent.

The correct mental model:

```text
Current implementation:
  Renderer for a run

Needed implementation:
  Interactive TUI application shell
```

So the next pass must not simply polish `TuiRenderer`. It must build the missing **interactive shell** around it.

---

# 1. Refined TUI Design Spec

## Product Thesis

Synax should feel like a **contained local intelligence runtime**: a calm reactor-like system that accepts objectives, executes them, reports meaningful state, and verifies its work without making the user babysit raw turbulence.

The user is not “chatting with an assistant.”

The user is a **pilot overseeing a contained intelligence system**.

## Default Behavior

Required:

```bash
synax
```

opens the interactive TUI.

Also required:

```bash
synax chat
```

opens the same interactive TUI.

Plain fallback should remain:

```bash
synax --plain
synax chat --plain
```

or equivalent.

Existing passive mode may remain:

```bash
synax run --task "..." --tui
```

but it is secondary.

## Primary Interaction Model

The TUI is **objective-driven**, not chat-centric.

The main user input should feel like:

```text
Objective: Refactor the context budget assembly path and verify tests
```

not:

```text
You: can you please refactor...
Assistant: sure...
```

The interface may support conversational follow-up, but visually it should not become a chat transcript.

## Visible State

Show:

```text
Working on
Current phase
Next checkpoint
Recent high-level progress
Files touched
Verification state
Risk / blocked status
Input objective buffer
Persistent AI core
```

Do not show by default:

```text
raw tool call spam
model parser failures
internal retries
full stdout logs
chain-of-thought
assistant chat bubbles
typing indicators
```

Important distinction:

Synax should **hide turbulence, not truth**.

So failures should be surfaced when they matter:

```text
Blocked: provider.model missing
Verification failed: 2 tests failed
Tool error: edit rejected because file changed
Context budget exceeded
```

But it should not anxiously narrate every internal wobble.

## Visual Language

Sparse. Industrial. Precise.

Use:

```text
Unicode box drawing
subtle ANSI color
monospaced geometry
stable panels
low-density text
meaningful whitespace
```

Avoid:

```text
chat bubbles
emoji mascots
rainbow gradients
cyberpunk overload
scrollback spam
giant dashboards
split-pane log walls
```

The UI should feel like a quiet machine that knows what it is doing.

---

# 2. Rendering Architecture Plan

## Core Rule

The TUI must own a **stable live region** and update it with disciplined diff rendering.

Pi’s `pi-tui` approach is the right reference class: it uses differential rendering strategies, including first render, full render on width/viewport-disrupting changes, and normal updates that move to the first changed line and redraw only changed lines. It also wraps updates in synchronized terminal output for atomic flicker-free rendering. ([GitHub][1])

Synax should copy the discipline, not necessarily the exact implementation.

## Rendering Pipeline

Recommended architecture:

```text
Agent/runtime events
        ↓
TUI event reducer
        ↓
Stable RunStateSnapshot / InteractiveStateSnapshot
        ↓
Layout engine produces string[] lines
        ↓
Viewport clipping
        ↓
Diff engine compares previous visible lines
        ↓
Terminal writer applies minimal ANSI update
```

## Required Modules

```text
src/tui/terminal.ts
  Terminal abstraction:
  - start()
  - stop()
  - write()
  - columns
  - rows
  - hideCursor()
  - showCursor()
  - clearScreen()
  - clearLine()
  - moveTo()
  - moveBy()
  - synchronizedWrite()

src/tui/diff-renderer.ts
  Owns previous visible lines.
  Computes first changed line.
  Redraws only changed visible region.
  Falls back to full render on width/height/layout invalidation.

src/tui/layout.ts
  Pure function:
  InteractiveTuiState + terminal size → string[] visible frame

src/tui/input.ts
  Raw input parser:
  - printable chars
  - backspace
  - arrows if supported
  - Enter
  - Ctrl+C
  - bracketed paste
  - slash commands

src/tui/ai-core.ts
  Deterministic low-FPS core animation model.

src/commands/chat.ts
  Chooses TUI vs plain.
  Does not own giant rendering logic.

src/agent/chat-session.ts
  Shared conversation/session lifecycle.
  Used by both plain and TUI modes.
```

## Non-Negotiable Rendering Rules

1. **Never repaint the whole screen every frame** unless terminal dimensions or layout topology changed.
2. **Never write streaming logs directly to stdout** while TUI owns the terminal.
3. **Never let animated elements change surrounding layout.**
4. **Always clip rendering to the visible terminal height.**
5. **Keep render cost bounded by viewport height, not session length.**

That last point matters. Pi has had issues where render operations appeared to become session-length dependent, causing input lag over long sessions. The relevant issue suggests clipping diffing and previous-line storage to the visible viewport to keep render time constant. ([GitHub][2])

## Synchronized Output

Use synchronized terminal output where supported:

```text
\x1b[?2026h
...batched ANSI writes...
\x1b[?2026l
```

Fallback gracefully if unsupported.

## Live Region Discipline

The renderer must not let old frames leak into scrollback.

Pi has had a known class of issues where a live region can grow beyond the terminal height and push stale spinner/status rows into scrollback. The lesson for Synax: the live region should be fixed-height, viewport-clipped, and carefully cleared on stop. ([GitHub][3])

Required behavior on exit:

```text
restore cursor
restore raw mode
clear transient live region or leave one clean final summary
never leave half-rendered core/status artifacts
```

---

# 3. AI Core Animation System Design

## Purpose

The AI core is not decoration.

It is the ambient physiological signal of the runtime.

It should answer, at a glance:

```text
Is Synax alive?
Is it thinking?
Is it acting?
Is it verifying?
Is it blocked?
```

## Placement

Fixed corner.

Recommended:

```text
top-right
```

Why: it reads like a system indicator, not a footer spinner. It can remain visible while objective/progress/checks occupy the main body.

Hard rule:

```text
The AI core must never affect layout.
```

The layout engine reserves or overlays a fixed-width region. No surrounding text shifts because the core animates.

## Size

Small.

Example footprint:

```text
╭──────╮
│ ◌⟲◌ │
│  ◉  │
╰──────╯
```

or even tighter:

```text
╭────╮
│ ◌◉ │
╰────╯
```

Do not make it a giant centerpiece.

## Frame Rate

Target:

```text
4–8 fps
```

Default:

```text
6 fps
```

Animation must be low-frequency and physically consistent.

## State Inputs

The core state should be derived from real runtime state:

```ts
type CoreMode =
  | "idle"
  | "thinking"
  | "tool_execution"
  | "verifying"
  | "blocked"
  | "error";
```

Inputs:

```text
current agent phase
active tool count
verification status
blocked/error state
elapsed time in phase
recent activity timestamp
```

## Motion Language

### idle

Almost still.

```text
tiny slow breathing
single faint point
no orbit unless necessary
```

Feeling: contained power at rest.

### thinking

Subtle orbital / phase motion.

```text
one satellite moves around core
slow cadence
no spinner glyphs
```

Feeling: cognition, not loading.

### tool_execution

Mechanical pulse.

```text
brief compression/expansion
radial tick or actuator-like beat
cadence tied to tool start/finish events
```

Feeling: machine action.

### verifying

Precise symmetry.

```text
stable cross/diamond alignment
minimal motion
regular phase lock
```

Feeling: measurement, calibration.

### blocked/error

Subtle destabilization.

```text
off-center pulse
slight asymmetry
slow warning cadence
```

No flashing. No panic.

## Implementation Model

Use a deterministic frame function:

```ts
function renderAiCore(mode: CoreMode, t: number, size: CoreSize): string[]
```

Do not use arbitrary timers scattered through the app.

The main TUI loop owns a render ticker:

```text
render on:
- state changes
- input changes
- resize
- animation tick while core is active
```

When idle, reduce or suspend animation ticks.

## Core Frame Example

Not final art, but acceptable direction:

```text
idle:
╭─────╮
│  ·  │
│  ◉  │
│     │
╰─────╯

thinking:
╭─────╮
│ ·   │
│  ◉  │
│   · │
╰─────╯

tool_execution:
╭─────╮
│  │  │
│ ─◉─ │
│  │  │
╰─────╯

verifying:
╭─────╮
│  ◇  │
│ ◇◉◇ │
│  ◇  │
╰─────╯

blocked:
╭─────╮
│  ·  │
│ ◉   │
│   · │
╰─────╯
```

Keep color subtle:

```text
idle: dim
thinking: normal cyan/blue-gray
tool: muted amber/steel
verifying: muted green/white
blocked/error: muted red/amber
```

No neon rainbow.

---

# 4. Minimal Viable Implementation Plan

## MVP Goal

Running:

```bash
npm run synax
```

opens an interactive full-screen TUI where the user can:

```text
type an objective
submit it
watch Synax work
see phase/progress/files/checks
continue with follow-up objectives
use slash commands
exit cleanly
```

## Phase 1 — Separate Session Logic From Plain Chat

Current `chat.ts` likely mixes:

```text
terminal IO
input handling
slash commands
conversation state
model calls
rendering/logging
```

Refactor only enough to extract shared session lifecycle.

Create:

```text
src/agent/chat-session.ts
```

Responsibilities:

```text
hold conversation
submit user objective/message
emit AgentEvents
route slash commands
manage verification commands
manage provider/model errors
```

Plain chat and TUI both call into this.

Do not rewrite the whole agent runtime.

## Phase 2 — Add Interactive TUI Shell

Create:

```text
src/tui/interactive-tui.ts
```

Responsibilities:

```text
enter raw mode
own stdin/stdout
hide cursor
maintain input buffer
handle bracketed paste
handle Enter/backspace/Ctrl+C
route slash commands
submit objectives to ChatSession
subscribe to AgentEvents
render state snapshots
restore terminal on exit
```

This is the missing product.

## Phase 3 — Reuse Existing TUI State/Renderer Carefully

Existing files are useful:

```text
src/agent/tui-state.ts
src/agent/tui-renderer.ts
```

But do not let the old passive renderer dictate the interactive design.

Recommended split:

```text
tui-state.ts
  keep/reuse reducer ideas

tui-renderer.ts
  either:
    A) refactor into pure layout + terminal renderer pieces
    B) keep as passive run renderer and build new interactive renderer beside it
```

Safer MVP:

```text
keep run TUI working
build interactive TUI separately
dedupe later
```

## Phase 4 — Default Command Wiring

Required command behavior:

```text
synax
  → interactive TUI

synax chat
  → interactive TUI

synax chat --plain
  → old plain REPL

synax run --task "..." --tui
  → existing passive task TUI
```

If config is missing, the TUI should open and show a calm blocked state:

```text
Blocked
provider.model is required

Next:
  configure .synax.toml or ~/.config/synax/config.toml
```

Do not immediately dump and exit unless the terminal cannot initialize.

## Phase 5 — Input UX

Required:

```text
editable input buffer
Enter submits
Shift+Enter or paste preserves multiline if feasible
bracketed paste masked
paste must not auto-submit
backspace works
Ctrl+C exits cleanly
Ctrl+L redraws
slash commands work
```

The paste issue is critical because this repo already hit regressions there. The TUI must preserve the fixed behavior: multiline paste should be represented safely and should not trigger immediate submission.

## Phase 6 — State Panels

MVP layout:

```text
╭─ Synax ────────────────────────────────────────────────╮
│ Working on                                             │
│   Refactor context budget assembly                     │
│                                                        │
│ Phase                                                  │
│   Thinking → next: inspect runner path                 │
│                                                        │
│ Progress                                               │
│   ✓ Read project config                                │
│   ✓ Inspected runner                                   │
│   ◌ Planning minimal patch                             │
│                                                        │
│ Files touched                                          │
│   src/agent/runner.ts          read                    │
│   src/agent/context-budget.ts  pending                 │
│                                                        │
│ Verification                                           │
│   not run yet                                          │
│                                                        │
│ Objective                                              │
│   > _                                                  │
╰────────────────────────────────────────────────────────╯
                                             ╭─────╮
                                             │ ·◉  │
                                             ╰─────╯
```

No split chat/log pane.

## Phase 7 — Tests

Add focused tests.

Required:

```text
root command selects interactive TUI by default
chat command selects interactive TUI by default
plain fallback still works
run --task --tui still works
TUI input submits exactly one user turn
bracketed multiline paste does not auto-submit
backspace does not leak raw DEL
Ctrl+C restores terminal
slash commands route correctly
renderer does not write raw tool spam
renderer clips to viewport height
AI core state maps from runtime phases
```

---

# 5. Risks and Failure Modes

## Risk 1 — Building Another Passive Renderer

Failure mode:

```text
They make run --tui prettier.
```

That is not enough.

Acceptance criterion must be:

```text
npm run synax opens the interactive TUI.
```

## Risk 2 — Renderer Owns Business Logic

Do not put chat/session/runtime behavior into the renderer.

Bad:

```text
TuiRenderer.submitPrompt()
TuiRenderer.runSlashCommand()
```

Good:

```text
InteractiveTuiShell handles input
ChatSession handles agent lifecycle
Renderer paints snapshots
```

## Risk 3 — Flicker / Scrollback Pollution

Terminal TUIs fail when they write too much, grow live regions unpredictably, or repaint full frames unnecessarily.

Use:

```text
fixed live region
viewport clipping
diff rendering
synchronized output
clean terminal restore
```

Avoid:

```text
console.log while TUI active
streaming stdout directly
full clear on every tick
animations that change frame height
```

## Risk 4 — O(session length) Rendering

The TUI must not get slower after hours of use.

Render only visible lines. Keep previous-frame state bounded to viewport height.

## Risk 5 — Over-Animating the Core

The AI core can easily become a gimmick.

Rules:

```text
small
slow
state-derived
localized
deterministic
never noisy
```

It should feel like instrumentation, not decoration.

## Risk 6 — Chat Gravity

Existing agent UIs collapse into chat because it is easy.

Synax must resist that.

The input area can accept natural language, but the visual model should remain:

```text
objective
phase
progress
changes
verification
```

not:

```text
User message
Assistant message
Tool message
Assistant message
```

## Risk 7 — Hiding Too Much

“Calm” cannot mean “opaque.”

The user must always know:

```text
what Synax is doing
whether it is alive
what changed
whether verification passed
what requires user action
```

But not every internal detail belongs on the main surface.

Use progressive disclosure:

```text
main TUI: calm state summary
/debug or logs: detailed event stream
/jsonl: machine-readable events
```

---

# Implementation Prompt To Give Pi / DeepSeek

```text
You are implementing the next-generation interactive TUI for Synax.

Important correction:
The current `synax run --task "..." --tui` implementation is only a passive single-task renderer. That is not the aligned product. The aligned product is an interactive full-screen TUI that opens when the user runs `synax`.

Your job is to build the missing interactive TUI application shell, not merely polish the passive renderer.

Required behavior:

1. `synax` opens the interactive TUI by default.
2. `synax chat` opens the same interactive TUI by default.
3. Preserve a plain fallback, e.g. `synax --plain` or `synax chat --plain`.
4. Keep `synax run --task "..." --tui` working as a passive task renderer.
5. The interactive TUI must own raw stdin/stdout while active.
6. The user can type an objective, submit it, watch Synax work, continue with follow-up objectives, use slash commands, and exit cleanly.
7. The UI must be objective-driven, not chat-centric.

Core philosophy:

Synax is not:
- a chatbot
- a dashboard
- a log viewer

Synax is:
- a contained local intelligence runtime
- a reactor-like AI core
- calm, powerful, precise, and trustworthy

The user is a pilot overseeing a contained intelligence system.

Do not implement chat bubbles, assistant-style transcripts, typing indicators, verbose logs, raw tool spam, flashy dashboards, neon cyberpunk noise, mascots, or emoji AI.

Visible UI sections:
- current objective / “Working on…”
- current phase
- next checkpoint
- recent high-level progress
- files touched
- verification/check state
- blocked/risk state
- input objective buffer
- persistent AI core

Do not show by default:
- raw tool call spam
- chain-of-thought
- internal retries
- parser failures unless critical
- full stdout logs

Critical AI core requirement:

Implement a persistent corner AI core:
- fixed top-right or bottom-right
- never affects layout
- always present
- small
- driven by real runtime state
- low-FPS, 4–8 fps
- physically consistent
- no flashing, jitter, RGB noise, or spinner behavior

Core states:
- idle: calm, almost still
- thinking: subtle orbital/phase motion
- tool_execution: mechanical pulse behavior
- verifying: precise/stable symmetry
- blocked/error: slight subtle destabilization

Terminal constraints:
- real bash/zsh terminal UI only
- monospaced text
- ANSI colors
- Unicode box drawing
- controlled redraws
- no graphical widgets
- no floating panels
- no layout shifts
- no flicker
- no scroll spam

Rendering architecture:
Study Pi’s TUI rendering discipline via Context7 / pi-mono. Follow the same class of approach:
- buffered rendering
- diff-based updates
- synchronized output if supported
- viewport clipping
- full repaint only on terminal resize or invalidated layout
- render cost bounded by terminal height, not session length

Do not write directly to stdout while the TUI is active. Route all runtime events into state, then render snapshots.

Suggested architecture:

- `src/agent/chat-session.ts`
  Shared conversation/session lifecycle used by both plain and TUI modes.

- `src/tui/interactive-tui.ts`
  Owns raw input, prompt buffer, key handling, paste handling, slash command routing, lifecycle, and event subscription.

- `src/tui/diff-renderer.ts`
  Owns previous visible frame and applies minimal ANSI updates.

- `src/tui/terminal.ts`
  Terminal abstraction for raw mode, cursor movement, synchronized writes, clear/restore behavior.

- `src/tui/layout.ts`
  Pure layout function from TUI state + terminal size to visible frame lines.

- `src/tui/ai-core.ts`
  Deterministic low-FPS AI core renderer.

- Existing `src/agent/tui-state.ts`
  Reuse/refactor if appropriate for reducing AgentEvents into snapshots.

- Existing `src/agent/tui-renderer.ts`
  Keep passive run renderer working. Reuse pieces only if clean. Do not jam interactive app logic into it.

Input requirements:
- editable input buffer
- Enter submits
- bracketed multiline paste is masked and does not auto-submit
- backspace works
- Ctrl+C exits cleanly and restores terminal
- Ctrl+L redraws if feasible
- slash commands still work

Definition of done:
Running `npm run synax` opens a full-screen interactive TUI where I can type a task, watch the agent work, see phase/progress/files/checks, continue the conversation, use slash commands, and exit cleanly.

Tests required:
- root command selects interactive TUI by default
- `synax chat` selects interactive TUI by default
- plain fallback still works
- `run --task --tui` still works
- TUI input submits one user turn
- multiline bracketed paste does not auto-submit
- backspace does not leak raw DEL
- Ctrl+C restores terminal
- slash commands route correctly
- renderer clips to viewport height
- AI core state maps correctly from runtime phase

Non-goals:
- do not rewrite the whole agent runtime
- do not add a giant framework unless strictly justified
- do not regress existing paste/backspace behavior
- do not remove passive `run --task --tui`
- do not implement a chat/log dashboard
```

The hard line: **a TUI renderer is not a TUI product**. The next pass should build the product shell.

[1]: https://github.com/badlogic/pi-mono/blob/main/packages/tui/README.md?utm_source=chatgpt.com "pi-mono/packages/tui/README.md at main"
[2]: https://github.com/badlogic/pi-mono/issues/1996?utm_source=chatgpt.com "TUI exhibits O(N_session) render cost per keypress #1996"
[3]: https://github.com/badlogic/pi-mono/issues/3083?utm_source=chatgpt.com "pi-tui: spinner row leaks into scrollback and is not cleared ..."

