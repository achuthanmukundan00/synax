# Synax AI Core Morphology Spec

## Purpose

Synax’s AI core should become a stable visual identity system, not just a decorative terminal animation.

The core must remain recognizable as **Synax** across all models, while the loaded model subtly changes the **inner morphology** of the contained intelligence.

Core principle:

```text
Synax = the containment chamber
Model = the intelligence morphology inside it
```

This spec defines terminal-renderable patterns, state behavior, and implementation constraints for Codex/reference agents.

---

## Product Direction

Synax is a **contained local intelligence runtime**.

The core should feel like:

- a calm machine iris
- a contained AI organism
- a breathing computational lens
- HAL-like, but not a direct HAL clone
- alive, but restrained
- premium terminal-native, not ASCII novelty art

The visual goal is:

> a living computational eye/organism held inside a strict runtime containment field.

---

## Non-Goals

Avoid:

- generic orb/blob aesthetics
- ASCII hacker-demo energy
- matrix/rainbow effects
- noisy particle soup
- external vendor logos
- mascot-like model themes
- direct HAL copy / “evil red dot” cliché
- excessive glyph variety
- whole-TUI color/theme changes per model

The model-specific behavior should affect the **inner field**, not the whole application.

---

## Base Glyph Vocabulary

Use a small glyph set.

```text
·    far particle / distant field
˙    dim rear or lower-depth particle
.    faint glow
:    stronger glow / denser field
─    light horizontal structure / scan
│    vertical containment
╭ ╮ ╰ ╯    rounded containment corners
╱ ╲        optional aperture/lattice diagonals, sparingly
●    nucleus / pupil / hot center
```

Use sparingly or only in specific active states:

```text
◎ ◉ ═ ━ ×
```

Avoid by default:

```text
# % @ heavy ASCII density ramps
excessive ×
excessive double-line boxes
fake 3D cube cages unless extremely clean
```

---

## Universal Structure

All model profiles should preserve this hierarchy:

1. **Outer field / glow shell**
2. **Synax containment shape**
3. **Inner model morphology**
4. **Nucleus / pupil**
5. **State accents**

Default compact shape concept:

```text
┌ Core ───────────────────┐
│                         │
│        . . : . .        │
│      . : ╭───╮ : .      │
│      . : │ ● │ : .      │
│      . : ╰───╯ : .      │
│        ˙ ˙ : ˙ ˙        │
│                         │
├─────────────────────────┤
│ Loaded   Model          │
│ State    Idle           │
└─────────────────────────┘
```

---

## Canonical Synax HAL-Organica Eye

This is the preferred primary art direction.

```text
                         Synax

              contained local intelligence runtime


                    ·     ·     ·

              . . . . . . . . . . .
          . : : : : : : : : : : : : : .
        . :                               : .
      . :          ╭───────────╮          : .
     . :           │           │           : .
     . :           │     ●     │           : .
     . :           │           │           : .
      . :          ╰───────────╯          : .
        . :                               : .
          ˙ : : : : : : : : : : : : : ˙
              ˙ ˙ ˙ ˙ ˙ ˙ ˙ ˙ ˙ ˙ ˙

                    ·     ·     ·
```

Stronger machine lens variant:

```text
                         Synax

                    core loaded


                    · · · · ·

              . . : : : : : : . .
          . :       ╭───────╮       : .
        . :        ╭╯       ╰╮        : .
       . :         │    ●    │         : .
        . :        ╰╮       ╭╯        : .
          . :       ╰───────╯       : .
              ˙ ˙ : : : : : : ˙ ˙

                    · · · · ·
```

Compact runtime eye:

```text
┌ Core ───────────────────┐
│                         │
│        . . : . .        │
│      . : ╭───╮ : .      │
│      . : │ ● │ : .      │
│      . : ╰───╯ : .      │
│        ˙ ˙ : ˙ ˙        │
│                         │
├─────────────────────────┤
│ Loaded   Qwen3.6        │
│ State    Idle           │
└─────────────────────────┘
```

---

## State Behavior

State drives animation first. Model profile only changes the morphology of that state.

### Idle

- very slow breathing
- subtle field expansion/contraction
- nucleus brightens/dims gently
- no frantic movement

### Thinking

- phase shift around the inner field
- density moves around shell
- model-specific motion personality becomes visible

