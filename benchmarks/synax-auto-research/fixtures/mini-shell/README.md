# Synax Benchmark Fixture — mini-shell

A minimal C skeleton of a Unix shell with several missing features. Synax must
implement the shell from the skeleton so that all tests pass.

## Features to Implement

The skeleton already supports:
- Simple external commands via `fork`/`execvp`/`waitpid`
- The `exit` builtin

Synax must implement:
1. `cd <dir>` and `pwd` builtins
2. Quoted argument parsing (`"hello world"`, `'hello world'`)
3. Environment variable expansion (`$HOME`, `"$HOME"`)
4. Output redirection (`>`, `>>`)
5. Pipeline support (`|`)
6. Correct non-interactive exit status codes

## Constraints

- No `system()` — must use `fork`/`execvp`/`waitpid`
- No modifications to test files
- C only (no external libraries beyond POSIX)

## Files

```
src/
  main.c          REPL loop
  shell.c         Command execution, builtins, external commands
  shell.h         Shell API
  parser.c        Tokenization — quotes, env vars, redirection, pipes
  parser.h        Parser API
test/
  run-tests.sh    Test harness runner
  cases/          Individual test case scripts
```

## Manual Verification

```sh
# Build and test
make test

# Expected initially: 2 passed, 5 failed, 7 total
# Expected after full implementation: 7 passed, 0 failed, 7 total
```

## Implementation Hints

1. Read `src/parser.c` and `src/parser.h` — the tokenizer needs to handle
   quoted strings, `$VAR` expansion, `>` and `>>` redirection operators,
   and `|` pipeline separators.
2. Read `src/shell.c` and `src/shell.h` — add `cd` (chdir) and `pwd` (getcwd)
   builtins, wire redirection via `dup2`/`open`, wire pipelines via `pipe`/`dup2`.
3. Read `test/cases/*.sh` to understand what each test expects.
4. The parser's `Pipeline` and `Command` structs are designed to carry
   redirection targets and a command array for pipelines.
