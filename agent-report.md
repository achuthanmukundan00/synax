# Synax Project — Multi-Agent Session Log Synthesis

**Period**: April 29 – May 16, 2026  
**Report compiled**: May 16, 2026  
**Sources**: Codex history (160 entries), DeepSeek via CLI history (206 entries), pi sessions (38 dirs), Synax self-sessions

---

## 1. Overview: Who Did What

Four coding agents were used across the Synax project (and sibling projects), often concurrently:

| Agent | Period | Sessions / Entries | Primary Use |
|-------|--------|-------------------|-------------|
| **pi** (Earendil) | Apr 29 – May 16 | 38 session dirs | Architecture research, Relay testing, early Synax TUI scaffolding, portfolio setup |
| **Codex** (OpenAI) | May 8 – May 16 | 159 history entries | TUI visual design, config/relay setup, Backrooms easter egg, OpenTUI migration, bun migration, TUI polish |
| **DeepSeek via CLI** | May 14 – May 16 | 206 history entries | Synax bug fixing + TUI, AutoCareer, Rentack Dashboard, Resample Lab, wytOS |
| **Synax** | May 13 – May 16 | Self-referential | Limited production use — mostly testing itself |

**Key observation**: pi was the early-phase agent (architecture, scaffolding), Codex was the velocity agent (rapid feature building and refactoring), and the DeepSeek-powered CLI was the breadth agent (multi-project work and polish).

---

## 2. Project Timeline & Major Events

### Phase 0 — Architecture & Scaffolding (Apr 29 – May 8)

- pi session in `~/workspace/engineering notes/synax/` on **May 9**: User asked pi to synthesize an engineering plan from architecture research, create GitHub issues for structured migration from alpha to production.
- pi sessions on May 6–8 worked extensively in worktrees: `synax-tui` (14 sessions), `synax-unslop`, `ci-logging`, `observability-store`, `parser-repair`, `session-extract`.
- pi also scaffolded the achu-portfolio site (Astro + TypeScript, May 8) and added Relay smoke tests (Apr 29).

### Phase 1 — Alpha Prototype (May 8 – May 11)

- **Codex** joined on May 8. Earliest tasks: fix test failures, clean up config files, consolidate relay-cf/relay-local providers.
- Codex ran the first major TUI visual redesign: "visually align Synax TUI closer to the Codex CLI screenshot" — adding breathing room, reducing glyph density, preserving the right-side Synax Core panel.
- **Backrooms Easter Egg** (May 9): Codex implemented a ray-marched ASCII backrooms with room exploration, wall collisions, room name generation (AI company parodies like "ClosedAI", "Misanthropic", "ZuckNet"). Discovered multiple bugs: horizontal slicing glitching, flickering, model selection broken.
- Codex fixed typewriter effect flickering, zombie-TUI-on-exit bug, duplicated note cards.

### Phase 2 — Deep Architecture Fix Attempt (May 11–12)

- **Codex** was handed a massive diagnosis paste listing 6 critical bugs:
  1. EventBus was dead code — Session used raw callbacks instead of the bus
  2. Compaction too aggressive for 1M+ context models — `assembleModelMessages()` stripped context
  3. TUI horizontal slicing — ANSI width miscalculation + render loop race
  4. Early model completions — `_compacted` markers confused models
  5. Token budgeting: 65K limit on 1M model — provider presets lacked `contextWindow: 1000000` for DeepSeek
  6. Handoff never triggered — compaction pipeline ended at Stage 4 fail-closed
- Codex was asked to use parallel subagents to fix all of these.
- Codex later reported: "subagent execution didn't work," "it went for 4-5 minutes, reported 2 subagents, said pretty much nothing else, then failed with red error." This pattern repeated — **subagent orchestration was never reliably fixed**.
- Deeper analysis followed: token estimation using `chars / 3` was wildly inaccurate for code (30–50% overcount), context strategy thresholds were wrong, `compactMessagesMultiStage` needed fixing for "light" strategy.

### Phase 3 — OpenTUI + Bun Migration (May 12–15)

This was the most painful phase.

