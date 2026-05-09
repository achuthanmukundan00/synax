# Spec 020 — Public docs, CONTRIBUTING.md, example extensions

**Issue:** #20  
**Milestone:** M6 — Community Readiness  
**Owner:** Harry  
**Estimate:** 0.5d (AI-assisted)  
**Priority:** p1 — gates open-source community adoption

## Context

Synax has a README and VitePress docs, but they describe the alpha. After M1-M5 restructuring, the architecture is different. The public surface needs documentation that reflects the new reality: Session, EventBus, Extension system, Holographic Memory, Handoff, Recovery Recipes.

Additionally, open source projects need a CONTRIBUTING.md, a clear "how to build and run from source" guide, and example extensions that show community members how to extend Synax.

Harry's domain: "Industry experience in good devops." This is a communication and documentation task — it's about making the project legible to contributors.

## Scope

**Creates:** `CONTRIBUTING.md`, `docs/guide/architecture.md`, `docs/guide/extensions.md`, `examples/hello-world-extension/`  
**Modifies:** `README.md`, `docs/.vitepress/config.ts` (update nav)  
**Does NOT:** rewrite all docs, add tutorials, or create video content

## Tasks

1. **Create `CONTRIBUTING.md`:**
   - Development setup: `git clone`, `npm ci`, `npm run build`, `npm test`
   - Project structure map (pointing to ENGINEERING-PLAN.md)
   - How to add a new action handler
   - How to add a new parser
   - How to add a new recovery recipe
   - PR checklist (reference CI gates from #15)
   - Code style: TypeScript strict, prettier, ESLint
   - Testing: Jest, test file naming, mock patterns
   - Issue labeling conventions

2. **Create `docs/guide/architecture.md`:**
   - High-level architecture diagram (ASCII art)
   - Module responsibilities (Session, EventBus, ActionExecutor, Compactor, HolographicMemory, HandoffManager, RecoveryRecipes)
   - Data flow: user input → Session → EventBus → ActionExecutor → tools → memory
   - Key design decisions and their research backing (link to SOTA review)
   - Extension points: EventBus subscribers, custom tools, custom parsers, custom recovery recipes

3. **Create `docs/guide/extensions.md`:**
   - How to subscribe to EventBus events
   - How to register a custom tool
   - How to add a custom compaction technique
   - How to create a custom recovery recipe
   - MCP bridge overview (guarded, tools export only)

4. **Create `examples/hello-world-extension/`:**
   - `SKILL.md` — a skill that teaches the agent to say "hello" in a pirate accent
   - `extension.ts` — a basic EventBus subscriber that logs every tool call
   - `README.md` — explanation of what this example demonstrates

5. **Update `README.md`:**
   - Reflect new architecture (not the alpha)
   - Quick start: `npx synax` or `npm install -g synax`
   - Feature highlights: adaptive context, holographic memory, recovery recipes, skills
   - Link to CONTRIBUTING.md, architecture docs, examples

6. **Update docs nav** — add Architecture and Extensions pages

## Acceptance Criteria

- [ ] `CONTRIBUTING.md` covers setup, project structure, extension points, and PR process
- [ ] Architecture doc has an ASCII diagram showing module relationships
- [ ] Extensions doc shows concrete code examples (not just interfaces)
- [ ] Hello-world example works: `synax run --skill examples/hello-world-extension`
- [ ] README accurately reflects M1-M5 architecture
- [ ] All docs links work (no 404s)
- [ ] `npm run docs:build` succeeds
- [ ] Docs are clear enough that a new contributor could add a tool without reading source code