### Tool Running

- restrained scanline or routed pulse
- should imply execution routed through the core
- do not show raw tool-call spam inside the core

### Success / Complete

- clean outward resolving pulse
- brief harmonized shell
- return to idle

### Blocked / Error

- small contained distortion
- slight density imperfection
- containment remains intact
- avoid `× × ×` glitch spam

### Unloaded

- dim dormant mark
- no or minimal motion
- greyed/desaturated if color is supported

---

## Pointer Interaction

Mouse/pointer behavior is visual only. It must not affect agent state.

### Near Hover

- side nearest pointer becomes slightly denser/brighter
- shell biases toward pointer by at most one cell
- nucleus/pupil may bias by at most one cell

### Hover

```text
┌ Core Module ─────────────────────────────┐
│                                          │
│                  ·   ·     ·             │
│             . . : : : : : . .      →     │
│          . :    ╭────────╮   : .    →    │
│        . :      │   ●   │    : : .   ●   │
│          . :    ╰────────╯   : .    →    │
│             ˙ ˙ : : : : : ˙ ˙      →     │
│                  ·   ·     ·             │
│                                          │
├──────────────────────────────────────────┤
│ Core       Hover                         │
│ Response   Tracking                      │
└──────────────────────────────────────────┘
```

### Click / Press

```text
┌ Core Module ─────────────────────────────┐
│                                          │
│                 · · ·                    │
│            . . : : : : . .               │
│        ───────╭─────────╮───────         │
│        ───────│    ●    │───────         │
│        ───────╰─────────╯───────         │
│            ˙ ˙ : : : : ˙ ˙               │
│                 · · ·                    │
│                                          │
├──────────────────────────────────────────┤
│ Core       Press                         │
│ Pulse      Compressed                    │
└──────────────────────────────────────────┘
```

Click should feel like lens compression, not a button press.

---

# Model-Aware Core Morphologies

## Design Rule

Fixed across all models:

```text
outer containment
layout position
status metadata
basic animation lifecycle
idle/thinking/tool/success/error semantics
```

Variable per model:

```text
nucleus layout
glow density
inner field geometry
motion personality
breathing rate
particle distribution
hover response
scan/pulse style
accent/color role
```

---

## Default / Synax Core

Use for unknown models, custom local models, or disabled morphology mode.

```text
┌ Core ───────────────────┐
│                         │
│        ·  ·  ·          │
│      . : ╭───╮ : .      │
│      . : │ ● │ : .      │
│      . : ╰───╯ : .      │
│        ˙  ˙  ˙          │
│                         │
├─────────────────────────┤
│ Model    Local          │
│ State    Loaded         │
└─────────────────────────┘
```

Motion:

- balanced breathing
- minimal glow shift
- neutral hover focus

---

## Qwen — Crystalline / Lattice Intelligence

Qwen should feel sharp, structured, dense, and geometric.

```text
┌ Core ───────────────────┐
│                         │
│        ·  ·  ·          │
│      . : ╭───╮ : .      │
│    . :  ╱ ·●· ╲  : .    │
│      . : ╰───╯ : .      │
│        ˙  ˙  ˙          │
│                         │
├─────────────────────────┤
│ Model    Qwen           │
│ State    Loaded         │
└─────────────────────────┘
```

Motion:

- precise phase shifts
- angular/lattice breathing
- particles snap into symmetry
- thinking feels like crystalline computation

Profile traits:

```text
geometry: lattice
phaseStyle: snap
hoverBias: magnetic
scanStyle: precise
```

---

## OpenAI / GPT — Clean Centered Lens

OpenAI/GPT should feel smooth, balanced, centered, and product-clean.

```text
┌ Core ───────────────────┐
│                         │
│        . . : . .        │
│      . : ╭───╮ : .      │
│      . : │ ● │ : .      │
│      . : ╰───╯ : .      │
│        ˙ ˙ : ˙ ˙        │
│                         │
├─────────────────────────┤
│ Model    OpenAI         │
│ State    Loaded         │
└─────────────────────────┘
```

Motion:

- smooth breathing
- centered glow
- low visual noise
- hover feels like optical focus

Profile traits:

```text
geometry: lens
phaseStyle: smooth
hoverBias: focus
scanStyle: soft
```

---

## Claude — Soft Organic Aperture

