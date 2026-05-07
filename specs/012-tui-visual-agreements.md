# Synax TUI Visual Agreements

Date: 2026-05-06
Status: approved for implementation planning
Scope: interactive TUI visual language refinement and top-right AI core alignment hardening

## 1. Purpose

This spec defines the visual agreement layer for the Synax interactive TUI.

It does not replace the shell architecture in `specs/011-tui-shell.md`.
It refines the current interactive shell so the interface reads as a controlled
local intelligence runtime instead of a generic unfinished terminal app.

The immediate trigger for this spec is a rendering bug in the top-right AI core
containment region, plus a broader need for stronger spatial hierarchy and phase
semantics.

## 2. Product Reading

The TUI should immediately communicate:

> This is a controlled local intelligence reactor. It is alive, powerful,
> disciplined, and currently doing exactly this specific class of work.

Synax is not a chatbot transcript, a dashboard, a scrolling log wall, or a
generic terminal shell.

The correct visual reading is:

- a contained local intelligence runtime
- a reactor-like system under operator control
- a sparse, operational, run-centric interface

## 3. Visual Influence Mix

Target blend:

- 40% industrial reactor / furnace containment
- 30% Alien / Nostromo / MU-TH-UR isolation
- 20% tactical operations terminal
- 10% scientific instrumentation

Emotional target:

- powerful
- alive
- trustworthy
- restrained
- operational

Must not feel:

- cute
- flashy
- noisy
- decorative for its own sake
- SaaS-like
- cyberpunk-sludgy
- chatbot-like
- retro wall-computer toy

## 4. Priority Order

Visual decisions must optimize in this order:

1. Trust
2. Readability
3. Low cognitive load
4. Engineering clarity
5. Machine ambience

Beauty is allowed only when it supports the priorities above.

## 5. Primary Anchors

There are exactly two primary anchors:

1. the AI core containment object
2. the directive input area

Everything else is secondary and must visually support these anchors without
competing with them.

### 5.1 AI Core

The AI core is the persistent identity object of Synax.

It should feel like:

- a contained reactor
- a structural cognition engine
- a live machine core under restraint
- controlled fluid intelligence inside geometry

It must not read as:

- clip-art in the corner
- a spinner
- random Unicode decoration
- terminal noise

### 5.2 Input / Directive Area

The input area should feel like issuing directives to autonomous machinery from
an operations desk.

It must be:

- visually important
- rigidly framed
- compact, not bulky
- multi-line capable
- clearly separated from runtime telemetry
- objective-driven rather than chat-bubble driven

The user should feel they are setting an objective, not casually messaging a
bot.

## 6. Layout Agreements

The screen should preserve a stable full-screen layout with minimal repaint and
no visual jitter.

Recommended reading order:

1. top-left: product identity, current phase, elapsed runtime
2. top-right: AI core containment region
3. upper-middle/left: objective and next checkpoint
4. center: calm semantic progress and file activity
5. lower-middle: verification posture and result state
6. bottom: directive input frame and controls hint

Rules:

- no pane should jump vertically based on content churn
- no decorative block may overlap adjacent text regions
- the AI core region must have reserved space in layout calculations
- clipping must use visible terminal cell width, not raw string length

## 7. AI Core Agreements

### 7.1 Rendering Bias

For this iteration, Synax should optimize for modern terminals first.

Assumptions allowed:

- Unicode-capable terminal
- braille and box-drawing support
- ANSI / truecolor capable terminal
- Ghostty / Alacritty class rendering quality

Fallback-first behavior is explicitly deferred to a later update. Normal plain
CLI and headless mode must remain intact, but the interactive TUI may bias
toward richer rendering by default.

### 7.2 Structural Rules

The AI core renderer must obey these invariants:

- fixed width across all phases
- fixed height across all phases
- stable outer containment geometry
- motion occurs primarily in the internal field, not the outer frame
- phase changes must alter posture, density, and motion semantics
- the core must never push, clip, or misalign surrounding layout

The outer shape should feel like containment hardware. Internal glyph changes
carry state.

### 7.3 Motion Rules

Motion must be:

- smooth
- controlled
- phase-coupled
- alive through micro-adjustments
- calm when idle
- more active under real work

Motion must not be:

- random
- spammy
- fake hacker animation
- decorative noise untied to state

