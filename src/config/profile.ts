/**
 * Project profile detection.
 *
 * Reads git metadata, package manager info, detected commands,
 * and instruction files from the repository root.
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface GitProfile {
  root: string;
  branch: string;
  isDirty: boolean;
}

export interface PackageManager {
  name: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  lockfile: string | null;
  hasScripts: boolean;
}

export interface ProjectProfile {
  git: GitProfile | null;
  packageManager: PackageManager;
  detectedCommands: Record<string, string>;
  instructionFiles: string[];
}

export interface ConfigProfile {
  source: 'default' | 'file' | 'explicit';
  hasConfigFile: boolean;
  configSummary?: Record<string, unknown>;
}

export interface FullProfile {
  project: ProjectProfile;
  config: ConfigProfile;
}

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.clinerules', 'README.md', '.synax.md'];

/**
 * Detect git profile by running git commands.
 * Returns null if not inside a git repository.
 */
export function detectGitProfile(baseDir?: string): GitProfile | null {
  const dir = baseDir ?? process.cwd();
  let gitRoot: string;
  let branch: string;
  let isDirty: boolean;

  try {
    gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }

  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    branch = 'unknown';
  }

  try {
    const statusOutput = execSync('git status --porcelain', {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    isDirty = statusOutput.length > 0;
  } catch {
    isDirty = false;
  }

  return { root: gitRoot, branch, isDirty };
}

/**
 * Detect package manager from lockfile presence and package.json.
 */
export function detectPackageManager(gitRoot: string): PackageManager {
  const lockfiles: Record<string, PackageManager['name']> = {
    'package-lock.json': 'npm',
    'pnpm-lock.yaml': 'pnpm',
    'yarn.lock': 'yarn',
    'bun.lock': 'bun',
    'bun.lockb': 'bun',
  };

  let name: PackageManager['name'] = 'unknown';
  let lockfile: string | null = null;

  for (const [lockName, manager] of Object.entries(lockfiles)) {
    if (existsSync(join(gitRoot, lockName))) {
      name = manager;
      lockfile = lockName;
      break;
    }
  }

  // Check package.json for scripts
  let hasScripts = false;
  const pkgPath = join(gitRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      hasScripts = Boolean(pkg.scripts && typeof pkg.scripts === 'object' && Object.keys(pkg.scripts).length > 0);
    } catch {
      // ignore parse errors
    }
  }

  return { name, lockfile, hasScripts };
}

/**
 * Extract detected commands from package.json scripts.
 */
export function detectCommands(gitRoot: string): Record<string, string> {
  const commands: Record<string, string> = {};
  const pkgPath = join(gitRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    return commands;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      for (const [key, value] of Object.entries(pkg.scripts)) {
        if (typeof value === 'string') {
          commands[key] = value;
        }
      }
    }
  } catch {
    // ignore parse errors
  }
  return commands;
}

/**
 * Detect which instruction files exist in the repository root.
 */
export function detectInstructionFiles(gitRoot: string): string[] {
  const found: string[] = [];
  for (const file of INSTRUCTION_FILES) {
    if (existsSync(join(gitRoot, file))) {
      found.push(file);
    }
  }
  return found;
}

/**
 * Build the full project profile.
 * Returns a profile with git=null if not inside a git repository.
 * When git is null, package manager, commands, and instruction files
 * are still detected from the provided baseDir (or cwd).
 */
export function buildProjectProfile(baseDir?: string): ProjectProfile {
  const git = detectGitProfile(baseDir);

  if (!git) {
    return {
      git: null,
      packageManager: { name: 'unknown', lockfile: null, hasScripts: false },
      detectedCommands: {},
      instructionFiles: [],
    };
  }

  const pm = detectPackageManager(git.root);
  const commands = detectCommands(git.root);
  const instructionFiles = detectInstructionFiles(git.root);

  return { git, packageManager: pm, detectedCommands: commands, instructionFiles };
}

/**
 * Format a text profile string for display.
 */
export function formatTextProfile(profile: FullProfile): string {
  const lines: string[] = [];
  lines.push('Synax Project Profile');
  lines.push('='.repeat(20));

  // Git info
  if (profile.project.git) {
    lines.push(`\nGit:`);
    lines.push(`  Root: ${profile.project.git.root}`);
    lines.push(`  Branch: ${profile.project.git.branch}`);
    lines.push(`  Dirty: ${profile.project.git.isDirty ? 'yes' : 'no'}`);
  } else {
    lines.push('\nGit: not inside a repository');
  }

  // Package manager
  lines.push(`\nPackage manager:`);
  lines.push(`  Type: ${profile.project.packageManager.name}`);
  if (profile.project.packageManager.lockfile) {
    lines.push(`  Lockfile: ${profile.project.packageManager.lockfile}`);
  }
  lines.push(`  Has scripts: ${profile.project.packageManager.hasScripts ? 'yes' : 'no'}`);

  // Detected commands
  if (Object.keys(profile.project.detectedCommands).length > 0) {
    lines.push('\nDetected commands:');
    for (const [key, value] of Object.entries(profile.project.detectedCommands)) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  // Instruction files
  if (profile.project.instructionFiles.length > 0) {
    lines.push('\nInstruction files:');
    for (const file of profile.project.instructionFiles) {
      lines.push(`  ${file}`);
    }
  }

  // Config summary
  if (profile.config.configSummary) {
    lines.push('\nConfig:');
    lines.push(`  Source: ${profile.config.source}`);
    for (const [key, value] of Object.entries(profile.config.configSummary)) {
      lines.push(`  ${key}: ${JSON.stringify(value)}`);
    }
  } else {
    lines.push(`\nConfig: ${profile.config.source} (no file)`);
  }

  return lines.join('\n');
}