Claude should feel softer, more spacious, language/semantic/organic.

```text
┌ Core ───────────────────┐
│                         │
│        ·   ·   ·        │
│    . . : : : : : . .    │
│  . :     ╭───╮     : .  │
│  . :     │ ● │     : .  │
│  . :     ╰───╯     : .  │
│    ˙ ˙ : : : : : ˙ ˙    │
│                         │
├─────────────────────────┤
│ Model    Claude         │
│ State    Loaded         │
└─────────────────────────┘
```

Motion:

- softer bloom
- wider breathing radius
- less angular
- hover response feels elastic, not sharp

Profile traits:

```text
geometry: organic
phaseStyle: elastic
hoverBias: elastic
scanStyle: soft
```

---

## DeepSeek — Dense Pressure / Furnace Core

DeepSeek should feel lower, denser, compressed, and industrial.

```text
┌ Core ───────────────────┐
│                         │
│        ˙ ˙ ˙ ˙ ˙        │
│      . : ╭───╮ : .      │
│    ──────│ ● │──────    │
│      . : ╰───╯ : .      │
│        ˙ ˙ ˙ ˙ ˙        │
│                         │
├─────────────────────────┤
│ Model    DeepSeek       │
│ State    Loaded         │
└─────────────────────────┘
```

Motion:

- slower pulse
- heavier scanline
- inward compression when thinking
- tool-running feels forceful

Profile traits:

```text
geometry: furnace
phaseStyle: compressed
hoverBias: minimal
scanStyle: beam
```

---

## Gemini — Mirrored / Twin Field

Gemini should have subtle twin-core symmetry without loud rainbow/prismatic gimmicks.

```text
┌ Core ───────────────────┐
│                         │
│        · . : . ·        │
│      . : ╭───╮ : .      │
│      . : │● ·│ : .      │
│      . : │· ●│ : .      │
│      . : ╰───╯ : .      │
│        ˙ . : . ˙        │
│                         │
├─────────────────────────┤
│ Model    Gemini         │
│ State    Loaded         │
└─────────────────────────┘
```

Motion:

- two points phase against each other
- mirrored shimmer
- hover response splits/recombines
- no loud rainbow behavior

Profile traits:

```text
geometry: twin
phaseStyle: mirrored
hoverBias: split
scanStyle: split
```

---

## Optional Later Profiles

### Kimi

- dim moonlike core
- large soft lens
- slower thoughtful pulse

### Llama

- sparse local field
- rugged minimal core
- slightly utilitarian movement

### Mistral

- directional wind/shear phase
- particles offset diagonally
- fast but restrained motion

### Custom wyt / Organica

- neural seed / organic aperture
- elastic bloom
- model-specific creative identity

---

# Organica Variants

Use these if Synax wants a more “AI organica” model morphology.

## Neural Seed Core

```text
┌ Core Module ─────────────────────────────┐
│                                          │
│                 ·     ·                  │
│            ·  . . . . .  ·               │
│          . . :   ╭─╮   : . .             │
│        . :       │●│       : .           │
│          . . :   ╰─╯   : . .             │
│            ·  ˙ ˙ ˙ ˙ ˙  ·               │
│                 ·     ·                  │
│                                          │
├──────────────────────────────────────────┤
│ Core       Loaded                        │
│ State      Idle / breathing              │
└──────────────────────────────────────────┘
```

## Mycelial Intelligence

```text
┌ Core Module ─────────────────────────────┐
│                                          │
│               ·   ·   ·                  │
│          ·  . . . . . . .  ·             │
│        . :     ·─·●·─·     : .           │
│      . :     ·─╯  │  ╰─·     : .         │
│        . :     ·─·●·─·     : .           │
│          ·  ˙ ˙ ˙ ˙ ˙ ˙ ˙  ·             │
│               ·   ·   ·                  │
│                                          │
├──────────────────────────────────────────┤
│ Core       Thinking                      │
│ Field      Coherent                      │
└──────────────────────────────────────────┘
```

## Organic Shell / Engineered Containment