### 7.4 Phase Postures

The core must visibly change by phase so the user can recognize state from the
corner of their eye.

Required postures:

- `idle`: stable low-energy containment with faint breathing
- `planning`: geometry alignment and scaffold formation
- `thinking`: contained turbulence and rising internal pressure
- `reading`: scan sweep or radial inspection behavior
- `writing`: focused compression and directed beam-like activity
- `bash` / `git`: industrial conduit or machinery engagement
- `verifying`: symmetric lattice lock and integrity scan
- `blocked`: containment clamp or warning posture
- `completed`: pressure settles into resolved stability
- `failure`: controlled containment fault, not panic

If the runtime state model is more granular than the renderer contract, the TUI
may map multiple runtime phases into one core posture, but the mapping must be
explicit and tested.

## 8. Information Policy

Synax must never leave the user unsure what the model is doing.

However, it must not expose raw low-level implementation chatter in the default
interactive surface.

Default-visible semantic states include:

- thinking / planning
- reading path
- writing / editing path
- running bash or git command
- verifying
- blocked reason
- completion result

Default-hidden noise includes:

- raw JSON
- raw tool payloads
- verbose stack traces
- retry churn
- token-by-token generation spam
- chain-of-thought style output

Preferred language:

- `Reading src/agent/runner.ts`
- `Editing runtime state reducer`
- `Running git status`
- `Verifying test suite`

Avoid:

- fake mystical language
- over-abstract machine poetry
- raw protocol dumps

## 9. Secondary Panels

Progress, file activity, and verification sections should remain calm and
semantic.

Agreements:

- progress shows recent high-level steps, not transcript chatter
- file activity shows touched paths with concise operation labels
- verification shows posture and current check, not full command spam
- blocked or risk states should be surfaced clearly and briefly

A single semantic activity summary line is preferred over many noisy micro-lines
when possible.

## 10. Input Area Agreements

The directive region should be visibly stronger than the surrounding telemetry.

Requirements:

- framed as a control surface
- supports multi-line objective entry
- remains separate from progress logs
- remains readable even while the run is active
- does not adopt chat transcript conventions

Suggested language in the frame should use operational nouns such as
`Objective`, `Directive`, or equivalent terms already aligned with Synax.

## 11. Color Philosophy

The TUI must not fight the user’s shell theme.

Rules:

- default to monochrome or inherited foreground
- use sparse accents only
- do not rely on color alone for phase distinction
- phase distinction may also use glyph shape, density, posture, and motion
- avoid rainbow palettes and loud gradients

Color is subordinate to legibility and structural semantics.

## 12. Absolute Bans

Do not implement:

- block-test style novelty visuals
- rainbow gradients
- typing simulation
- Matrix effects
- chatbot bubbles
- token vomit
- spinner spam
- noisy loading bars
- fake hacker gibberish
- decorative telemetry with no semantic purpose
- flickering full-screen redraw behavior beyond necessary viewport sync

## 13. Minimal Implementation Direction

This pass should avoid a broad TUI rewrite.

Preferred implementation scope:

- add explicit visual agreement spec
- formalize phase-to-core-state mapping
- refine AI core renderer helpers for stable fixed-footprint frames
- reserve a stable core region in layout math using visible width
- strengthen the input area treatment
- add a semantic activity summary line
- add optional accent/config hooks only if they are cheap and local
- preserve normal CLI and headless behavior

Do not:

- replace the whole TUI
- introduce new dependencies without strong need
- refactor unrelated architecture

## 14. Testing Expectations

Verification for this visual pass should include:

- layout tests for visible-width clipping and core-region reservation
- AI core tests for fixed width / fixed height across modes
- phase mapping tests where applicable
- interactive TUI tests for stable rendering assumptions where practical
- existing project verification required by touched files

At minimum, implementation must run:

- `npm run typecheck`
- relevant Jest tests
- `npm test`
- `npm run build`

## 15. Definition of Done

This work is done when:

- the top-right AI core no longer visually misaligns with surrounding layout
- the AI core reads as a controlled identity object instead of decorative ASCII
- the input area is clearly elevated as an operator directive region
- runtime state reads semantically and calmly
- the interface feels more like a contained local intelligence reactor than a
  generic terminal app
- normal non-TUI behavior remains intact
