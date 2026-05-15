import { execFile } from 'node:child_process';

export interface CheckpointInfo {
  index: number;
  title: string;
  hash: string;
}

export async function gitCreateCheckpoint(title: string): Promise<{ hash: string } | null> {
  try {
    const hash = await execGit('stash', ['push', '-m', `synax-checkpoint: ${title}`]);
    if (!hash) return null;
    // Extract hash from "Saved working directory and index state WIP on ...: <hash>"
    const match = /: ([a-f0-9]{7,40})/.exec(hash);
    return { hash: match?.[1] ?? 'unknown' };
  } catch {
    return null;
  }
}

export async function gitRestoreCheckpoint(indexOrHash: string): Promise<boolean> {
  try {
    // If it looks like a hash, try stash apply by index
    const list = await gitListCheckpoints();
    const entry = list.find((c) => c.hash.startsWith(indexOrHash) || String(c.index) === indexOrHash);
    if (entry) {
      await execGit('stash', ['apply', `stash@{${entry.index}}`]);
      return true;
    }
    // Fallback: try as a tag
    await execGit('checkout', [indexOrHash]);
    return true;
  } catch {
    return false;
  }
}

export async function gitListCheckpoints(): Promise<CheckpointInfo[]> {
  try {
    const raw = await execGit('stash', ['list']);
    if (!raw) return [];
    const lines = raw.trim().split('\n').filter(Boolean);
    const results: CheckpointInfo[] = [];
    for (const line of lines) {
      const match = /^stash@\{(\d+)\}:\s+.*: ([a-f0-9]{7,40}) .*synax-checkpoint:\s*(.+)$/i.exec(line);
      if (match) {
        results.push({
          index: Number(match[1]),
          hash: match[2] ?? 'unknown',
          title: (match[3] ?? '').trim(),
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

export async function gitDropCheckpoint(index: number): Promise<boolean> {
  try {
    await execGit('stash', ['drop', `stash@{${index}}`]);
    return true;
  } catch {
    return false;
  }
}

function execGit(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [cmd, ...args], { cwd: process.cwd(), timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}