- **Codex** was tasked to implement a spec (artifact-first-tui-issue.md) to scrap the existing TUI and move to OpenTUI. Zig was installed. Bun replaced Node.
- Immediate aftermath: "the tui is currently very broken. we switched to openTUI and migrated the runtime to bun."
- A cascade of bugs followed over multiple sessions:
  - Enter key didn't submit prompts
  - TUI flickered constantly
  - Prompt box didn't expand for multiline
  - Slash commands broken — autocomplete empty, couldn't navigate with arrows
  - Settings menu broken — couldn't enter, couldn't see which tab was active
  - Cursor jumped behind typed text instead of tracking ahead
  - Scroll broken — trackpad didn't work, only arrow keys
  - "◇ completed" diamond cards spammed the transcript
  - Model responses empty (maxTokens not passed to LLM — thinking ate all tokens)
  - Memory leak detected: "11 selection listeners added to CliRenderer"
  - bun-ffi-structs broke overnight when Bun shipped a Rust rewrite
- The **DeepSeek CLI** joined on May 14 with a paste of TUI errors and was asked to "systematically debug" from synax's last session logs.
- A hybrid approach was attempted: "hybridize OpenTUI with Pi's better rendering logic," then "commit to building our own TUI package."
- TUI themes didn't pick up terminal theme. Light mode terminals showed invisible white text.
- Adaptive frame scheduling spec was written and implemented: idle = 0 FPS, active = up to 60 FPS, markDirty-based.
- By May 15, things stabilized somewhat — but regressions remained: settings menu showed transcript underneath, cursor behavior broken, agent stopped working after first turn.

### Phase 4 — Multi-Project Expansion (May 15–16)

- The **DeepSeek CLI** pivoted heavily to sibling projects:
  - **AutoCareer**: Job search agent platform, resume synthesis, GitHub intelligence, Discord reminders
  - **Rentack Dashboard**: Property swipe UI, styling, deployment
  - **Resample Lab**: Audio DSP tool, Cloudflare Pages + Render deployment, 512MB RAM limit debugging
  - **wytOS**: Creative memory/OS project
- **Codex** continued on Synax TUI: AI core morphology splash system with model-specific visual profiles (Qwen=crystalline, Claude=organic, DeepSeek=furnace, Gemini=twin)
- Codex also worked on token stream indicators: `˙·.:●:.·˙` shimmering glyph system with per-glyph color roles
- **Synax** itself was used sparingly — last session shows it partially working but with serious bugs: "after the first turn it seems to just not work," agent returns only "Status: completed / Working tree: clean" after first prompt.

---

## 3. Cross-Agent Learnings

### 3.1 What Worked

**pi for architecture and scaffolding**: pi's earliest sessions (Apr 29) were the most methodical — setting up smoke tests for Relay, scaffolding portfolio sites, running the SOTA architecture review. The approach was controlled, structured, and produced usable artifacts.

**Codex for rapid iteration**: Codex's high-speed, image-aware workflow was effective for visual TUI design, implementing creative features (Backrooms easter egg), and pounding through bug lists. The user clearly preferred Codex for "vibe" tasks — visual polish, config cleanup, splash screen design.

**DeepSeek CLI for multi-project breadth**: The CLI agent's subagent orchestration (when it worked) was used across 5+ projects in 2 days. The ability to spawn parallel subagents for reading, fixing, and running was the key pattern.

**Image pasting as a debugging pattern**: Across all agents, the user pasted terminal screenshots extensively. This was the primary debugging mechanism — rather than describing bugs in text, the user showed what the TUI looked like. This worked well for visual bugs but created a dependency on image-capable agents.

### 3.2 What Failed

**OpenTUI migration was premature and destructive**: The wholesale replacement of a working (if imperfect) custom TUI with a Zig-native framework (OpenTUI) caused weeks of regressions. The user's instinct was right: "hybrid approaches are messy. we are faithfully using openTUI" — but faithful adoption broke enter-to-submit, scrolling, slash commands, settings, cursor tracking, and multiline input simultaneously. The later instinct to "hybridize OpenTUI with Pi's rendering logic" and eventually "build our own TUI package" suggests the custom-diff-renderer approach was actually the right path all along.

**Subagent orchestration never worked reliably**: Across Codex and Synax itself, parallel subagents were requested repeatedly but never functioned correctly. The diagnosis paste identified the root cause (EventBus was dead code — Session used raw callbacks) but the fix was never completed. Every attempt at parallel execution resulted in timeouts, empty output, or crashes.

