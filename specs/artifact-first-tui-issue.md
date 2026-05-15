# [ISSUE] Refactor Synax TUI: Transcript-First → Artifact-First Rendering

> **Type:** Epic / Design RFC  
> **Priority:** P0 (v0.5 target)  
> **Affected Areas:** `src/agent/`, `src/llm/`, rendering layer (TUI)  
> **Status:** Design aligned — implementation target: [`@opentui/core`](https://github.com/anomalyco/opentui) v0.2.x

---

## Executive Summary

Synax’s current TUI renders turns as an undifferentiated transcript: dim rounded boxes of prose, tool invocations, and results all flow together. The best coding-agent interfaces (Amp, Claude Code, Codex CLI, Crush, Cody, GitHub Copilot agent mode) feel effective **not** because they show more text, but because they render the agent’s work as a **small number of stable, semantic artifacts**: a plan, a diff, a command invocation, a result, a checkpoint, a review finding, an approval request.

The North Star: **move from transcript-first to artifact-first rendering.** Replace dim rounded boxes with clean boxed sections, full-width separating rules, a thin left status rail, a persistent right operational rail, and compact card renderers for every semantic event class.

Every visible block must answer one of four questions immediately:

| # | Question | Artifact |
|---|----------|----------|
| 1 | *What is happening?* | Plan card, Thinking state, Command card |
| 2 | *What changed?* | Diff card, Edit summary, Commit card |
| 3 | *What needs my approval?* | Approval card, Risk badge |
| 4 | *What state is the agent in right now?* | Status rail, Footer state machine |

---

## Implementation Technology: OpenTUI

Synax will build the artifact-first TUI on **[OpenTUI](https://github.com/anomalyco/opentui)** (`@opentui/core` v0.2.10+), a native terminal UI framework with a Zig core and TypeScript bindings. OpenTUI is used by `opencode` and `terminaldotshop`, has 11K+ GitHub stars, and provides the right abstraction level for the artifact-first design.

### Why OpenTUI

| Reason | Detail |
|--------|--------|
| **Flexbox layout** | Powered by Yoga (same engine as React Native). No manual character alignment. `flexDirection`, `justifyContent`, `alignItems`, `flexGrow`, `gap`, `padding`, `margin` — all CSS Flexbox props available. |
| **TypeScript-first** | First-class TS bindings. No Python, no Rust. Matches Synax's stack constraint. |
| **Zig core** | Native performance via Zig C ABI. Double-buffered rendering. Not Rust — satisfies AGENTS.md constraint. |
| **Rich text system** | Template-literal API: `bold()`, `italic()`, `underline()`, `strikethrough()`, `dim()`, `fg()`, `bg()`. Full RGBA colors via `RGBA.fromHex()`. Maps 1:1 to the glyph + semantic color system. |
| **Built-in primitives** | `Box` (bordered containers, flex), `Text` (styled text), `Input` (single-line prompt), `ScrollBox` (viewport-culled scrolling), `CodeRenderable` (Tree-sitter syntax highlighting), `MarkdownRenderable` (styled markdown). |
| **Terminal features** | Alternate screen buffer, OSC52 clipboard, desktop notifications, cursor styling, terminal title, dark/light theme detection, debug overlay. |
| **Plugin slots** | `SlotRenderable` + `createCoreSlotRegistry` for host-controlled extensibility. Right rail sections and footer contributions can be plugin-driven. |
| **Performance** | `targetFps`/`maxFps` throttling. Viewport culling in `ScrollBox`. Auto re-layout on SIGWINCH. |
| **Keybindings** | `renderer.keyInput` with modifier combos (`ctrl+name`, `shift`, `alt`), key release events (Kitty protocol), paste events, custom input handler prepend. |
| **Mouse** | `onMouseDown`, `onMouseOver`, `onMouseOut` on any `BoxRenderable`. |

### API Approach: Declarative VNode Constructs

Synax will use OpenTUI's **declarative VNode construct API** (not React/Solid bindings). This keeps Synax dependency-light and matches the "small, inspectable" philosophy. Card renderers are pure functions that return VNode trees:

```typescript
import { Box, Text, t, bold, fg, RGBA } from "@opentui/core"

const GREEN = RGBA.fromHex("#00ff87")
const GRAY  = RGBA.fromHex("#6272a4")

function EditCard(event: EditEvent): ReturnType<typeof Box> {
  return Box(
    {
      borderStyle: "single",
      borderColor: GREEN,
      padding: 1,
      marginBottom: 0,
      width: "100%",
    },
    Text({
      content: t`${fg(GREEN)("✓")} ${bold("Edit")}  ${event.artifact.file}  +${event.artifact.linesAdded} ~${event.artifact.linesModified} -${event.artifact.linesRemoved}`,
    }),
    Text({ content: event.artifact.summary, fg: GRAY }),
    Text({ content: "[View diff] [Open file]", fg: GRAY }),
  )
}
```

State changes (footer transitions, card expand/collapse, right rail updates) are handled by rebuilding and re-adding the affected subtree. The declarative API is cheap enough for this at Synax's update frequency (human-scale interaction, not 60fps animation).

### Component Mapping

| Spec Requirement | OpenTUI Primitive |
|---|---|
| Left rail (2-char colored stripe) | `Box({ width: 2, backgroundColor })` |
| Main column (scrollable card list) | `ScrollBox({ flexGrow: 1, viewportCulling: true })` |
| Right rail (~20 chars, persistent) | `Box({ width: 20, flexDirection: "column", padding: 1 })` |
| Footer (2 rows, absolute bottom) | `Box({ position: "absolute", bottom: 0, width: "100%", height: 2 })` |
| Prompt composer | `InputRenderable({ placeholder, width: "100%" })` |
| Artifact cards | `Box({ borderStyle: "single", title, borderColor, padding: 1 })` |
| Card title (glyph + label) | `Text({ content: t\`...\`` })` with `fg()`, `bold()` |
| Syntax-highlighted diffs | `CodeRenderable({ filetype: "diff", syntaxStyle, treeSitterClient })` |
| Action rows (key hints) | `Text({ content: "[y] once  [n] deny", fg })` |
| Collapsible card sections | Conditional child `Box` with `ScrollBox` for large output |
| Global raw/debug overlay | `renderer.configureDebugOverlay({ enabled: true })` |
| Clipboard (copy output) | `renderer.copyToClipboardOSC52()` |
| Theme detection | `renderer.waitForThemeMode()` → `"dark" \| "light"` |

---

## Motivation: Why This Matters

### Current Pain Points

1. **Flat transcript** — Everything looks the same. Users scan prose to find the diff, then scan more prose to find the result. There is no visual hierarchy.
2. **No persistent status** — Model, branch, modified files, cost, context usage, and approval queue are buried in chat text or invisible entirely. Users lose locality, memory, and trust.
3. **Rounded chat bubbles fight chunking** — They imply conversational equivalence between everything on screen. Great coding-agent UIs create **visual inequality**: diffs and results get stronger containers than chatter; metadata is smaller and muted; status moves to rails.
4. **No artifact vocabulary** — The renderer has no concept of "this is a plan," "this is a diff," "this needs approval." Everything is just text in a bubble.
5. **No debug/raw toggle** — Power users can't expand raw tool details, session logs, or structured event streams on demand.

### What the Best Interfaces Prove

| System | Key Lesson for Synax |
|--------|----------------------|
| **Amp** | Typed event stream (`assistant`, `tool_use`, `tool_result`, `result`, `subagent`) — render artifacts, not turns |
| **Claude Code** | Persistent bottom status line (branch, cost, context usage) + permission UI separate from transcript |
| **Codex CLI** | Inline plan/approval flow, syntax-highlighted diffs, themeable cards, reviewer mode |
| **Crush** | Full-width sectional boxes instead of dim chat bubbles; strong diff-forward layout; high-contrast branding |
| **Sourcegraph Cody** | Context chips make hidden context visible; full-width separators; containerized segmentation |
| **GitHub Copilot agent mode** | Agents panel, session cards with statuses, explicit approve/reject on commands |
| **Replit Agent** | Plans before edits, checkpoints as first-class UI artifacts, rollback preview |
| **Aider** | Auto-commit hooks, `/diff`, `/undo`, explicit Git as the safety layer |
| **OpenCode** | Build/Plan mode split, `/details` raw mode toggle, snapshot system |
| **Gemini CLI** | Always-visible approval-state badge, sandbox badge, debug toggle |

---

## Proposed Layout: The Synax TUI Skeleton

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  │                                                                       │   │
│  │  ── MAIN COLUMN (artifact cards in chronological order) ──            │ R │
│  │                                                                       │ I │
│ L│  ┌── ✓ Edit ──────────────────────────────────────────────────────┐   │ G │
│ E│  │ src/server/auth.ts   +12 ~4 -2                                  │   │ H │
│ F│  │ Added request guards and tightened token parsing.               │   │ T │
│ T│  │ [View diff] [Open file]                                         │   │   │
│  │  └─────────────────────────────────────────────────────────────────┘   │ R │
│ R│                                                                       │ A │
│ A│  ┌── ≠ Diff ───────────────────────────────────────────────────────┐   │ I │
│ I│  │ src/server/auth.ts                                               │   │ L │
│ L│  │ @@ parseToken                                                    │   │   │
│  │  │ - accepted nullish bearer values                                │   │   │
│  │  │ + reject empty or malformed bearer headers                       │   │   │
│  │  │ [Expand hunk] [Accept] [Discard]                                 │   │   │
│  │  └─────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                       │   │
│  │  ┌── ⌘ Command ────────────────────────────────────────────────────┐   │   │
│  │  │ npm test -- auth                                                 │   │   │
│  │  │ Running in project root…                                         │   │   │
│  │  │ stdout: 12 passed, 1 failed                                      │   │   │
│  │  │ [Show output] [Retry]                                            │   │   │
│  │  └─────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                       │   │
│  │  ┌── ✓ Result ─────────────────────────────────────────────────────┐   │   │
│  │  │ Tests fixed                                                     │   │   │
│  │  │ Auth suite passes after header parsing change.                  │   │   │
│  │  │ Duration 38s   Files 2   Commands 3                             │   │   │
│  │  └─────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                       │   │
│  │  ┌── ! Approval ───────────────────────────────────────────────────┐   │   │
│  │  │ Run command: pnpm db:migrate                                     │   │   │
│  │  │ Risk: writes database schema                                     │   │   │
│  │  │ [y] once   [a] always in repo   [n] deny                         │   │   │
│  │  └─────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                       │   │
│  ├─────────────────────────────────────────────────────────────────────────┤   │
│  │ STATUS: Thinking…  │ model: qwen-coder  │ branch: feat/artifact-tui    │   │
│  ├─────────────────────────────────────────────────────────────────────────┤   │
│  │ > _                                                                  │   │   │
│  │ Ctrl+Enter submit  Esc cancel  Tab cycle  F1 help                    │   │   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Layout Zones

| Zone | Content | Behavior |
|------|---------|----------|
| **Left rail** (2 chars) | Single solid-color stripe per card, encoding artifact class | Static; drawn once per card; never repaints except on card add |
| **Main column** | Chronological artifact cards with compact metadata, summary, action buttons | Scrollable; virtualized when >N cards; per-card expand/collapse |
| **Right rail** (~20 chars) | Persistent status: active model, branch, files touched, current task, approval queue, LSP/MCP state, session history | Always visible; updated on state change only (cheap repaint) |
| **Footer** (2 rows) | One-line status message + prompt composer + key hints | Always visible; updates on every state transition |

---

## Semantic Event Model (P0 — Foundation)

Renderers must consume **typed semantic events**, not raw transcript text. Define a canonical set of event types before any card renderer work begins.

### Event Type Vocabulary

```typescript
type SemanticEventClass =
  | 'plan'           // Proposed plan of action
  | 'edit'           // File modification summary
  | 'diff'           // Inline diff hunk for review
  | 'command'        // Shell command invocation
  | 'tool_result'    // Result of a tool call (stdout/stderr/exit code)
  | 'review'         // Code review finding
  | 'commit'         // Git commit created
  | 'checkpoint'     // Snapshot/checkpoint marker
  | 'approval'       // Permission request requiring user input
  | 'status'         // Agent state transition
  | 'error'          // Error condition
  | 'note'           // Informational message (not an action)
  | 'assistant_text' // Fallback: plain assistant prose (not a structured artifact)

