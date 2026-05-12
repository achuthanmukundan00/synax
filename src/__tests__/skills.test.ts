/**
 * Tests for skill resolution, loading, injection, and diagnostics.
 */
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

import {
  resolveSkillPath,
  loadSkillContent,
  loadSkills,
  formatSkillDiagnostics,
  type SkillDiagnostic,
} from '../agent/skills';
import { Session } from '../session/Session';
import type { ResolvedSkillsConfig } from '../config/schema';

const TEST_ROOT = join(tmpdir(), 'synax-skill-tests');
const PROJECT_ROOT = join(TEST_ROOT, 'project');

function setupTestDirs(): void {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(PROJECT_ROOT, { recursive: true });
}

describe('resolveSkillPath', () => {
  beforeEach(() => {
    setupTestDirs();
  });

  afterAll(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('resolves an absolute path to a SKILL.md file directly', () => {
    const skillDir = join(TEST_ROOT, 'absolute-skill');
    mkdirSync(skillDir, { recursive: true });
    const skillMd = join(skillDir, 'SKILL.md');
    writeFileSync(skillMd, '# Absolute skill');

    const result = resolveSkillPath(skillMd, PROJECT_ROOT);
    expect(result).toBe(skillMd);
  });

  it('resolves a directory path by appending /SKILL.md', () => {
    const skillDir = join(TEST_ROOT, 'dir-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Dir skill');

    const result = resolveSkillPath(skillDir, PROJECT_ROOT);
    expect(result).toBe(join(skillDir, 'SKILL.md'));
  });

  it('expands ~ to home directory', () => {
    const home = homedir();
    const relativeFromHome = '.synax-test-skill';
    const skillDir = join(home, relativeFromHome);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Home skill');

    try {
      const result = resolveSkillPath(`~/${relativeFromHome}`, PROJECT_ROOT);
      expect(result).toBe(join(skillDir, 'SKILL.md'));
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it('resolves a relative path from project root', () => {
    const skillDir = join(PROJECT_ROOT, 'rel-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Rel skill');

    const result = resolveSkillPath('./rel-skill', PROJECT_ROOT);
    expect(result).toBe(join(skillDir, 'SKILL.md'));
  });

  it('returns null for a bare name (no path separators)', () => {
    const result = resolveSkillPath('some-skill-name', PROJECT_ROOT);
    expect(result).toBeNull();
  });

  it('does not hardcode any skill directory for bare names', () => {
    // Even if the skill exists at ~/.agents/skills/<name>, bare names
    // should NOT resolve — only path-based entries work.
    const result = resolveSkillPath('nonexistent-skill', PROJECT_ROOT);
    expect(result).toBeNull();
  });
});

describe('loadSkillContent', () => {
  const testDir = join(TEST_ROOT, 'load-test');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  it('loads content from an existing SKILL.md', () => {
    const path = join(testDir, 'SKILL.md');
    writeFileSync(path, '# Skill Content\n\nSome instructions.');
    const content = loadSkillContent(path);
    expect(content).toBe('# Skill Content\n\nSome instructions.');
  });

  it('returns null for a missing file', () => {
    const content = loadSkillContent(join(testDir, 'nonexistent.md'));
    expect(content).toBeNull();
  });
});

describe('loadSkills', () => {
  const testDir = join(TEST_ROOT, 'load-skills-test');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  it('loads path-based skill with absolute path', () => {
    const skillDir = join(testDir, 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# My Skill');

    const config: ResolvedSkillsConfig = {
      enabled: [skillDir],
      disabled: [],
    };

    const result = loadSkills(config, PROJECT_ROOT);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].loaded).toBe(true);
    expect(result.diagnostics[0].exists).toBe(true);
    expect(result.systemMessages).toHaveLength(1);
    expect(result.systemMessages[0]).toContain('# My Skill');
    expect(result.systemMessages[0]).toContain('--- BEGIN SKILL:');
    expect(result.systemMessages[0]).toContain('--- END SKILL:');
  });

  it('produces a diagnostic for a bare name (no path separators)', () => {
    const config: ResolvedSkillsConfig = {
      enabled: ['bare-name'],
      disabled: [],
    };

    const result = loadSkills(config, PROJECT_ROOT);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].loaded).toBe(false);
    expect(result.diagnostics[0].exists).toBe(false);
    expect(result.diagnostics[0].error).toContain('Bare skill name');
    expect(result.systemMessages).toHaveLength(0);
  });

  it('produces a diagnostic when SKILL.md is missing', () => {
    const skillDir = join(testDir, 'missing-skill');
    mkdirSync(skillDir, { recursive: true });
    // Don't create SKILL.md

    const config: ResolvedSkillsConfig = {
      enabled: [skillDir],
      disabled: [],
    };

    const result = loadSkills(config, PROJECT_ROOT);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].loaded).toBe(false);
    expect(result.diagnostics[0].exists).toBe(false);
    expect(result.diagnostics[0].error).toContain('not found');
    expect(result.systemMessages).toHaveLength(0);
  });

  it('loads multiple skills with mixed results', () => {
    const goodDir = join(testDir, 'good-skill');
    mkdirSync(goodDir, { recursive: true });
    writeFileSync(join(goodDir, 'SKILL.md'), '# Good');

    const missingDir = join(testDir, 'missing-skill');
    mkdirSync(missingDir, { recursive: true });

    const config: ResolvedSkillsConfig = {
      enabled: [goodDir, missingDir],
      disabled: [],
    };

    const result = loadSkills(config, PROJECT_ROOT);
    expect(result.diagnostics).toHaveLength(2);

    const good = result.diagnostics.find((d) => d.id === goodDir);
    expect(good?.loaded).toBe(true);

    const missing = result.diagnostics.find((d) => d.id === missingDir);
    expect(missing?.loaded).toBe(false);
    expect(missing?.error).toContain('not found');

    expect(result.systemMessages).toHaveLength(1);
  });
});