**Token estimation was fundamentally broken**: The `chars / 3` heuristic overcounted by 30–50% for code-heavy contexts. Combined with missing provider presets (DeepSeek's 1M context window was never registered in the provider config, causing it to fall back to 128K), this meant the compaction pipeline was both too aggressive (overcounting tokens) and the model context was artificially limited.

**Bun migration added fragility with no immediate benefit**: Swapping Node for Bun introduced `bun-ffi-structs` dependencies, Zig toolchain requirements, and broke when Bun's upstream rewrote from Zig to Rust overnight. The user acknowledged this: "is it impossible for the user to use synax without bun, zig and ffi" — a valid concern that was never resolved.

**Repetitive visual polish at the expense of core function**: A huge fraction of sessions were spent on pixel-level TUI tweaks: card spacing, glyph colors, splash screen morphology, shimmer effects, token stream indicators. Meanwhile, the agent stopped working after the first turn, subagents were broken, and model responses were empty. The visual polish ratio vs. core reliability work was badly skewed.

### 3.3 Pain Points by Agent

| Pain Point | Agent(s) Affected | Severity |
|-----------|-------------------|----------|
| TUI flickering / glitching | Codex, DeepSeek, Synax | **Critical** — never fully fixed, spanned the entire TUI migration |
| OpenTUI keyboard input broken | Codex, DeepSeek | **Critical** — enter/submit, cursor, arrow nav, slash commands all regressed |
| Agent stops after first turn | Synax, Codex | **Critical** — repeated "Status: completed" with no actual work after prompt 1 |
| Empty model responses | Codex | **Critical** — maxTokens never passed, thinking ate all output tokens |
| Subagent orchestration broken | Codex, Synax | **Critical** — EventBus dead code, never wired |
| Compaction too aggressive | Codex | **High** — effective limit ~114K for 1M model |
| Token estimation wildly wrong | All | **High** — chars/3 overcounts code 30–50% |
| Settings menu broken | Codex, DeepSeek | **Medium** — treeBuilt=false needed on every visibility change |
| Light mode unreadable | Codex | **Medium** — white text on white background |
| Memory leaks (event listeners) | DeepSeek | **Medium** — 11 selection listeners on CliRenderer |
| bun-ffi broke on upstream change | DeepSeek | **Medium** — Bun Rust rewrite broke Zig FFI |

---

## 4. Architectural Patterns Discovered

### 4.1 TUI Architecture Instability

The TUI went through three distinct eras in ~2 weeks:

1. **Custom Diff Renderer** (May 6–12): `src/tui/diff-renderer.ts`, cell-level diffs between frames, AI core sidebar overlay. Had horizontal slicing bugs but fundamentally worked.
2. **OpenTUI-native** (May 13–14): Full migration to `@opentui/core`. Broke everything — enter key, scrolling, slash commands, settings, cursor, multiline input, autocomplete. Discovered that `visible` property toggling on existing Box nodes doesn't trigger re-layout — `treeBuilt = false` + full rebuild was required.
3. **Hybrid / Custom TUI Package** (May 15–16): Attempt to hybridize OpenTUI with pi's differential renderer, strip out unused OpenTUI components (modals), build a self-maintained TUI package. Still in progress with regressions.

### 4.2 Provider/Model Config Gaps

- Provider presets (`provider-presets.ts`) lacked `contextWindow` for DeepSeek, causing 1M model to fall back to 128K default.
- The `none` context strategy (`mode: 'off'` with `contextWindowOverride: Infinity`) was correctly defined but never activated because model detection fell through to `moderate` strategy.
- `strategyReserveTokens` was used as `reservedOutputTokens`, conflating two different concepts.

### 4.3 EventBus as Dead Code

The `src/events/EventBus.ts` module existed but was never instantiated or wired into the Session. Session used raw callbacks (`onEvent`, `onActivity`, `onBudget`) directly. This meant:
- No event deduplication
- No lifecycle guarantees
- Multiple subscribers got every event independently
- Parallel subagent execution was architecturally impossible (no centralized bus for coordination)

### 4.4 Skill/System Prompt Injection

The `assembleModelMessages()` function ran on every model turn, compacting old tool results with `_compacted` markers. This confused models that were trained on real tool outputs — the compacted format (`{"_compacted": true, "path": "src/foo.ts", "lines": "1-50/200"}`) was not part of their training distribution.

---

## 5. What Synax Actually Learned About Local Models

These are the hard-won facts discovered by running Synax against local/relay models:

1. **Qwen models emit stray `</think>` closing tags** even when thinking mode is off. Multiple sanitizer passes were added, but the tags kept reappearing. The fix (strip closing think tags in all sanitizers) was applied and regressed multiple times.

2. **Local model tool-call parsing is fragile**: Qwen models frequently emit "ambiguous mixed output" — tool calls plus final text in the same response. Synax added recovery logic but it remained imperfect.

3. **Thinking/reasoning content must be streamed**: Users need to see chain of thought in realtime. Truncating it (as Synax initially did) creates the illusion the model is stuck. The solution was a collapsed thinking card expandable with Ctrl+O.

4. **`finish_reason=length` is common**: Local models often hit token limits mid-response. Synax added "injecting continuation" logic but it was unreliable.

5. **Provider base URLs are a config mess**: The user's setup involved llama.cpp on `temper-inference` server, Relay as a local gateway, Cloudflare headers, DeepSeek API, and OpenRouter. Config deduplication was a persistent challenge — the user repeatedly asked to "remove duplications" and "make sure the info is only in one place."

6. **Model thinking speed varies wildly**: DeepSeek's thinking was reported as fast on other agents but slow on Synax, suggesting Synax was introducing overhead or not properly streaming thinking tokens.

---

## 6. Sibling Project Learnings

### AutoCareer
- Built as a job search agent platform: resume synthesis, GitHub intelligence, Discord reminders
- Goal: multiple subagents working on tasks with a persistent main agent accruing info/memories
- Key insight: "waiting on synax's SDK for agent capability" — AutoCareer was designed to plug Synax in as its brain
- GitHub intelligence identified as the highest-leverage next step: "AutoCareer only becomes 'oh shit, it understands me' once it deeply reads repos"
- Browser-based dashboard with profile synthesis, evidence graph, resume generation

### Resample Lab
- Audio DSP tool: ffmpeg + numpy + scipy, local-first, no cloud upload
- Deployed to Cloudflare Pages (frontend) + Render (backend, 512MB RAM)
- Discovered that 512MB was insufficient — even 3-second files exceeded RAM limits
- Required extensive RAM profiling: "can you accurately evaluate how much ram these effects really need"
- Added Haas stereo widening effect, grain delay, lowpass/highpass filters, soft clipping
- Frontend was a Next.js app with progressive enhancement

### Rentack Dashboard
- Property rental swipe interface (Tinder-style)
- Gradle backend + React frontend
- Styling and interaction polish: pill-shaped buttons, card stack layout, overlay badges

---

## 7. Meta-Learnings: How Agents Were Used

### 7.1 User's Agent-Orchestration Patterns

1. **Paste-and-pray**: The user frequently pasted massive chunks of text (diagnoses, error logs, terminal output, specs) and asked agents to process them. Sometimes in the same session, sometimes across sessions with `/resume`.

2. **Image-first debugging**: Terminal screenshots were the primary debugging artifact. The user rarely described bugs — they showed them.

3. **"Use subagents" as a reflex**: Nearly every complex task ended with "use subagents" or "fan out with subagents." This rarely worked but was persistently requested.

4. **One-turn then bail**: Many sessions show a single complex request followed by `/resume` in a new session when the agent failed or timed out.

5. **Worktree isolation**: The user frequently created git worktrees for parallel work, then had agents operate in specific worktrees.

### 7.2 What the User Valued

- **Visual quality**: The user has extremely high visual standards. TUI pixel-level feedback dominated sessions: card width, glyph spacing, color roles, shimmer effects, splash screen morphology.
- **Compact presentation**: Repeated requests to "nuke the sidebar," "make it compact like codex," "remove dead space."
- **Speed and responsiveness**: Impatience with slow model response, laggy UI, unnecessary rendering.
- **Creative/hacker energy**: The Backrooms easter egg, AI company parody names, token stream glyphs as "AI core emissions" — the user wants the tool to feel alive and opinionated.

### 7.3 What Agents Struggled With

- **10+ concurrent fixes in one session**: Large paste-diagnoses with 6+ bugs often resulted in partial fixes and new regressions.
- **TUI framework internals**: OpenTUI's invisible-layout-on-visible-change behavior took multiple sessions to discover.
- **bun vs node confusion**: After migrating to bun, agents frequently ran `npm` commands and had to be corrected. The `bun verify` command became a running joke.
- **git commit co-authorship**: The CLI auto-added "Co-authored-by" lines to commits, which the user explicitly rejected: "i am not using an external model i'm using my own local model via DeepSeek."

---

## 8. Current State (as of May 16, 2026)

### What Works
- `synax chat` and `synax run --tui` launch (with OpenTUI)
- Basic model loading (Qwen, DeepSeek, Gemma via Relay)
- Slash command autocomplete (partially — shows list, navigation intermittent)
- Settings menu (partially — renders, tab navigation works, highlighting broken)
- AI core splash screen with model-specific morphology profiles
- Token stream indicator (`˙·.:●:.·˙`) with per-glyph color roles
- Markdown table rendering in transcript
- Activity strip bar for thinking/working status

### What's Broken
- **Agent stops working after first turn** — returns only "Status: completed" boilerplate after prompt 1
- **Cursor behavior** — jumps behind typed text, doesn't track insertion point
- **Scrolling** — trackpad unreliable, long transcripts unreadable
- **Settings menu** — shows transcript underneath, tab highlighting broken
- **Light mode** — white text unreadable on white backgrounds
- **Subagent orchestration** — EventBus still not wired
- **Token estimation** — still using chars/3 heuristic
- **Compaction** — too aggressive for large-context models
- **Diamond cards** — "◇ completed" spam still appearing in transcript
- **bun verify** — tests failing, snapshot updates needed

### What's Staged/Uncommitted
- ~20 unstaged changes: TUI deletions and modifications
- ~3 staged files: tui-state.ts, Session.ts, tui-state.test.ts
- Branch: main, 4 commits ahead of origin, not pushed

---

## 9. Recommendations

### Immediate (Next Session)
1. **Fix the "agent stops after first turn" bug** — this is the single most important issue. Without it, Synax is not usable.
2. **Wire the EventBus into Session** — this unblocks subagent orchestration and event deduplication.
3. **Fix cursor tracking** — cursor must stay at insertion point, not jump behind text.
4. **Add DeepSeek context window to provider presets** — one-line fix with massive impact.

### Short-Term (This Week)
5. **Freeze TUI visual work** — the visual system is good enough. Core function must come first.
6. **Replace chars/3 token estimation** — use tiktoken (cl100k_base) for OpenAI-compatible, chars/4 for unknown.
7. **Fix compaction pipeline** — light strategy should fall through to stages 1-3 instead of hard-stopping at stage 0.
8. **Restore scroll/trackpad behavior** — must work with mouse wheel and trackpad, not just arrow keys.

### Medium-Term
9. **Extract TUI into a standalone package** — the hybrid OpenTUI + custom approach needs to stabilize into a well-defined API.
10. **Remove bun-ffi dependency or add fallback** — Synax should work without Zig toolchain.
11. **Write integration smoke tests** — the "agent stops working" bug shows there are no end-to-end tests for multi-turn conversations.
12. **Ship v0.1.1** — tag a release once the top 4 issues are fixed.

### Strategic
13. **Resist framework migrations** — the OpenTUI migration cost weeks. Future framework changes should be evaluated against: (a) what problem does this solve that the current approach cannot? (b) what is the migration surface area? (c) what is the fallback if it breaks?
14. **Separate visual polish from core reliability work** — they should be different branches, different sessions, different priorities.
15. **Build SDK for AutoCareer integration** — AutoCareer explicitly designed to use Synax as its brain. This is the path to Synax being used in production by another project.

---

## 10. By the Numbers

| Metric | Count |
|--------|-------|
| Total agent sessions (pi) | 38 |
| Total Codex history entries | 160 |
| Total DeepSeek CLI history entries | 206 |
| Sibling projects touched by agents | 5 (Synax, Relay, AutoCareer, Rentack, Resample Lab, wytOS, Portfolio) |
| TUI rewrites/overhauls | 3 (custom diff → OpenTUI → hybrid) |
| "Use subagents" requests | ~15 |
| Times subagents actually worked | ~1–2 |
| Terminal screenshots pasted | ~50+ |
| "◇ completed" bug reports | ~8 |
| Names of AI company parody rooms in Backrooms | ClosedAI, Misanthropic, ZuckNet, Gronk, ShallowMind, Perplexed |

---

*Report compiled from Codex CLI, DeepSeek-powered CLI, pi, and Synax session logs by pi coding agent.*