type SemanticEvent = {
  id: string;
  class: SemanticEventClass;
  timestamp: number;
  parentId?: string;           // For subagent/child events
  artifact: ArtifactPayload;    // Class-specific structured payload
  metadata: {
    model?: string;
    cost?: number;
    duration?: number;
    filesTouched?: string[];
    toolName?: string;
    riskLevel?: 'low' | 'medium' | 'high';
  };
};
```

### Precedents

| System | What to borrow |
|--------|---------------|
| **Amp** | Typed `assistant`, `user`, `result`, `tool_use`, `tool_result`, `subagent` messages in stream JSON |
| **GitHub Copilot cloud agent** | Session/log separation from raw conversation |
| **OpenCode** | Build/Plan mode split as semantic distinction |
| **Codex CLI** | Review as a first-class event, not buried in prose |

### Artifact Payload Shapes

```typescript
type PlanPayload = {
  title: string;
  steps: string[];
  estimatedFiles?: number;
  estimatedCommands?: number;
};

type EditPayload = {
  file: string;
  linesAdded: number;
  linesModified: number;
  linesRemoved: number;
  summary: string;
  diffId?: string;        // Link to associated Diff card
};

type DiffPayload = {
  file: string;
  hunks: DiffHunk[];
  accepted?: boolean;
};

