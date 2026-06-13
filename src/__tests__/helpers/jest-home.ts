/**
 * Jest setup: redirect HOME to a per-run temp directory.
 *
 * Session metadata, event logs, and memory live under
 * ~/.local/share/synax/. Without this redirect, every test run floods the
 * developer's real session index with fake test sessions (model "fake",
 * tmp workspaces), evicting real sessions past the index cap and breaking
 * `/resume` (the "last" session becomes an empty test shell).
 *
 * Individual suites that need a custom HOME (e.g. chat.test.ts) may still
 * override and restore it; they inherit this temp dir as their baseline.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const testHome = mkdtempSync(join(tmpdir(), 'synax-jest-home-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