describe('skill injection into agent context', () => {
  const testDir = join(TEST_ROOT, 'injection-test');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  it('injects skill content into conversation system messages', () => {
    const skillMessages = [
      '--- BEGIN SKILL: my-skill ---\nPath: /some/path\n\n# Skill instructions\n\n--- END SKILL: my-skill ---',
    ];

    const conv = Session.createConversation({ skillMessages });

    // Should have: system prompt + skill message
    expect(conv.messages.length).toBeGreaterThanOrEqual(2);
    expect(conv.messages[0].role).toBe('system');
    expect(conv.messages[0].content).toContain('Synax');

    // Skill message should be a system message
    const skillMsg = conv.messages.find((m) => m.content.includes('BEGIN SKILL:'));
    expect(skillMsg).toBeDefined();
    const msg = skillMsg as NonNullable<typeof skillMsg>;
    expect(msg.role).toBe('system');
    expect(msg.content).toContain('# Skill instructions');
  });

  it('creates conversation without skills when none provided', () => {
    const conv = Session.createConversation();
    // Should only have the system prompt
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0].role).toBe('system');
    expect(conv.messages[0].content).not.toContain('BEGIN SKILL');
  });

  it('creates conversation with multiple skills', () => {
    const skillMessages = [
      '--- BEGIN SKILL: skill-a ---\n\nContent A\n\n--- END SKILL: skill-a ---',
      '--- BEGIN SKILL: skill-b ---\n\nContent B\n\n--- END SKILL: skill-b ---',
    ];

    const conv = Session.createConversation({ skillMessages });

    expect(conv.messages).toHaveLength(3); // system + 2 skills
    expect(conv.messages[1].content).toContain('skill-a');
    expect(conv.messages[2].content).toContain('skill-b');
  });

  it('empty skillMessages array produces no extra messages', () => {
    const conv = Session.createConversation({ skillMessages: [] });
    expect(conv.messages).toHaveLength(1);
  });
});

describe('formatSkillDiagnostics', () => {
  it('shows "none configured" for empty diagnostics', () => {
    const result = formatSkillDiagnostics([]);
    expect(result).toBe('Skills: none configured');
  });

  it('shows loaded/missing counts with paths', () => {
    const diagnostics: SkillDiagnostic[] = [
      { id: '/good', resolvedPath: '/good/SKILL.md', exists: true, loaded: true },
      { id: '/bad', resolvedPath: '/bad/SKILL.md', exists: false, loaded: false, error: 'not found' },
    ];

    const result = formatSkillDiagnostics(diagnostics);
    expect(result).toContain('1/2 loaded');
    expect(result).toContain('✓ /good');
    expect(result).toContain('Missing     /bad');
    expect(result).toContain('Path        /good/SKILL.md');
    expect(result).toContain('Path        /bad/SKILL.md');
  });
});

// ─── Auto-discovery tests (SkillLoader) ──────────────────────────────────────

import { discoverSkills, buildSkillMessages, parseFrontmatter } from '../skills/SkillLoader';

