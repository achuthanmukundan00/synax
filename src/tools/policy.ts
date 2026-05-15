import { extname, isAbsolute, normalize, relative, resolve, sep } from 'path';

const BLOCKED_SEGMENTS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.cache', '.vite']);
const BLOCKED_BASENAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']);
const BLOCKED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.woff',
  '.woff2',
  '.ttf',
]);

export interface PathPolicyResult {
  ok: boolean;
  path?: string;
  absolutePath?: string;
  reason?: string;
}

export function normalizeRepoPath(repoRoot: string, inputPath: string): PathPolicyResult {
  if (!inputPath || inputPath.trim().length === 0) {
    return { ok: false, reason: 'path is required' };
  }

  if (isAbsolute(inputPath)) {
    return { ok: false, reason: 'absolute paths are not allowed' };
  }

  const normalized = normalize(inputPath).replace(/\\/g, '/');
  if (normalized === '..' || normalized.startsWith('../')) {
    return { ok: false, reason: 'paths must stay inside the repository' };
  }

  const segments = normalized.split('/').filter(Boolean);
  const basename = segments[segments.length - 1] ?? '';
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment)) || BLOCKED_BASENAMES.has(basename)) {
    return { ok: false, reason: `unsafe path rejected: ${normalized}` };
  }

  if (BLOCKED_EXTENSIONS.has(extname(basename).toLowerCase())) {
    return { ok: false, reason: `unsafe path rejected: ${normalized}` };
  }

  const absolutePath = resolve(repoRoot, normalized);
  const relativePath = relative(repoRoot, absolutePath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return { ok: false, reason: 'paths must stay inside the repository' };
  }

  return { ok: true, path: normalized === '.' ? '' : normalized, absolutePath };
}

export function isSafeRepoPath(repoRoot: string, inputPath: string): boolean {
  return normalizeRepoPath(repoRoot, inputPath).ok;
}
