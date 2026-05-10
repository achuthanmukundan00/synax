#!/usr/bin/env node

/**
 * Shoggoth Observer — run script.
 *
 * Starts the observer server. Synax chat sessions with observer mode
 * enabled will push events to it.
 *
 * Usage:
 *   npm run observer
 *   # or directly:
 *   node experiments/web-shoggoth-observer/run-observer.mjs
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, 'server', 'observer-server.ts');

// Use tsx to run TypeScript directly
const child = spawn('npx', ['tsx', serverPath], {
  stdio: 'inherit',
  env: { ...process.env },
  cwd: resolve(__dirname, '..', '..'),
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  child.kill('SIGINT');
});
