/**
 * Skill resolution and loading.
 *
 * Maps configured skill entries to SKILL.md files, loads their content,
 * and produces diagnostics for missing or unresolvable skills.
 *
 * The Synax runtime owns skill resolution. The model must not be
 * responsible for discovering configured skills.
 *
 * Skill entries are filesystem paths. Supported forms:
 *   - Absolute: /home/user/skills/my-skill/SKILL.md
 *   - Home-prefixed: ~/skills/my-skill (resolved as dir, looks for SKILL.md inside)
 *   - Relative: ./project-skills/my-skill (resolved from project root)
 *   - Directory: path is a dir → appends /SKILL.md automatically
 */
import { existsSync, readFileSync, lstatSync } from 'fs';
import { resolve, join, sep } from 'path';
import { homedir } from 'os';
import type { ResolvedSkillsConfig } from '../config/schema';

export interface SkillDiagnostic {
  /** Configured skill entry (as written in .synax.toml) */
  id: string;
  /** The absolute path we resolved to */
  resolvedPath: string;
  /** Whether SKILL.md exists at the resolved path */
  exists: boolean;
  /** Whether the skill content was loaded and injected */
  loaded: boolean;
  /** Error or reason if not loaded */
  error?: string;
}

export interface SkillLoadResult {
  /** Loaded skill contents as system-level instruction strings */
  systemMessages: string[];
  /** Per-skill diagnostic information */
  diagnostics: SkillDiagnostic[];
}

/**
 * Resolve a configured skill path to an absolute SKILL.md path.
 *
 * Resolution:
 *   - Expand ~ with the user's home directory
 *   - If relative, resolve against projectRoot
 *   - If the resolved path is a directory, append /SKILL.md
 *
 * Returns null if the id is a bare name (no path separators) —
 * Synax does not maintain a hardcoded skill directory convention.
 */
export function resolveSkillPath(id: string, projectRoot: string): string | null {
  // Bare names (no path separators) are not resolvable without a
  // configured skill directory. Synax does not hardcode one.
  if (!id.includes('/') && !id.includes('\\')) {
    return null;
  }

  const home = homedir();

  // Normalize separators and expand ~
  let resolved = id.replace(/\\/g, sep);
  if (resolved.startsWith('~')) {
    resolved = join(home, resolved.slice(1));
  }

  // Make absolute
  if (resolved.startsWith('/') || (sep !== '/' && /^[A-Za-z]:\\/.test(resolved))) {
    resolved = resolve(resolved);
  } else {
    resolved = resolve(projectRoot, resolved);
  }

  // If the path is a directory, look for SKILL.md inside it
  try {
    if (existsSync(resolved)) {
      const stat = lstatSync(resolved);
      if (stat.isDirectory()) {
        return join(resolved, 'SKILL.md');
      }
    }
  } catch {
    // Path doesn't exist or is inaccessible — return as-is for diagnostics
  }

  return resolved;
}

/**
 * Load skill content from a SKILL.md file.
 * Returns the content or null if the file doesn't exist or can't be read.
 */
export function loadSkillContent(skillPath: string): string | null {
  try {
    if (!existsSync(skillPath)) return null;
    return readFileSync(skillPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Load and resolve all enabled skills from config.
 *
 * Produces system-level messages for each successfully loaded skill,
 * and diagnostics for every skill (including failures).
 */
export function loadSkills(skills: ResolvedSkillsConfig, projectRoot: string): SkillLoadResult {
  const systemMessages: string[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  for (const id of skills.enabled) {
    const resolvedPath = resolveSkillPath(id, projectRoot);
    const diagnostic: SkillDiagnostic = {
      id,
      resolvedPath: resolvedPath ?? '(unresolved)',
      exists: resolvedPath !== null && existsSync(resolvedPath),
      loaded: false,
    };

    if (resolvedPath === null) {
      diagnostic.error =
        `Bare skill name "${id}" cannot be resolved to a path. ` +
        'Use a path-based entry instead (absolute, ~/..., or ./relative). ' +
        'Example: enabled = ["~/.agents/skills/coderabbit-review"]';
      diagnostics.push(diagnostic);
      continue;
    }

    const content = loadSkillContent(resolvedPath);
    if (content === null) {
      diagnostic.error = `SKILL.md not found at resolved path: ${resolvedPath}`;
      diagnostics.push(diagnostic);
      continue;
    }

    diagnostic.loaded = true;

    // Build a system-level skill instruction message.
    const message = [
      `--- BEGIN SKILL: ${id} ---`,
      `Path: ${resolvedPath}`,
      '',
      content,
      `--- END SKILL: ${id} ---`,
    ].join('\n');

    systemMessages.push(message);
    diagnostics.push(diagnostic);
  }

  return { systemMessages, diagnostics };
}

/**
 * Format skill diagnostics for human-readable display (TUI, config output, etc).
 */
export function formatSkillDiagnostics(diagnostics: SkillDiagnostic[]): string {
  if (diagnostics.length === 0) return 'Skills: none configured';

  const loaded = diagnostics.filter((d) => d.loaded).length;
  const total = diagnostics.length;
  const lines = [`Skills      ${loaded}/${total} loaded`];

  for (const diag of diagnostics) {
    if (diag.loaded) {
      lines.push(`  ✓ ${diag.id}`);
    } else {
      lines.push(`  Missing     ${diag.id}`);
    }
    lines.push(`  Path        ${diag.resolvedPath}`);
  }

  return lines.join('\n');
}
