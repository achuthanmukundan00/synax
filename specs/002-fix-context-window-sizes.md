# Spec 002: Fix Model Context Window Sizes

**GitHub Issue**: [#150](https://github.com/achuthanmukundan00/synax/issues/150)
**Labels**: bug, area:provider
**Priority**: p0

## Problem

Model context window sizes displayed in the providers menu are inaccurate. This likely affects other parts of the UI as well.

### Specific example

- **deepseek-v4-flash** is shown as having a **1M context window**, but its actual context window is different (likely 128k or similar).

## Expected Behavior

Context window sizes should reflect the actual model specifications accurately. If a model has a 128k context window, it should not display as 1M.

## Impact

- Users make decisions about which model to use based on context window size.
- Incorrect context window sizes lead to confusion and broken expectations.
- The error may propagate through the system if context window metadata is used for budget calculations or truncation logic.

## Suggested Fix

- Audit all model context window metadata in the provider configurations under `src/llm/`.
- Fix incorrect values for deepseek-v4-flash and any other models.
- Consider adding a mechanism to validate or source these values from authoritative provider docs.

## Implementation Notes

- Provider/model definitions likely live in `src/llm/` or `src/config/`.
- Context window sizes are probably hardcoded per model.
- Look for `contextWindow`, `maxTokens`, `context_size`, or similar fields.
