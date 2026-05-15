import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as toml from 'toml';

export interface ApprovalConfig {
  patterns: string[];
}

export function readApprovalConfig(cwd?: string): ApprovalConfig {
  const configPath = join(cwd ?? process.cwd(), '.synax.toml');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = toml.parse(raw) as Record<string, unknown>;
    const approvals = parsed.approvals as Record<string, unknown> | undefined;
    const auto = approvals?.auto as Record<string, unknown> | undefined;
    const patterns = auto?.patterns;
    return { patterns: Array.isArray(patterns) ? patterns.map(String) : [] };
  } catch {
    return { patterns: [] };
  }
}

export function isCommandAutoApproved(command: string, config?: ApprovalConfig): boolean {
  const cfg = config ?? readApprovalConfig();
  return cfg.patterns.some((pattern) => matchPattern(command, pattern));
}

export function writeApprovalRule(commandPattern: string, cwd?: string): void {
  const configPath = join(cwd ?? process.cwd(), '.synax.toml');
  let raw = '';
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    // File does not exist
  }

  const allPatterns = readApprovalPatterns(raw);
  if (allPatterns.includes(commandPattern)) return;
  allPatterns.push(commandPattern);
  allPatterns.sort();

  const newSection = `[approvals.auto]\npatterns = [${allPatterns.map((p) => `"${escapeToml(p)}"`).join(', ')}]\n`;

  const sectionRegex = /\[approvals\.auto\][\s\S]*?(?=\n\[|$)/i;
  if (sectionRegex.test(raw)) {
    raw = raw.replace(sectionRegex, newSection.trimEnd());
  } else {
    const separator = raw.length > 0 && !raw.endsWith('\n') ? '\n' : '';
    raw += separator + '\n' + newSection;
  }

  writeFileSync(configPath, raw, 'utf-8');
}

export function clearApprovalRules(cwd?: string): number {
  const configPath = join(cwd ?? process.cwd(), '.synax.toml');
  let raw = '';
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return 0;
  }
  if (!/\[approvals\.auto\]/i.test(raw)) return 0;

  const existing = readApprovalPatterns(raw);
  raw = raw.replace(/\[approvals\.auto\][\s\S]*?(?=\n\[|$)/i, '');
  writeFileSync(configPath, raw, 'utf-8');
  return existing.length;
}

export function formatApprovalPolicy(config?: ApprovalConfig): string {
  const cfg = config ?? readApprovalConfig();
  if (cfg.patterns.length === 0) return 'Approvals: ask all';
  return `Approvals: auto (${cfg.patterns.length} rule${cfg.patterns.length === 1 ? '' : 's'})`;
}

function readApprovalPatterns(raw: string): string[] {
  if (!raw.trim()) return [];
  try {
    const parsed = toml.parse(raw) as Record<string, unknown>;
    const approvals = parsed.approvals as Record<string, unknown> | undefined;
    if (!approvals) return [];
    const auto = approvals.auto as { patterns?: unknown[] } | undefined;
    if (!auto) return [];
    return Array.isArray(auto.patterns) ? auto.patterns.map(String) : [];
  } catch {
    return [];
  }
}

function escapeToml(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function matchPattern(command: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(`^${escaped}$`).test(command);
  } catch {
    return false;
  }
}