```text
┌ Core Module ─────────────────────────────┐
│                                          │
│              ·  ·   ·  ·                 │
│         . . . . . . . . . .              │
│       . :    ╭─────────╮    : .          │
│      . :     │  · ● ·  │     : .         │
│       . :    ╰─────────╯    : .          │
│         ˙ ˙ ˙ ˙ ˙ ˙ ˙ ˙ ˙ ˙              │
│              ·  ·   ·  ·                 │
│                                          │
├──────────────────────────────────────────┤
│ Core       Loaded                        │
│ Runtime    Contained                     │
└──────────────────────────────────────────┘
```

## Pointer-Reactive Organica

```text
┌ Core Module ─────────────────────────────┐
│                                          │
│                  ·   ·    ·              │
│             . . . . . . . . .      →     │
│          . :      ╭───╮     : : .   →    │
│        . :        │ ● │       : : .  ●   │
│          . :      ╰───╯     : : .   →    │
│             ˙ ˙ ˙ ˙ ˙ ˙ ˙ ˙ ˙      →     │
│                  ·   ·    ·              │
│                                          │
├──────────────────────────────────────────┤
│ Core       Hover                         │
│ Response   Field bending                 │
└──────────────────────────────────────────┘
```

---

# Implementation Architecture

Do not hardcode this inside the renderer with giant `if model.includes(...)` blobs.

Implement a model visual profile resolver.

Suggested TypeScript shape:

```ts
type CoreVisualProfile = {
  id: string;
  label: string;
  match: RegExp[];
  glyphs: {
    nucleus: string;
    secondary?: string;
    farParticle: string;
    rearParticle: string;
    glow: string;
    hotGlow: string;
  };
  geometry: "lens" | "lattice" | "organic" | "furnace" | "twin" | "default";
  motion: {
    breathRate: number;
    phaseStyle: "smooth" | "snap" | "elastic" | "compressed" | "mirrored";
    hoverBias: "focus" | "magnetic" | "elastic" | "minimal" | "split";
    scanStyle: "soft" | "beam" | "inward" | "split" | "precise";
  };
  colorRole?: "neutral" | "green" | "blue" | "violet" | "red" | "gold";
};
```

Resolver:

```ts
resolveCoreVisualProfile(modelId: string): CoreVisualProfile
```

Initial matching:

```text
/qwen/i                 → qwenLattice
/gpt|openai/i           → openaiLens
/claude/i               → claudeOrganic
/deepseek/i             → deepseekFurnace
/gemini/i               → geminiTwin
/kimi/i                 → kimiMoonCore, optional later
/llama/i                → llamaSparseLocal, optional later
/mistral/i              → mistralWindLens, optional later
/default/               → synaxDefault
```

Provider must not matter. Match on model ID string only.

---

# Optional Config Overrides

Add this later if config integration is easy.

```toml
[core_visuals]
mode = "model" # "model" | "default" | "off"

[core_visuals.overrides]
"Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf" = "qwen"
"gpt-5.5-thinking" = "openai"
"claude-sonnet-4.5" = "claude"
"deepseekv4-pro" = "deepseek"
"my-custom-wyt-lora" = "organica"
```

If config integration is too large for the first pass, implement the resolver and leave a clean extension point.

---

# Rendering Requirements

- Keep rendering flicker-free.
- Preserve compact and splash modes.
- Preserve existing runtime states.
- Keep frame generation deterministic where possible.
- Represent core as reusable layered primitives, not random string blobs.
- Do not refactor unrelated TUI systems.
- Degrade gracefully when mouse events or color are unsupported.
- The default should still look premium in monochrome.

---

# Testing Requirements

Add unit tests for `resolveCoreVisualProfile`:

- Qwen model IDs resolve to qwen
- GPT/OpenAI model IDs resolve to openai
- Claude model IDs resolve to claude
- DeepSeek model IDs resolve to deepseek
- Gemini model IDs resolve to gemini
- unknown/local model IDs resolve to default

If frame generation is already tested, add deterministic tests showing distinct morphology for:

- default vs qwen
- default vs claude
- default vs deepseek

Do not add brittle snapshot tests for every animation frame unless the existing codebase already uses that style.

---

# Codex Implementation Prompt