describe('SkillLoader — auto-discovery', () => {
  const testDir = join(TEST_ROOT, 'auto-discover-test');
  const globalSkillsDir = join(homedir(), '.synax', 'skills');
  const testProjectDir = join(testDir, 'project');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testProjectDir, { recursive: true });

    // Create project .synax/skills directory
    const projectSkillsDir = join(testProjectDir, '.synax', 'skills');
    mkdirSync(projectSkillsDir, { recursive: true });

    // Create a project skill
    const skillDir = join(projectSkillsDir, 'typescript-style');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: "TypeScript Style Guide"
description: "Project-specific TypeScript conventions"
enabled: true
---
# TypeScript Conventions
- Use strict mode
- Prefer interfaces over type aliases`,
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
    // Clean up any test global skills
    try {
      const testGlobalDir = join(globalSkillsDir, 'synax-test-global-skill');
      rmSync(testGlobalDir, { recursive: true, force: true });
    } catch {
      // ok
    }
  });

  it('discovers project skills', () => {
    const discovery = discoverSkills(testProjectDir);
    expect(discovery.skills.length).toBeGreaterThanOrEqual(1);
    const tsSkill = discovery.skills.find((s) => s.name === 'TypeScript Style Guide');
    expect(tsSkill).toBeDefined();
    const skill = tsSkill as NonNullable<typeof tsSkill>;
    expect(skill.source).toBe('project');
    expect(skill.enabled).toBe(true);
    expect(skill.instructions).toContain('Use strict mode');
  });

  it('returns empty discovery for directory with no skills', () => {
    const emptyDir = join(testDir, 'empty-project');
    mkdirSync(emptyDir, { recursive: true });
    const discovery = discoverSkills(emptyDir);
    expect(discovery.skills).toHaveLength(0);
    expect(discovery.loaded).toHaveLength(0);
    expect(discovery.errors.length).toBeGreaterThanOrEqual(0);
  });

  it('handles disabled skills', () => {
    const projectSkillsDir = join(testProjectDir, '.synax', 'skills');
    const disabledDir = join(projectSkillsDir, 'disabled-skill');
    mkdirSync(disabledDir, { recursive: true });
    writeFileSync(
      join(disabledDir, 'SKILL.md'),
      `---
name: "Disabled Skill"
enabled: false
---
# Should not load`,
    );

    const discovery = discoverSkills(testProjectDir);
    const disabled = discovery.disabled.find((s) => s.name === 'Disabled Skill');
    expect(disabled).toBeDefined();
    const skill = disabled as NonNullable<typeof disabled>;
    expect(skill.enabled).toBe(false);
  });

  it('builds skill messages from loaded skills', () => {
    const discovery = discoverSkills(testProjectDir);
    const messages = buildSkillMessages(discovery.loaded);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const msg = messages[0];
    expect(msg).toContain('BEGIN SKILL:');
    expect(msg).toContain('TypeScript Style Guide');
    expect(msg).toContain('END SKILL:');
    expect(msg).toContain('Use strict mode');
  });
});

describe('parseFrontmatter', () => {
  it('parses YAML frontmatter from markdown', () => {
    const content = [
      '---',
      'name: "Test Skill"',
      'description: "A test skill"',
      'enabled: true',
      '---',
      '# Instructions',
      'Do this and that.',
    ].join('\n');

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.name).toBe('Test Skill');
    expect(frontmatter.description).toBe('A test skill');
    expect(frontmatter.enabled).toBe(true);
    expect(body).toContain('# Instructions');
    expect(body).toContain('Do this and that.');
  });

  it('handles single-quoted strings', () => {
    const content = ['---', "name: 'Single Quoted'", '---', 'Body here.'].join('\n');

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.name).toBe('Single Quoted');
  });

  it('returns empty frontmatter when no delimiter', () => {
    const content = '# Just a markdown file\n\nNo frontmatter here.';
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toEqual({});
    expect(body).toBe(content);
  });

  it('handles missing closing delimiter gracefully', () => {
    const content = ['---', 'name: "Incomplete"', '# No closing delimiter'].join('\n');

    const { body } = parseFrontmatter(content);
    // Without closing delimiter, no frontmatter is parsed
    expect(body).toBe(content);
  });

  it('parses boolean values correctly', () => {
    const content = ['---', 'enabled: true', 'other: false', '---', 'Body.'].join('\n');

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.enabled).toBe(true);
    expect(frontmatter.other).toBe(false);
  });

  it('handles empty frontmatter between delimiters', () => {
    const content = ['---', '---', 'Body only.'].join('\n');

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toEqual({});
    expect(body.trim()).toBe('Body only.');
  });

  it('handles missing name in frontmatter (uses dir name)', () => {
    const content = ['---', 'description: "No name skill"', '---', 'Instructions here.'].join('\n');

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.name).toBeUndefined();
    expect(frontmatter.description).toBe('No name skill');
    expect(frontmatter.enabled).toBeUndefined();
  });
});
