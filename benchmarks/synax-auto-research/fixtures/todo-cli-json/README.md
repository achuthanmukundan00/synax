# Synax Benchmark Fixture — Todo CLI JSON

A tiny CLI task tracker with one missing feature: JSON output.

## Task

Add `--json` flag support to the `todo list` command. The text output
(`todo list`) must continue to work unchanged. The JSON output
(`todo list --json`) must produce valid, parseable JSON.

## Files

```
src/
  cli.js          CLI entrypoint — parses args, calls TodoList
  todo.js         Core module — TodoList class with formatList()
  storage.js      File-based persistence (data/todos.json)
test/
  todo.test.js    Tests for both text and JSON output
```

## Manual Verification

```sh
# Initially: text output works, JSON tests fail
node test/todo.test.js
# Expected: 3 passed, 7 failed, 10 total

# After implementing formatList({ json: true }):
node test/todo.test.js
# Expected: 10 passed, 0 failed, 10 total
```

## Implementation Hints

1. Inspect `src/todo.js` — look for the `formatList()` method and the
   placeholder comment for JSON output.
2. Inspect `src/cli.js` — see how `--json` is detected and passed to
   `formatList()`.
3. Inspect `test/todo.test.js` — understand what the tests expect.
4. Implement the JSON branch in `formatList()`.
