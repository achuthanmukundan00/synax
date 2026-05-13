# Synax Auto-Research Benchmark Fixture

A minimal JavaScript project with one missing feature: `validateEmail`.

## Task

Implement the `validateEmail` function in `src/validate-email.js` so all
tests in `test/validate-email.test.js` pass.

Synax is prompted to implement this missing function. The scorer then
runs the tests and evaluates the result.

## Manual verification

```sh
node test/validate-email.test.js
```

Expected: all tests fail initially (no `validateEmail` export).
After Synax implements it: all tests pass.
