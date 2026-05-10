#!/usr/bin/env node

/**
 * Shoggoth Observer — run script.
 *
 * Starts the observer server. For development, also starts the Vite dev server.
 * In production (after `npm run build`), the server serves the built dist/.
 *
 * Usage:
 *   npm run observer          # production mode (serve dist/)
 *   npm run dev               # development mode (Vite HMR + observer server)
 *   node run-observer.mjs     # direct
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "server", "observer-server.ts");
const rootDir = resolve(__dirname, "..", "..");

const isDev = process.argv.includes("--dev") || process.env.SHOGGOTH_DEV === "1";
const hasDist = existsSync(resolve(__dirname, "dist"));

if (isDev || !hasDist) {
  // Development mode: run Vite dev server + observer server
  console.log("[shoggoth-observer] starting in development mode");
  console.log("[shoggoth-observer] Vite dev server: http://127.0.0.1:5173");
  console.log("[shoggoth-observer] Observer server:  http://127.0.0.1:8559");

  // Start the observer server
  const observerProcess = spawn("npx", ["tsx", serverPath], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development" },
    cwd: rootDir,
  });

  // Start Vite dev server
  const viteProcess = spawn("npx", ["vite", "--host", "127.0.0.1"], {
    stdio: "inherit",
    env: { ...process.env },
    cwd: __dirname,
  });

  const cleanup = () => {
    observerProcess.kill("SIGINT");
    viteProcess.kill("SIGINT");
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  observerProcess.on("exit", (code) => {
    viteProcess.kill();
    process.exit(code ?? 0);
  });

  viteProcess.on("exit", (code) => {
    observerProcess.kill();
    process.exit(code ?? 0);
  });
} else {
  // Production mode: just the observer server (serves dist/)
  console.log("[shoggoth-observer] starting in production mode");
  console.log("[shoggoth-observer] serving from dist/");

  const child = spawn("npx", ["tsx", serverPath], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
    cwd: rootDir,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => {
    child.kill("SIGINT");
  });
}
