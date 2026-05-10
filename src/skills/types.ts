/**
 * Skills types — file-system-based skill discovery with YAML frontmatter.
 *
 * Skills are markdown files with optional YAML frontmatter containing
 * metadata (name, description, enabled). They are auto-discovered from
 * ~/.synax/skills/ and .synax/skills/ directories.
 */

// ─── Skill definition ────────────────────────────────────────────────────────

export interface Skill {
  /** Skill name (from frontmatter or directory name). */
  name: string;
  /** Human-readable description (from frontmatter). */
  description: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** The markdown body (instructions for the model). */
  instructions: string;
  /** Whether this skill is enabled (from frontmatter, default true). */
  enabled: boolean;
  /** Where the skill was discovered from. */
  source: 'global' | 'project';
}

// ─── Skill discovery ─────────────────────────────────────────────────────────

export interface SkillDiscovery {
  /** All discovered skills (enabled + disabled). */
  skills: Skill[];
  /** Skills that are loaded and injected. */
  loaded: Skill[];
  /** Skills that were found but disabled. */
  disabled: Skill[];
  /** Any errors encountered during discovery. */
  errors: string[];
}

// ─── YAML frontmatter (minimal) ──────────────────────────────────────────────

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  enabled?: boolean;
  [key: string]: unknown;
}
