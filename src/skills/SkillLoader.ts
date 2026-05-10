/**
 * SkillLoader — auto-discovers SKILL.md files from filesystem directories.
 *
 * Scans:
 *   1. ~/.synax/skills/  — global skills (user-installed)
 *   2. .synax/skills/     — project-specific skills
 *
 * Each skill is a directory containing a SKILL.md file with optional
 * YAML frontmatter (name, description, enabled).
 *
 * Project skills override global skills by name.
 * Skills are injected as additional system messages.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import type { Skill, SkillDiscovery, SkillFrontmatter } from './types';

// ─── Constants ───────────────────────────────────────────────────────────────

const GLOBAL_SKILLS_DIR = join(homedir(), '.synax', 'skills');
const PROJECT_SKILLS_DIR_NAME = '.synax';
const SKILLS_SUBDIR = 'skills';
const SKILL_FILE = 'SKILL.md';

// ─── SkillLoader ─────────────────────────────────────────────────────────────

/**
 * Discover and load all skills from global and project directories.
 *
 * Resolution order:
 *   1. Load global skills from ~/.synax/skills/
 *   2. Load project skills from .synax/skills/
 *   3. Project skills override global skills by name
 *   4. Disabled skills are excluded
 */
export function discoverSkills(repoRoot: string): SkillDiscovery {
  const errors: string[] = [];

  // Load global skills
  const globalSkills = loadSkillsFromDirectory(GLOBAL_SKILLS_DIR, 'global', errors);

  // Load project skills
  const projectSkillsDir = join(repoRoot, PROJECT_SKILLS_DIR_NAME, SKILLS_SUBDIR);
  const projectSkills = loadSkillsFromDirectory(projectSkillsDir, 'project', errors);

  // Merge: project skills override global skills by name
  const merged = new Map<string, Skill>();
  for (const skill of globalSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of projectSkills) {
    merged.set(skill.name, skill);
  }

  const allSkills = Array.from(merged.values());
  const enabled = allSkills.filter((s) => s.enabled);
  const disabled = allSkills.filter((s) => !s.enabled);

  return {
    skills: allSkills,
    loaded: enabled,
    disabled,
    errors,
  };
}

/**
 * Load skills from a single directory.
 *
 * Scans for subdirectories containing SKILL.md files. Each subdirectory
 * is a skill. The skill name defaults to the directory name if not
 * specified in frontmatter.
 */
function loadSkillsFromDirectory(dir: string, source: 'global' | 'project', errors: string[]): Skill[] {
  if (!existsSync(dir)) return [];

  const skills: Skill[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    errors.push(`Cannot read skills directory: ${dir}`);
    return [];
  }

  for (const entry of entries) {
    const skillDir = join(dir, entry);
    let stat;
    try {
      stat = statSync(skillDir);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) continue;

    const skillFile = join(skillDir, SKILL_FILE);
    if (!existsSync(skillFile)) continue;

    const skill = loadSkillFile(skillFile, entry, source);
    if (skill) {
      skills.push(skill);
    }
  }

  return skills;
}

/**
 * Load a single SKILL.md file and parse its frontmatter.
 *
 * If no frontmatter name is provided, the directory name is used.
 */
function loadSkillFile(filePath: string, dirName: string, source: 'global' | 'project'): Skill | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter(content);

  return {
    name: frontmatter.name || dirName,
    description: frontmatter.description || `Skill: ${frontmatter.name || dirName}`,
    path: filePath,
    instructions: body.trim(),
    enabled: frontmatter.enabled !== false, // default true unless explicitly disabled
    source,
  };
}

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

/**
 * Parse YAML-like frontmatter from a markdown file.
 *
 * Frontmatter is delimited by --- on separate lines:
 * ```
 * ---
 * name: "Skill Name"
 * description: "Description"
 * enabled: true
 * ---
 * # Instructions
 * ...
 * ```
 *
 * This is a minimal parser — it handles the subset of YAML needed
 * for skill frontmatter (string keys/values, booleans). No external
 * dependency required.
 */
export function parseFrontmatter(content: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const lines = content.split(/\r?\n/);

  // Check if file starts with frontmatter delimiter
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { frontmatter: {}, body: content };
  }

  // Find closing delimiter
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    // No closing delimiter — treat entire file as body
    return { frontmatter: {}, body: content };
  }

  // Parse frontmatter lines
  const frontmatterLines = lines.slice(1, endIndex);
  const frontmatter = parseYamlLines(frontmatterLines);

  // Body is everything after the closing delimiter
  const body = lines.slice(endIndex + 1).join('\n');

  return { frontmatter, body };
}

/**
 * Parse a minimal subset of YAML key-value pairs.
 *
 * Supports:
 *   - key: "string value"
 *   - key: 'string value'
 *   - key: string value
 *   - key: true / false
 */
function parseYamlLines(lines: string[]): SkillFrontmatter {
  const result: SkillFrontmatter = {};

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    if (!key) continue;

    let value: string = line.slice(colonIdx + 1).trim();

    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Parse booleans
    if (value === 'true') {
      result[key] = true;
    } else if (value === 'false') {
      result[key] = false;
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      result[key] = Number.parseFloat(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

// ─── Skill message building ──────────────────────────────────────────────────

/**
 * Build system-level messages from discovered skills for injection
 * into the agent conversation.
 *
 * Each enabled skill becomes a system message with the format:
 * ```
 * --- BEGIN SKILL: <name> ---
 * Path: <path>
 *
 * <instructions>
 * --- END SKILL: <name> ---
 * ```
 */
export function buildSkillMessages(skills: Skill[]): string[] {
  return skills.map((skill) => {
    return [
      `--- BEGIN SKILL: ${skill.name} ---`,
      `Path: ${skill.path}`,
      `Source: ${skill.source}`,
      '',
      skill.instructions,
      `--- END SKILL: ${skill.name} ---`,
    ].join('\n');
  });
}
