# Spec 005: Settings Menu UX Overhaul

**GitHub Issue**: [#153](https://github.com/achuthanmukundan00/synax/issues/153)
**Labels**: enhancement, area:cli, area:config
**Priority**: p2

## Problem

The Synax settings menu is not attractive and is hard to parse. It doesn't make proper use of **openTUI** (`@opentui/core`) layout and styling capabilities.

## Issues

- **Visual layout**: The settings display is cluttered and hard to scan.
- **Information hierarchy**: Important settings are not visually distinguished from less important ones.
- **Navigation**: Hard to find and modify specific settings.
- **openTUI underuse**: The settings menu does not leverage openTUI's component model, layouts, or styling system properly.

## Expected Behavior

- Settings should be organized in clear, scannable groups/sections.
- Use openTUI's layout primitives (flex, grid, spacing) for clean visual structure.
- Current values should be clearly visible with clear affordances for modification.
- The menu should feel like a polished, intentional part of the Synax TUI.

## Suggested Fix

- Redesign the settings view using openTUI's component and layout system.
- Group related settings into labeled sections.
- Use consistent spacing, alignment, and color coding.
- Ensure keyboard navigation works intuitively.
- Consider a settings panel or sidebar pattern if openTUI supports it.

## Implementation Notes

- Settings rendering likely in `src/commands/config.ts` or similar.
- Uses `@opentui/core` (v0.2.10) for terminal UI rendering.
- Review openTUI documentation for available layout/components.
- Settings data model in `src/config/`.