type CommandPayload = {
  command: string;
  cwd: string;
  riskLevel: 'low' | 'medium' | 'high';
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

type ApprovalPayload = {
  action: string;
  details: string;
  riskLevel: 'low' | 'medium' | 'high';
  choices: ApprovalChoice[];
};

type CommitPayload = {
  message: string;
  files: string[];
  hash?: string;
};
```

---

## Artifact Card Templates (P0 — Renderers)

Every semantic event class gets a **compact card template**. Cards are the default view. Raw transcript is the fallback (expandable, collapsed by default).

### Card Rendering Rules

1. **Metadata row**: glyph + class label + file/path + compact stats
2. **Summary row**: one or two lines; no prose wrapping
3. **Action row**: inline keybinding hints for common actions
4. **Borders**: square corners, single-line rules; no rounded bubbles
5. **Left rail**: 2-char colored stripe (see color map below) aligning with card
6. **Expansion**: `[+]` toggles raw stdout/stderr/args for command cards, full hunks for diff cards

### Card Templates (ASCII Previews)

#### ✓ Edit Card
```
┌── Edit ──────────────────────────────────────────────────────────────┐
│ src/server/auth.ts   +12 ~4 -2                                        │
│ Added request guards and tightened token parsing.                     │
│ [View diff] [Open file]                                               │
└──────────────────────────────────────────────────────────────────────┘
```

#### ≠ Diff Card
```
┌── Diff ──────────────────────────────────────────────────────────────┐
│ src/server/auth.ts                                                    │
│ @@ parseToken                                                         │
│ - accepted nullish bearer values                                      │
│ + reject empty or malformed bearer headers                            │
│ [Expand hunk] [Accept] [Discard]                                      │
└──────────────────────────────────────────────────────────────────────┘
```

#### ⌘ Command Card
```
┌── Command ───────────────────────────────────────────────────────────┐
│ npm test -- auth                                                      │
│ Running in project root…                                              │
│ stdout: 12 passed, 1 failed                                           │
│ [Show full output] [Retry]                                            │
└──────────────────────────────────────────────────────────────────────┘
```

#### ✓ Result Card
```
┌── Result ────────────────────────────────────────────────────────────┐
│ Tests fixed                                                           │
│ Auth suite passes after header parsing change.                        │
│ Duration 38s   Files 2   Commands 3                                   │
└──────────────────────────────────────────────────────────────────────┘
```

#### ⎇ Commit Card
```
┌── Commit ────────────────────────────────────────────────────────────┐
│ fix: tighten auth header parsing                                      │
│ Files: auth.ts, auth.test.ts                                          │
│ [Amend] [Create PR]                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

#### ! Approval Card
```
┌── Approval ──────────────────────────────────────────────────────────┐
│ Run command: pnpm db:migrate                                          │
│ Risk: writes database schema   [MEDIUM]                               │
│ [y] once   [a] always in repo   [n] deny                              │
└──────────────────────────────────────────────────────────────────────┘
```

#### … Plan Card
```
┌── Plan ──────────────────────────────────────────────────────────────┐
│ Add artifact-first renderer                                           │
│ 1. Introduce event classifier                                         │
│ 2. Render Edit/Diff/Command cards                                     │
│ 3. Add right status rail                                              │
│ [Execute plan] [Revise]                                               │
└──────────────────────────────────────────────────────────────────────┘
```

#### ⚠ Error Card
```
┌── Error ─────────────────────────────────────────────────────────────┐
│ Tool call failed: read_file(path="/nonexistent")                      │
│ ENOENT: no such file or directory                                     │
│ [Retry] [Skip] [Show raw]                                             │
└──────────────────────────────────────────────────────────────────────┘
```

#### ✓ Checkpoint Card
```
┌── Checkpoint ────────────────────────────────────────────────────────┐
│ Snapshot before: "fix auth header parsing"                            │
│ Files: 2   Git hash: a1b2c3d                                          │
│ [Restore] [Diff against current]                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Glyph System

Stable glyph semantics improve scan speed and work in narrow terminals. Every glyph has exactly one meaning.

| Glyph | Meaning | Used For |
|-------|---------|----------|
| `✓` | Success / Applied | Edit applied, Result success, Checkpoint created |
| `Δ` | Edit summary | Edit card header |
| `≠` | Diff | Diff card header |
| `⌘` | Command | Command card header |
| `…` | Thinking / In progress | Plan card, Thinking footer state |
| `!` | Approval needed | Approval card header |
| `↺` | Retry | Retry action, Retryable error |
| `⎇` | Git / Branch | Commit card header, Branch in status rail |
| `⊕` | Created artifact | New file, Generated output |
| `⚠` | Warning | Warning-level risk, Non-fatal error |
| `✗` | Failure / Rejected | Failed command, Rejected diff, Error card |
| `→` | Navigation / Context | Context chip, File reference |
| `◉` | Active agent focus | Current agent identity in status rail |

---

## Color Map (Semantic Palette)

Use color **sparingly and semantically**. Green means addition/success, Red means deletion/error, Amber means review/pending approval, Cyan means action/tooling. Muted gray carries metadata. Purple is the Synax brand accent.

```
  GREEN   (#00ff87 or terminal green)   → Success, Applied, Passed
  RED     (#ff5555 or terminal red)     → Deletion, Error, Failed
  AMBER   (#ffb86c or terminal yellow)  → Approval pending, Warning, Risk
  CYAN    (#8be9fd or terminal cyan)    → Tool invocation, Command, Action
  BLUE    (#6272a4 or terminal blue)    → Navigation, Search, Context
  PURPLE  (#bd93f9 or terminal magenta) → Synax brand accent, Agent identity
  GRAY    (#6272a4 dim or terminal bright-black) → Metadata, Timestamps, File paths
```

### Application Rules

1. **Left rail stripe** uses the semantic color for the card's event class.
2. **Card title row** (glyph + class label) uses the semantic color.
3. **Diffs**: green for additions, red for deletions (standard diff coloring).
4. **Risk badges** on approval cards: green=low, amber=medium, red=high.
5. **Everything else** (borders, rules, prose body) stays in default/no-color.
6. **No rainbow** — at most 2-3 colors visible on screen at once.

---

## Persistent Status Rail (Right Side)

### Content

```
┌──────────────────────┐
│ ◉ qwen-coder-7b      │  ← Active model
│ ⎇ feat/artifact-tui  │  ← Current branch
│                      │
│ Files touched (3)    │
│ → auth.ts           │
│ → auth.test.ts      │
│ → middleware.ts     │
│                      │
│ Approvals (1)        │
│ ! db:migrate [M]    │  ← M=Medium risk
│                      │
│ Session             │
│ Cost: $0.042        │
│ Context: 48%        │
│ Uptime: 12m         │
│                      │
│ LSP ✓  MCP ✓        │
│                      │
│ Session history      │
│ 1. fix auth (done)  │
│ 2. add tests (done) │
│ 3. *current*        │
└──────────────────────┘
```

### Behavior

- **Always visible**; never scrolls offscreen.
- **Update on state change only** — cheap repaint, no animation.
- **Collapsible sections**: Files touched, Approvals, Session history can fold.
- **Risk badge**: `[L]` `[M]` `[H]` in colored brackets next to approval items.

### Precedents

| System | Pattern |
|--------|---------|
| **Claude Code** | Bottom status line with branch, cost, context usage |
| **GitHub Copilot** | Agents panel with session cards and statuses |
| **Amp** | Agents panel for thread management |
| **Replit** | Checkpoint/history pane in version-control surface |

---

## Footer State Machine

The footer is two rows: a status line (row 1) and a composer/prompt area (row 2).

### Footer States

```
State: Idle
┌──────────────────────────────────────────────────────────────────────┐
│ Ready.                                                               │
│ > _                                                                  │
│ Ctrl+Enter submit  Esc cancel  Tab cycle mode  F1 help               │
└──────────────────────────────────────────────────────────────────────┘

State: Thinking
┌──────────────────────────────────────────────────────────────────────┐
│ … Thinking… (qwen-coder-7b)                                          │
│ > [dimmed prompt text or hidden]                                     │
│ Ctrl+C interrupt                                                     │
└──────────────────────────────────────────────────────────────────────┘

State: Running <tool>
┌──────────────────────────────────────────────────────────────────────┐
│ ⌘ Running: npm test -- auth    [2s elapsed]                          │
│ > _                                                                  │
│ [spinner or dots animating in status area]                           │
└──────────────────────────────────────────────────────────────────────┘

State: Waiting for approval
┌──────────────────────────────────────────────────────────────────────┐
│ ! Needs approval: pnpm db:migrate [MEDIUM RISK]                       │
│ > _                                                                  │
│ [y] once  [a] always  [n] deny  [d] show details                     │
└──────────────────────────────────────────────────────────────────────┘

State: Diff ready
┌──────────────────────────────────────────────────────────────────────┐
│ ≠ Review diff (2 files changed)                                       │
│ > _                                                                  │
│ [a] accept all  [d] discard all  [r] review one-by-one               │
└──────────────────────────────────────────────────────────────────────┘

State: Error
┌──────────────────────────────────────────────────────────────────────┐
│ ✗ Tool call failed: ENOENT                                            │
│ > _                                                                  │
│ [r] retry  [s] skip  [d] details  [q] abort                          │
└──────────────────────────────────────────────────────────────────────┘

State: Task complete
┌──────────────────────────────────────────────────────────────────────┐
│ ✓ Task complete. 3 edits, 1 commit, 38s.                             │
│ > _                                                                  │
│ [c] continue  [r] review  [q] quit                                   │
└──────────────────────────────────────────────────────────────────────┘
```

### State Transition Diagram

```
                    ┌─────────┐
                    │  Idle   │
                    └────┬────┘
                         │ user submits prompt
                    ┌────▼────┐
                    │ Thinking │
                    └────┬────┘
          ┌──────────────┼──────────────────┐
          │              │                  │
     ┌────▼─────┐  ┌─────▼──────┐   ┌──────▼──────┐
     │ Running  │  │Waiting for │   │  Diff ready  │
     │ <tool>   │  │ approval   │   │              │
     └────┬─────┘  └─────┬──────┘   └──────┬──────┘
          │              │                  │
          └──────────────┼──────────────────┘
                         │
                    ┌────▼────┐
                    │  Idle   │ (or Error → Idle)
                    └─────────┘
```

---

## Segmented Section Rules

Replace rounded dim boxes with **rectilinear discipline**:

```
BEFORE (current — dim rounded bubbles):
  ╭──────────────────────────────╮
  │ Assistant: I'll fix the auth │
  │ file now...                  │
  ╰──────────────────────────────╯

AFTER (proposed — boxed artifact cards with full-width rules):
┌── ✓ Edit ───────────────────────────────────────────────────────────┐
│ src/server/auth.ts   +12 ~4 -2                                        │
│ Added request guards and tightened token parsing.                     │
│ [View diff] [Open file]                                               │
└──────────────────────────────────────────────────────────────────────┘

┌── ⌘ Command ─────────────────────────────────────────────────────────┐
│ npm test -- auth                                                      │
│ stdout: 12 passed, 1 failed                                           │
│ [Show output] [Retry]                                                 │
└──────────────────────────────────────────────────────────────────────┘
```

### Visual Inequality Rules

| Artifact type | Visual weight | Reasoning |
|---------------|---------------|-----------|
| Diff card | **Heaviest** — full-width, syntax-highlighted hunks, prominent accept/discard | Most important decision point |
| Approval card | **Heavy** — colored risk badge, clear action keys, interrupting footer state | Trust boundary; must not be missed |
| Edit card | **Medium** — compact summary with expandable diff link | Frequent; should not dominate scan |
| Command card | **Medium** — shows command + condensed output; expandable | Operational visibility |
| Result card | **Medium-light** — success/failure summary | Outcome closure |
| Plan card | **Light/medium** — steps list, execute/revise actions | Pre-action deliberation |
| Note / Assistant text | **Lightest** — dim, compact, no border accent | Context, not action |

---

## Raw/Details Toggle (P1)

Every card supports expansion into raw detail mode.

### Collapsed (default)

```
┌── ⌘ Command ─────────────────────────────────────────────────────────┐
│ npm test -- auth                                                      │
│ stdout: 12 passed, 1 failed                                           │
│ [Show full output] [Retry]                                            │
└──────────────────────────────────────────────────────────────────────┘
```

### Expanded (on `[Show full output]` or hotkey)

```
┌── ⌘ Command ─────────────────────────────────────────────────────────┐
│ npm test -- auth                                                      │
│ [--] Collapse output                                                  │
│ ┌─ stdout ──────────────────────────────────────────────────────────┐│
│ │ PASS  src/__tests__/auth.test.ts                                   ││
│ │   ✓ rejects empty bearer (4ms)                                     ││
│ │   ✓ rejects malformed bearer (2ms)                                 ││
│ │   ✓ accepts valid token (1ms)                                      ││
│ │ FAIL  src/__tests__/middleware.test.ts                             ││
│ │   ✗ should inject user context (12ms)                              ││
│ │ Tests: 12 passed, 1 failed, 13 total                               ││
│ └───────────────────────────────────────────────────────────────────┘│
│ ┌─ stderr ──────────────────────────────────────────────────────────┐│
│ │ (empty)                                                            ││
│ └───────────────────────────────────────────────────────────────────┘│
│ exit code: 1                                                          │
│ [Retry] [Show args]                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

### Global Raw Mode

- `Ctrl+R` toggles **global raw transcript view** — renders the full structured event stream as a debug overlay (Amp-style `--stream-json`, GitHub session logs, Gemini CLI debug mode).
- This is the escape hatch for diagnosing unexpected model behavior.
- Default: OFF. Never on for normal workflow.

---

## Context Chips (P1)

Make attached context visible instead of burying it in prompt text. Borrow from Sourcegraph Cody.

### Display Rules

```
┌── Plan ──────────────────────────────────────────────────────────────┐
│ Add artifact-first renderer                                           │
│ Context: → src/renderer/cards.ts  → specs/tui-v2.md  → @qwen-coder   │
│ 1. Introduce event classifier                                         │
│ 2. Render Edit/Diff/Command cards                                     │
└──────────────────────────────────────────────────────────────────────┘
```

- `→ file.ts` = file context attached
- `→ @dir/` = directory context
- `→ #symbol` = symbol/function context
- `→ 🌐 url` = web search / docs context
- `→ 📄 spec` = specification / doc context

Chips appear in a compact row below the title, not inline in prose.

---

## Checkpoint / Undo Units (P1)

After meaningful milestones (commit, test pass, file batch complete), create a checkpoint card that enables rollback.

```
┌── ✓ Checkpoint ──────────────────────────────────────────────────────┐
│ Snapshot before: "tighten auth header parsing"                        │
│ Files: 2   Git hash: a1b2c3d                                          │
│ [Restore] [Diff against current]                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### Precedents

| System | Mechanism |
|--------|-----------|
| **Replit** | Checkpoint cards in version-control pane |
| **Aider** | Auto-commit + `/undo` = git-native rollback |
| **OpenCode** | Snapshot system with disk/index costs (warn in large repos) |

### Implementation Notes

- Checkpoints use `git stash` or lightweight tags. Not a separate snapshot system.
- Emit a checkpoint event after: every commit, every 5+ file changes, or on explicit user request (`/checkpoint`).
- Show checkpoint card in timeline. Right rail lists N most recent checkpoints.
- **Do not** make checkpoints automatic before every single edit (Replit may overdo this; Aider's auto-commit is the right granularity).

---

## Approval UX (P0)

Do not bury confirmations in inline prose. Approvals must:

1. **Interrupt the footer state** — switch footer to `Waiting for approval` mode.
2. **Create a compact approval card** in the timeline showing action, risk level, and choices.
3. **Show risk badge in right rail** — so even a scrolled-away approval is visible.

### Risk Levels

| Level | Badge | Color | Examples |
|-------|-------|-------|----------|
| Low | `[L]` | Green | Read file, List directory, Search |
| Medium | `[M]` | Amber | Run tests, Install dev deps, Write to non-critical file |
| High | `[H]` | Red | Database migration, Shell script execution, `rm`, `chmod`, Network outbound |

### Approval Choices

```
! ┌── Approval ────────────────────────────────────────────────────────┐
  │ Run command: pnpm db:migrate                                        │
  │ Risk: writes database schema   [HIGH]                               │
  │                                                                     │
  │ This command will modify the database schema. Review the migration  │
  │ files before approving.                                             │
  │                                                                     │
  │ [y] approve once   [a] always in this repo   [v] view migration     │
  │ [n] deny           [s] skip and continue     [d] show raw args      │
  └─────────────────────────────────────────────────────────────────────┘
```

### Policy Persistence

- `[a] always` writes to `.synax.toml` or session-scoped approval memory.
- `[/permissions]` slash command opens permission review panel (borrow from Claude Code).
- Right rail shows active approval policy summary: `Approvals: auto [L], ask [M] [H]`.

---

## Performance Guardrails (P0 — before polish)

Terminal UIs die on rendering cost. Implement these before visual polish. Items marked ✅ are handled natively by OpenTUI.

| Guardrail | Why | Precedent | OpenTUI |
|-----------|-----|-----------|---------|
| **Virtualize card list** | Only render cards visible in viewport + buffer; collapse offscreen | Amp fullscreen TUI work, Crush lag issues with large tool outputs | ✅ `ScrollBox` with `viewportCulling: true` |
| **Collapse large tool outputs by default** | stdout/stderr > 50 lines gets truncated; expand on click | Amp, Claude Code | ⚡ Build on `ScrollBox`; cap line count and add expand toggle |
| **Cap status rail repaint** | Only repaint right rail on actual state change, not on every frame | Claude Code status line | ⚡ App-level: track state diff before rebuilding right rail VNode tree |
| **Cache measured line wraps** | Compute wrapped line count once per card; reuse on scroll | Std TUI practice | ✅ Yoga handles layout measurement; invalidated only on resize |
| **Breadth budget for color** | Limit terminal color escape sequences per screen redraw | Cheap terminals break on too many SGR codes | ✅ OpenTUI bakes colors into cell buffer; no per-frame SGR flood |
| **Throttle streaming updates** | During tool execution, update footer at 4-8 Hz, not per token | Amp responsiveness docs | ✅ `targetFps: 30` in `createCliRenderer` config; `maxFps: 60` ceiling |
| **Bg command handling** | Long-running commands get spinner + elapsed timer, not stream flood | Claude Code, OpenCode | ⚡ App-level: timer + frame-request via `renderer.requestLive()` |

### Expansion Guardrail (Crush Lesson)

```
DO NOT:
  Expand a 5000-line stdout block into the card body naively.
  This causes logarithmic lag proportional to line count.

DO:
  Truncate at 50 lines with "[Show all 5000 lines...]" toggle.
  When expanded, virtualize the scroll within the card.
  If virtualizing is complex, cap at 200 lines and add "[Open in pager]".
```

---

## Phased Implementation Checklist

### Phase 0 — Semantic Event Model (P0)

- [ ] Define `SemanticEventClass` enum and `SemanticEvent` type
- [ ] Define `ArtifactPayload` discriminated union for each event class
- [ ] Write a classifier that takes raw tool-call/tool-result/assistant-text events and emits typed `SemanticEvent`s
- [ ] **Do not change any rendering yet.** Just pipe events through and log. Validate against live model output.

**Borrow from:** Amp JSON stream, GitHub session model, OpenCode plan/build split

**OpenTUI note:** No OpenTUI code in this phase. Pure TypeScript types and classifier logic. The event model is framework-agnostic.

---

### Phase 0.5 — Card Renderer Infrastructure (P0)

- [ ] Build a `CardRenderer` abstraction that takes a `SemanticEvent` and returns a structured card view model
- [ ] Implement compact card renderers as OpenTUI VNode construct functions: Edit, Diff, Command, Result, Commit, Approval
- [ ] Implement fallback `assistant_text` renderer (dim `Box` with `borderStyle: "single"`, labeled "Note")
- [ ] Add expand/collapse toggle per card for raw details — conditionally append child `Box` with `ScrollBox` for stdout/stderr
- [ ] Wire into the TUI: replace bubble rendering with card rendering as the **default** view
- [ ] Snapshot tests for each card type — render VNode tree to string, compare to golden files

**Borrow from:** Codex CLI review cards, Cody context chips, Aider diff rendering, Crush sectional boxes

**OpenTUI APIs used:** `Box`, `Text`, `ScrollBox`, `CodeRenderable` (for syntax-highlighted diffs), `RGBA`, `t` template literal, `bold()`, `fg()`, `bg()`, `dim()`

---

### Phase 1 — Layout Refactor (P0)

- [ ] Initialize OpenTUI renderer: `createCliRenderer({ screenMode: "alternate-screen", targetFps: 30, exitOnCtrlC: true })`
- [ ] Build root layout: `Box({ flexDirection: "row", width: "100%", height: "100%" })` with three children (left rail, main column, right rail) + absolute-positioned footer
- [ ] Add **left rail** — `Box({ width: 2, backgroundColor })` per card, colored by event class
- [ ] Add **right rail** — `Box({ width: 20, flexDirection: "column", padding: 1 })` with model, branch, files touched, approval queue, cost/context, session history
- [ ] Add **footer state machine** — `Box({ position: "absolute", bottom: 0, width: "100%", height: 2 })`; rebuild subtree on state transition (Idle, Thinking, Running, Waiting, Diff-ready, Error, Complete)
- [ ] Wire prompt composer: `InputRenderable({ placeholder: "Ask Synax…", width: "100%" })` in footer row 2
- [ ] Wire keyboard: `renderer.keyInput.on("keypress", …)` for `Ctrl+Enter` submit, `Tab` cycle, `Esc` cancel, `F1` help
- [ ] Replace all rounded box edges with `borderStyle: "single"` (square corners) and full-width section rules
- [ ] Apply semantic color map to rails, card headers, diffs, risk badges
- [ ] Apply glyph set to all card headers and status items via `t` template literals

**Borrow from:** Claude Code status line, Amp agents panel, GitHub agents panel, Sourcegraph segmentation

**OpenTUI APIs used:** `createCliRenderer`, `Box`, `ScrollBox`, `Text`, `InputRenderable`, `renderer.keyInput`, `renderer.on("resize")`, `RGBA`

---

### Phase 2 — Approval UX (P1)

- [ ] Build Approval card renderer with risk badge and inline choices
- [ ] Add `Waiting for approval` footer state that interrupts workflow (rebuild footer subtree)
- [ ] Add approval queue to right rail
- [ ] Wire `[a] always` persistence to `.synax.toml` or session config
- [ ] Add `/permissions` slash command for policy review

**Borrow from:** Claude Code permissions, Copilot command approvals, Codex approval policy, Amp permissions model

**OpenTUI APIs used:** Same card primitives (`Box`, `Text`, `t`) + footer state swap

---

### Phase 3 — Context Chips & Checkpoints (P1)

- [ ] Build context chip renderer: file→, dir→, symbol#, web🌐, doc📄
- [ ] Attach chips to Plan, Edit, Diff, Command cards when context data is available (render as `Box({ flexDirection: "row", gap: 1 })` of chip `Text` elements)
- [ ] Build Checkpoint card renderer
- [ ] Emit checkpoint events after commits, 5+ file changes, explicit `/checkpoint`
- [ ] Wire checkpoint restore to `git stash apply` or lightweight tag checkout
- [ ] List recent checkpoints in right rail

**Borrow from:** Cody context chips, Replit checkpoints, Aider git undo, OpenCode snapshots

**OpenTUI APIs used:** `Box` (flex row for chip layout), `Text` with `fg()` per chip type, right rail `Text` list

---

### Phase 4 — Theme System & Telemetry (P2)

- [ ] Define semantic palette presets: `default`, `dark`, `light`, `high-contrast` — stored as `RGBA` constants
- [ ] Allow user config for color overrides in `.synax.toml`
- [ ] Add `/theme` toggle command
- [ ] Build golden-file snapshot test harness for card renderers (render VNode to string)
- [ ] Add rendering-cost diagnostics: cards rendered, repaint count, largest card, expand events
- [ ] Add `synax doctor --tui` diagnostic command
- [ ] Wire theme detection: `renderer.waitForThemeMode()` → auto-select `dark`/`light` palette

**Borrow from:** Codex theme picker, Aider color config, Crush `catwalk` golden tests, Claude `/doctor`

**OpenTUI APIs used:** `renderer.waitForThemeMode()`, `renderer.on("theme_mode")`, `RGBA` palette constants

---

## Terminal Constraint Checklist (Cross-cutting)

These must be designed in from day one, not retrofitted. Items marked ✅ are handled natively by OpenTUI.

| Constraint | Requirement | OpenTUI |
|------------|-------------|---------|
| **Multiline prompt** | `Shift+Enter` inserts newline; `Ctrl+Enter` submits; fallback to `Alt+Enter` for tmux users | ⚡ `InputRenderable` is single-line; multiline input is app-level (compose with `ScrollBox`) |
| **Scrollback stability** | Alternative screen buffer (smcup/rmcup); restore terminal on exit; no leftover escape sequences | ✅ `screenMode: "alternate-screen"`; `renderer.destroy()` restores terminal |
| **tmux compatibility** | Test all keybinds in tmux; document known issues; provide fallback config | ⚡ Kitty keyboard protocol may need fallback in tmux; use `useKittyKeyboard` opt-in |
| **Small terminal** | Right rail collapses to icon-only at <100 cols; cards reflow summary text; diffs truncate hunks | ⚡ App-level: listen to `renderer.on("resize")`, swap right rail width/render when <100 cols |
| **No flicker** | Double-buffer repaints; batch escape-sequence writes; avoid full-screen clears | ✅ OpenTUI uses double-buffered cell composition natively |
| **Heavy output** | Virtualize card list; collapse large diffs/outputs; cap per-card line budget | ✅ `ScrollBox` with `viewportCulling: true`; cap lines per card at app level |
| **Resize handling** | Recompute layout on SIGWINCH; recalculate wrapped line counts; don't lose scroll position | ✅ Yoga re-lays out on SIGWINCH automatically; `renderer.on("resize", cb)` for custom logic |

---

## Open Questions

1. **Right rail width**: Fixed 20 chars or auto-sizing based on terminal width? Claude Code uses bottom bar (vertical space), Amp uses right panel (horizontal space). For terminals <120 cols, right rail should shrink or collapse.

2. **Card history limit**: How many cards to keep in the scrollback? Virtualizing helps, but memory still grows. Options: cap at 500 cards, or keep all in a ring buffer and write older ones to a session log file.

3. **Multi-agent rendering**: Amp's agents panel shows concurrent threads. If Synax adds subagents, does each get its own column? Or do subagent events nest under the parent card?

4. **File watcher integration**: Right rail shows "files touched." Does Synax watch the filesystem for external changes, or only track changes made by the agent itself?

5. **Golden test strategy**: Crush's `catwalk` tests are the best public example. Should Synax adopt the same approach (render to string, compare to golden file) or use a screenshot-based approach?

---

## References

| System | What we need from it | Key docs / links |
|--------|---------------------|------------------|
| **OpenTUI** | **Implementation foundation.** Zig core, Yoga flexbox, Box/Text/ScrollBox/Input/CodeRenderable/MarkdownRenderable, rich text, viewport culling, OSC52 clipboard, theme detection, plugin slots, debug overlay | [`@opentui/core`](https://www.npmjs.com/package/@opentui/core), [GitHub](https://github.com/anomalyco/opentui), [docs](https://opentui.dev) |
| Amp | Typed event stream, agents panel, fullscreen TUI responsiveness | `--stream-json`, agents panel docs, "Look Ma No Flicker" post |
| Crush | Sectional boxes, diff-forward layout, golden testing, MCP/LSP | README demo, `catwalk` tests, release notes |
| Claude Code | Status line, permission UI, terminal ergonomics, remote tasks | `/permissions`, `/doctor`, status line customization docs |
| GitHub Copilot | Agents panel, session cards, command approvals, working set | Agent HQ blog posts, agents panel screenshots |
| Codex CLI | Review cards, syntax-highlighted diffs, theme picker, inline approval | Terminal UI references, `/theme`, `/review` docs |
| Sourcegraph Cody | Context chips, full-width separators, inline diff animation, sidebars | UI redesign posts, context chips docs |
| Replit Agent | Checkpoint cards, plan-then-code flow, rollback UI | Agent docs, checkpoint UI references |
| Aider | Auto-commit, `/diff`, `/undo`, Git-native safety, configurable colors | `/diff`/`/undo` docs, color config |
| OpenCode | Build/Plan split, `/details` toggle, snapshots, TUI commands | TUI docs, agent mode docs, snapshot docs |
| Gemini CLI | Approval modes, sandbox badges, debug toggles, config layering | Sandbox docs, approval config, testing flags |

---

---

## Migration Regression: Keyboard Shortcuts (P0)

When migrating from the raw-terminal input parser (`src/tui/input.ts` + `onData`) to OpenTUI's `renderer.keyInput.on('keypress', ...)`, only 3 of ~15 keyboard shortcuts were ported. The following behaviors **must be re-implemented in OpenTUI** before the artifact-first TUI can ship:

### Lost Shortcuts

| Shortcut | Old Behavior | OpenTUI Status |
|---|---|---|
| **Ctrl+C** | Double-press: 1st clears input, 2nd within 800ms exits. During busy: aborts turn + clears steering | ❌ Single-press exits immediately |
| **Ctrl+D** | Exit | ❌ Gone |
| **Escape** | During busy: interrupt turn. Idle: close autocomplete OR clear interrupted state | ⚠️ Interrupts turn only (no autocomplete close, no state recovery) |
| **Enter** | Submit (with steering logic during busy, slash-command routing during busy) | ⚠️ Submits from Input component (no steering or slash-command routing during busy) |
| **Tab** | Autocomplete slash command | ❌ Gone |
| **Arrow Up/Down** | Scroll transcript history (±3 lines). Navigate autocomplete list when visible | ❌ Gone |
| **Arrow Left/Right** | Cursor movement in input | ⚠️ Input component handles internally |
| **Home/End** | Cursor home/end | ❌ Gone |
| **Backspace** | Delete character. During busy: delete from steering buffer | ⚠️ Input component handles internally (no steering buffer) |
| **Steering input during generation** | Queued typed text as steering messages while agent runs, submitted on Enter | ❌ Gone entirely |
| **Bracket paste** | `\x1b[200~` ... `\x1b[201~` masking with paste summary | ❌ Gone |
| **Slash commands during busy** | Route `/settings`, `/resume`, etc. without waiting for model | ❌ Gone |
| **Multiline input** | `Shift+Enter` / newline insertion | ❌ Single-line Input only |
| **History scroll during busy** | Arrow keys scrolled transcript while agent was running | ❌ Gone |
| **Autocomplete overlay** | `/`-triggered command list with Tab navigation | ❌ Gone |

### Implementation Requirements

1. **Ctrl+C double-press**: Track time of first press; clear input on first, exit on second within 800ms. Abort turn + clear steering when busy (don't exit).
2. **Escape state recovery**: Track an `interrupted` flag; second Escape during interrupted state returns to idle.
3. **Arrow keys for scroll**: `ArrowUp` scrolls card list up (≈3 cards), `ArrowDown` scrolls down. Works in both busy and idle states.
4. **Steering during generation**: When agent is busy, typed text accumulates in a local steering buffer displayed in the footer. Enter submits as a steering message after aborting the current turn.
5. **Slash commands during busy**: `/settings`, `/resume`, `/help`, `/model`, `/doctor`, `/permissions`, `/theme` route immediately without waiting for model to finish.
6. **Tab autocomplete**: Pressing `/` triggers a filtered command list overlay. Tab cycles selection. Enter or Tab on selection completes the command.
7. **Bracket paste**: Detect `\x1b[200~` / `\x1b[201~` sequences. If paste content spans multiple lines, replace with `[pasted: N lines, M chars]` placeholder. Forward to session only on Enter.
8. **Multiline input**: `Shift+Enter` inserts newline (or `Alt+Enter` for tmux users). `Ctrl+Enter` submits.
9. **Ctrl+D exit**: In addition to Ctrl+C, Ctrl+D should trigger graceful exit.

### OpenTUI Mapping

| Requirement | OpenTUI API |
|---|---|
| Keybindings | `renderer.keyInput.on('keypress', (key) => { ... })` with `key.ctrl`, `key.shift`, `key.name` |
| Autocomplete overlay | `Box` positioned absolutely above the input area with command `Text` items |
| Steering buffer | App-level string + `footerState()` update on each keystroke |
| Bracket paste | `renderer.keyInput` paste events or raw stdin fallback |
| Scroll offset | `ScrollBox` `scrollTo()` / `scrollBy()` or app-level offset tracking |
| Multiline | Replace single-line `Input` with a multiline `Box` + `Text` nodes or an app-level compose buffer |

---

## Bottom Line

> **The interfaces that feel most alive and beautiful are the ones that make the agent's state, actions, and outputs structurally legible at a glance.**

Synax must render **artifacts, not turns**. The transcript becomes the weak background layer. The strong layer is distinct cards for Plan, Edit, Diff, Command, Result, Review, Commit, Checkpoint, and Approval — plus a persistent status rail that never scrolls away.

OpenTUI provides the native terminal foundation: Yoga flexbox layout (no manual alignment), double-buffered rendering, viewport-culled scrolling, rich text with full RGBA color, Tree-sitter syntax highlighting for diffs, keyboard/mouse input, and plugin slots. Synax builds the artifact vocabulary and semantic event model on top. Everything else follows from this.
