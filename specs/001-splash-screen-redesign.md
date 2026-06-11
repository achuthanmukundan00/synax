# Spec 001: Splash Screen Redesign (2027)

**GitHub Issue**: [#149](https://github.com/achuthanmukundan00/synax/issues/149)
**Labels**: enhancement, area:cli
**Priority**: p2

## Problem

The Synax splash screen sucks. It isn't as functional as it was with the first design, and it feels stale and uninspired.

## Desired Outcome

Rework the splash screen to be **cool, sexy, and full of personality** — sort of like Amp and Droid but way better and more **2027**.

### Requirements

- **Visual punch**: It should feel modern, distinctive, and memorable on first launch.
- **Personality**: Should convey Synax's identity — local-first, sharp, capable, CLI-native.
- **Functional**: Should still serve its purpose (loading indication, version info, etc.) but with style.
- **Terminal-native**: Use terminal graphics capabilities (colors, Unicode, box-drawing) without requiring a web UI.
- **Fast**: No perceptible startup delay from the splash rendering.

### Inspiration

- Amp (terminal amp framework) — bold, colorful, rhythmic.
- Droid — retro-futuristic terminal aesthetics.
- Synax should be *better* than both — more refined, more 2027, more distinct.

## Implementation Notes

- Located in `src/commands/` splash/startup rendering.
- Uses `@opentui/core` for terminal rendering.
- Should respect `NO_COLOR` and terminal capabilities.
