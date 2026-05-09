# Spec 015 — CI/CD pipeline with quality gates

**Issue:** #15  
**Milestone:** M5 — Production Hardening  
**Owner:** Harry  
**Estimate:** 0.5d (AI-assisted)  
**Priority:** p1 — ensures PR quality before merge

## Context

Synax currently has no CI/CD. Tests run locally. There's no automated way to verify that a PR doesn't break existing behavior. Harry's domain is "good devops, metrics, logging, observability, telemetry" — this is where he adds the most value.

From the SOTA review on Codex: "Feature flags with lifecycle stages (dogfood/preview/release) — ship fast, don't break configs." The CI pipeline should gate on quality but not block iteration speed.

The pipeline should:
1. Run on every PR and push to main
2. Typecheck, lint, format check, test, build
3. Fail fast (typecheck first, then lint, then tests)
4. Post results as PR comments (or status checks)
5. Be defined as code (GitHub Actions workflow)

## Scope

**Creates:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`  
**Modifies:** `package.json` (verify scripts exist)  
**Does NOT:** add Docker builds, cross-platform testing, or automated releases

## Tasks

1. **Create `.github/workflows/ci.yml`:**
   ```yaml
   name: CI
   on: [push, pull_request]
   jobs:
     quality:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: '20' }
         - run: npm ci
         - run: npm run typecheck
         - run: npm run lint
         - run: npm run format:check
     test:
       needs: quality
       runs-on: ubuntu-latest
       strategy:
         matrix:
           node-version: ['18', '20', '22']
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: ${{ matrix.node-version }} }
         - run: npm ci
         - run: npm test
     build:
       needs: test
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: '20' }
         - run: npm ci
         - run: npm run build
         - run: npm run docs:build
   ```

2. **Create `.github/workflows/release.yml`** — manual trigger for publishing:
   - Build and test
   - Create GitHub Release with `synax-*.tgz` artifact
   - Generate SHASUMS256.txt

3. **Add PR template** (`.github/pull_request_template.md`):
   - Checklist: typecheck, lint, format, tests, build
   - Breaking changes? Y/N
   - Affected specs?

4. **Add CODEOWNERS** — Achu owns `src/session/`, `src/actions/`, `src/compaction/`, `src/memory/`; Harry owns `src/store/`, `src/telemetry/`, `.github/`

5. **Verify all scripts in package.json** — `typecheck`, `lint`, `format:check`, `test`, `build`, `docs:build` all work in CI

## Acceptance Criteria

- [ ] CI runs on every push and PR
- [ ] Typecheck, lint, format check run before tests
- [ ] Tests run on Node 18, 20, 22
- [ ] Build and docs:build run after tests pass
- [ ] Failed CI blocks PR merge (branch protection rule)
- [ ] Release workflow creates GitHub Release with artifact
- [ ] PR template and CODEOWNERS exist
- [ ] All CI steps pass on current `main`
