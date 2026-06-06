/**
 * Lazy loader for better-sqlite3 — a native C++ addon.
 *
 * better-sqlite3 ships prebuilds for common platforms (macOS, Linux, Windows
 * on x64/arm64). On unusual platforms it falls back to node-gyp compilation.
 *
 * If compilation fails or better-sqlite3 is unavailable, Synax continues
 * without SQLite persistence (memory, event store, FTS5 are no-ops).
 *
 * Uses a synchronous dynamic require() inside try/catch so that the
 * rest of the module graph loads fine regardless.
 */

import type Database from 'better-sqlite3';

let _Database: typeof Database | null | undefined;

/**
 * Synchronously load better-sqlite3.
 *
 * Uses a cached dynamic require() — tried exactly once per process.
 * Returns the Database constructor on success, null on failure.
 */
export function loadBetterSqlite3(): typeof Database | null {
  if (_Database !== undefined) return _Database;

  // better-sqlite3 is a native C++ addon. Bun does not support native
  // addons, so return null early to let callers fall back gracefully.
  if (typeof (globalThis as Record<string, unknown>).Bun !== 'undefined' ||
      typeof (process.versions as Record<string, string>).bun !== 'undefined') {
    _Database = null;
    return null;
  }

  try {
    // Dynamic require — caught at runtime, doesn't block module loading
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('better-sqlite3') as typeof Database;
    _Database = mod;
    return _Database;
  } catch {
    _Database = null;
    return null;
  }
}

/**
 * Re-export the Database type for use in type annotations.
 * This is a type-only re-export — it doesn't trigger a runtime import.
 */
export type { Database };
