# Spec 019 — Skills system: file-system-based skill discovery with injection

**Issue:** #19  
**Milestone:** M6 — Community Readiness  
**Owner:** Achu  
**Estimate:** 0.3d (AI-assisted)  
**Priority:** p1 — enables community contributions without code

## Context

Synax already has basic skill support via `skillMessages` in `AgentRunnerOptions`, but skills are loaded manually by the caller. Pi's architecture shows a better pattern: auto-discovered skills from the filesystem.

From the Pi deconstruction: "Skills as directory-based files. SKILL.md files with name, description, and instructions. Auto-discovered, injected into system prompt. Can be disabled per-project. Simple, file-system-based, no database."

Synax should scan:
1. `~/.synax/skills/` — global skills (user-installed)
2. `.synax/skills/` — project-specific skills
3. Each skill is a directory with `SKILL.md` containing:
   ```markdown
   ---
   name: "React Best Practices"
   description: "Guidance for React component patterns"
   enabled: true
   ---
   # Instructions
   - Use functional components with hooks
   - Prefer TypeScript interfaces over type aliases for props
   ...
   ```

Skills are injected as additional system messages, giving the model specialized knowledge without modifying the agent code. This is how the community extends Synax's capabilities — create a SKILL.md, drop it in the directory, done.

## Scope

**Creates:** `src/skills/SkillLoader.ts`, `src/skills/types.ts`  
**Modifies:** `src/session/Session.ts` (auto-load skills), `src/agent/skills.ts` (extend existing skill support)  
**Does NOT:** add a skill marketplace, remote skill fetching, or skill versioning

## Tasks

1. **Create `src/skills/types.ts`:**
   ```typescript
   interface Skill {
     name: string;
     description: string;
     path: string; // filesystem path to SKILL.md
     instructions: string; // markdown body
     enabled: boolean; // from frontmatter, default true
     source: 'global' | 'project';
   }
   ```

2. **Create `src/skills/SkillLoader.ts`:**
   - `loadGlobalSkills(): Skill[]` — scans `~/.synax/skills/` for `*/SKILL.md`
   - `loadProjectSkills(repoRoot: string): Skill[]` — scans `.synax/skills/` for `*/SKILL.md`
   - `resolveSkills(repoRoot: string): Skill[]` — merges global + project, project overrides global by name
   - Parses YAML frontmatter for `name`, `description`, `enabled`
   - Skips directories without SKILL.md

3. **Wire into Session:**
   - Session constructor calls `resolveSkills(repoRoot)`
   - Each enabled skill's instructions become a system message: `role: 'system', content: instructions`
   - Injected after the main system prompt, before user messages

4. **Extend `synax inspect`:**
   - `synax inspect --skills` — list discovered skills with source, enabled status, description
   - `synax inspect --skill <name>` — show full skill instructions

5. **Add `--no-skills` flag** to disable all skills for a run

6. **Create example skills:**
   - `~/.synax/skills/example-typescript/SKILL.md` — shipped with Synax as a template

## Acceptance Criteria

- [ ] `~/.synax/skills/*/SKILL.md` are auto-discovered and injected
- [ ] `.synax/skills/*/SKILL.md` are auto-discovered (project-specific)
- [ ] Project skills override global skills by name
- [ ] `enabled: false` in frontmatter excludes the skill
- [ ] `synax inspect --skills` lists all skills with metadata
- [ ] `--no-skills` disables all skill injection
- [ ] No skills = no injection (no empty system messages)
- [ ] Existing `skillMessages` API still works (manual injection for programmatic use)
- [ ] Existing tests pass