```text
Implement model-aware AI core visual profiles for the Synax TUI.

Goal:
The Synax AI core should keep the same overall containment identity, but subtly change its inner visual morphology depending on the loaded model ID. Provider should not matter. Matching must be based on the model ID string, so Qwen through Relay still looks like Qwen, Claude through any provider still looks like Claude, etc.

Design principle:
Synax is the containment chamber.
The loaded model is the intelligence morphology inside it.

Do not make this into unrelated themes or mascots. The outer containment, layout, runtime status semantics, and state lifecycle should remain consistent. Only the inner core morphology, glyph density, motion style, hover behavior, and accent profile should vary.

Implement a small model visual profile system.

Suggested architecture:
- Add a CoreVisualProfile type.
- Add resolveCoreVisualProfile(modelId: string): CoreVisualProfile.
- Keep this separate from the renderer so the renderer receives an already-resolved profile.
- Avoid large ad hoc conditionals inside render code.
- Support a safe default profile for unknown/local models.

Profiles to implement initially:

1. default / synax
- clean contained lens
- single nucleus
- balanced soft glow
- minimal motion

2. qwen
- crystalline/lattice intelligence
- slightly angular inner field
- precise/symmetric phase motion
- sharper particle distribution

3. openai / gpt
- clean centered lens
- smooth minimal glow
- product-clean, balanced breathing
- optical focus hover behavior

4. claude
- soft organic aperture
- wider, warmer bloom
- elastic breathing
- less angular structure

5. deepseek
- dense compressed furnace/core
- slower heavier pulse
- stronger horizontal scan during tool-running
- inward compression while thinking

6. gemini
- mirrored/twin nucleus field
- two points phase against each other
- subtle split/recombine motion
- avoid loud rainbow effects

Optional if easy:
- kimi: dim moonlike core / large soft lens
- llama: sparse local field / minimal rugged core
- mistral: directional wind/shear phase

Matching:
- Match model IDs case-insensitively.
- qwen model IDs containing "qwen" should resolve to qwen.
- model IDs containing "gpt" or "openai" should resolve to openai.
- model IDs containing "claude" should resolve to claude.
- model IDs containing "deepseek" should resolve to deepseek.
- model IDs containing "gemini" should resolve to gemini.
- Unknown models resolve to default.

Configuration:
If the config system makes this easy, add optional overrides:
[core_visuals]
mode = "model" # "model" | "default" | "off"

[core_visuals.overrides]
"Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf" = "qwen"
"gpt-5.5-thinking" = "openai"
"claude-sonnet-4.5" = "claude"
"deepseekv4-pro" = "deepseek"

If config integration is too large for this pass, implement the resolver and leave a clear extension point for config overrides.

Rendering behavior:
- The renderer should use the profile to choose:
  - nucleus layout
  - glow density
  - inner geometry variant
  - breathing rate
  - thinking phase style
  - tool-running scan style
  - hover response style
  - accent/color role if colors are already supported
- Preserve compact and splash modes.
- Preserve existing runtime states: idle, thinking, tool-running, success, blocked/error, unloaded.
- State still drives animation first; profile only changes the morphology of that state.

Taste constraints:
- Do not add logos for external model vendors.
- Do not use copyrighted/logo-like shapes.
- Do not make the whole UI change per model.
- Do not add noisy ASCII art.
- Keep glyph vocabulary restrained.
- Avoid #, %, @, excessive ×, fake matrix/rainbow effects.
- The default should still look premium in monochrome.

Testing:
- Add unit tests for resolveCoreVisualProfile.
- Test qwen/openai/claude/deepseek/gemini/default matching.
- If frame generation is tested, add a small deterministic test showing the same state renders different inner morphology for at least qwen vs claude vs default.
- Keep changes focused. Do not refactor unrelated TUI code.

Success criteria:
- Loading a Qwen model makes the core feel more lattice/crystalline.
- Loading an OpenAI/GPT model makes it feel like a clean centered lens.
- Loading Claude makes it feel softer and more organic.
- Loading DeepSeek makes it feel denser and more compressed.
- Loading Gemini makes it feel subtly mirrored/twin-core.
- Unknown local models still get a good Synax default.
- The user can tell the loaded model has a distinct “core personality” without Synax losing its own visual identity.
```

---

# Success Criteria

The work is successful when:

- the AI core feels like a breathing machine eye / contained AI organica
- the Synax containment identity remains stable across all models
- Qwen, OpenAI, Claude, DeepSeek, and Gemini have distinct but restrained morphologies
- the result looks good in monochrome
- the result does not look like novelty ASCII art
- compact and splash modes share one coherent design language
- Codex can implement the resolver without risky unrelated refactors

