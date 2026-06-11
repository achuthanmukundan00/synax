# Spec 004: Bracketed Paste Support

**GitHub Issue**: [#152](https://github.com/achuthanmukundan00/synax/issues/152)
**Labels**: bug, area:cli
**Priority**: p1

## Problem

Bracketed paste does not work in the Synax TUI.

## What is bracketed paste?

Bracketed paste is a terminal feature where pasted text is wrapped in escape sequences (`\e[200~` ... `\e[201~`), allowing the terminal application to distinguish between typed input and pasted input. This lets the application:

- Handle multi-line pastes correctly.
- Prevent accidental execution of pasted newlines.
- Apply paste-specific formatting or confirmation.

## Expected Behavior

- Pasting text into the Synax prompt box should work correctly.
- Multi-line pastes should be handled gracefully.
- Pasted content should not trigger unintended actions.

## Actual Behavior

- Bracketed paste either doesn't work or is not handled properly.
- Pasted text may be mangled, truncated, or cause unexpected behavior.

## Impact

- Users who paste code snippets, error messages, or context into Synax get broken behavior.
- Critical for a coding agent where pasting is a primary input method.

## Suggested Fix

- Enable bracketed paste mode on the terminal (send `\e[?2004h`).
- Parse `\e[200~` / `\e[201~` escape sequences in the input handler.
- Ensure pasted content is treated as atomic input, not character-by-character.

## Implementation Notes

- Terminal raw mode setup likely in `src/commands/` or a TUI input module.
- Need to send enable sequence on startup and disable on shutdown.
- Input parser needs a state machine or buffer to handle the escape sequences.
- Reference: https://en.wikipedia.org/wiki/Bracketed-paste
