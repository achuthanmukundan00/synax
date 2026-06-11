# Spec 003: Prompt Box Overflow Bug

**GitHub Issue**: [#151](https://github.com/achuthanmukundan00/synax/issues/151)
**Labels**: bug, area:cli
**Priority**: p1

## Problem

The prompt box is buggy. When typing a long prompt, the text **overflows into the area below the prompt box** instead of the prompt box expanding vertically to show the full prompt being typed.

## Expected Behavior

- The prompt/input box should **expand** to accommodate the typed text.
- Text should remain within the bounds of the input area.
- The area below should not be invaded by overflow text.

## Actual Behavior

- Prompts that exceed the width or height of the input box leak/overflow into the rendering area below.
- The input box does not grow or scroll to contain the text.

## Impact

- Users cannot reliably compose or review longer prompts.
- Visual corruption makes the TUI feel broken and unpolished.
- Essential for a coding agent where prompts can be long and detailed.

## Suggested Fix

- Implement proper text wrapping and/or scrolling within the prompt input component.
- Ensure the prompt box expands (up to a reasonable limit) as text is added.
- Clip or scroll overflow that cannot be displayed within the component bounds.

## Implementation Notes

- Prompt input is part of the TUI layer using `@opentui/core`.
- Look at how the prompt component handles multi-line text and overflow.
- May need to set proper bounds/clipping on the input area.
- Consider using openTUI's built-in scroll/clip capabilities if available.
