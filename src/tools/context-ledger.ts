/**
 * Context ledger — tracks everything sent to the model for every call.
 *
 * This is the differentiator: without it, Synax is just another local
 * wrapper around Chat Completions. The ledger makes the context budget
 * transparent and auditable.
 *
 * Compact output is shown by default. Expanded output is available on demand.
 * Truncation is never silent — every truncation is recorded with location and reason.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextBudget {
  total: number;
  used: number;
  remaining: number;
  approximate: boolean;
}

export interface FileEntry {
  path: string;
  lineRange?: { start: number; end: number };
  included: boolean;
  summarized: boolean;
  truncated: boolean;
  omitted: boolean;
  approximateTokens?: number;
}

export interface CommandEntry {
  command: string;
  truncated: boolean;
  approximateTokens?: number;
}

export interface SummaryEntry {
  source: string;
  approximateTokens?: number;
}

export interface TruncationEntry {
  location: string;
  reason: string;
}

export interface OmissionEntry {
  location: string;
  reason: string;
}

export interface InstructionSourceEntry {
  name: string;
  included: boolean;
  summarized: boolean;
  truncated: boolean;
  omitted: boolean;
  approximateTokens?: number;
}

export interface ModelCallEntry {
  task: string | null;
  budget: ContextBudget;
  instructionSources: InstructionSourceEntry[];
  files: FileEntry[];
  commands: CommandEntry[];
  summaries: SummaryEntry[];
  truncations: TruncationEntry[];
  omissions: OmissionEntry[];
}

export interface ContextLedger {
  /** Set the user task description. */
  setTask(task: string): void;

  /** Set the context budget in tokens. */
  setBudget(total: number): void;

  /** Record an instruction source (e.g. system prompt, developer prompt). */
  recordInstructionSource(
    name: string,
    opts?: {
      included?: boolean;
      summarized?: boolean;
      truncated?: boolean;
      omitted?: boolean;
      approximateTokens?: number;
    },
  ): void;

  /** Record a file included in the model call context. */
  recordFile(
    path: string,
    opts?: {
      lineRange?: { start: number; end: number };
      included?: boolean;
      summarized?: boolean;
      truncated?: boolean;
      omitted?: boolean;
      approximateTokens?: number;
    },
  ): void;

  /** Record a command output included in the model call context. */
  recordCommand(command: string, opts?: { truncated?: boolean; approximateTokens?: number }): void;

  /** Record a summary included in the model call context. */
  recordSummary(source: string, opts?: { approximateTokens?: number }): void;

  /** Record a truncation — never silent. */
  recordTruncation(location: string, reason: string): void;

  /** Record an omission — something excluded from context. */
  recordOmission(location: string, reason: string): void;

  /** Record approximate token usage for the model call. */
  recordTokenUsage(used: number): void;

  /** Get the compact ledger string (default output). */
  getCompact(): string;

  /** Get the expanded ledger object for programmatic access. */
  getExpanded(): ModelCallEntry;

  /** Check if the ledger is within budget. */
  isSafe(): boolean;

  /** Reset the ledger for a new model call. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createContextLedger(): ContextLedger {
  let task: string | null = null;
  let budget: ContextBudget = { total: 0, used: 0, remaining: 0, approximate: true };
  const instructionSources: InstructionSourceEntry[] = [];
  const files: FileEntry[] = [];
  const commands: CommandEntry[] = [];
  const summaries: SummaryEntry[] = [];
  const truncations: TruncationEntry[] = [];
  const omissions: OmissionEntry[] = [];

  return {
    setTask(t: string): void {
      task = t;
    },

    setBudget(total: number): void {
      budget.total = total;
      budget.remaining = total;
    },

    recordInstructionSource(
      name: string,
      opts: {
        included?: boolean;
        summarized?: boolean;
        truncated?: boolean;
        omitted?: boolean;
        approximateTokens?: number;
      } = {},
    ): void {
      instructionSources.push({
        name,
        included: opts.included ?? true,
        summarized: opts.summarized ?? false,
        truncated: opts.truncated ?? false,
        omitted: opts.omitted ?? false,
        approximateTokens: opts.approximateTokens,
      });
    },

    recordFile(
      path: string,
      opts: {
        lineRange?: { start: number; end: number };
        included?: boolean;
        summarized?: boolean;
        truncated?: boolean;
        omitted?: boolean;
        approximateTokens?: number;
      } = {},
    ): void {
      files.push({
        path,
        lineRange: opts.lineRange,
        included: opts.included ?? true,
        summarized: opts.summarized ?? false,
        truncated: opts.truncated ?? false,
        omitted: opts.omitted ?? false,
        approximateTokens: opts.approximateTokens,
      });
    },

    recordCommand(command: string, opts: { truncated?: boolean; approximateTokens?: number } = {}): void {
      commands.push({
        command,
        truncated: opts.truncated ?? false,
        approximateTokens: opts.approximateTokens,
      });
    },

    recordSummary(source: string, opts: { approximateTokens?: number } = {}): void {
      summaries.push({
        source,
        approximateTokens: opts.approximateTokens,
      });
    },

    recordTruncation(location: string, reason: string): void {
      truncations.push({ location, reason });
    },

    recordOmission(location: string, reason: string): void {
      omissions.push({ location, reason });
    },

    recordTokenUsage(used: number): void {
      budget.used = used;
      budget.remaining = Math.max(0, budget.total - used);
    },

    getCompact(): string {
      const parts: string[] = [];

      // Task
      if (task) {
        const truncatedTask = task.length > 80 ? task.slice(0, 77) + '...' : task;
        parts.push(`task: "${truncatedTask}"`);
      }

      // Budget
      if (budget.total > 0) {
        const status =
          budget.remaining <= 0 ? '⚠️ over budget' : budget.remaining < budget.total * 0.2 ? '⚠️ low budget' : '✅ ok';
        parts.push(`budget: ${budget.used}/${budget.total} tokens (${budget.remaining} remaining) ${status}`);
      }

      // Instruction sources
      const includedSources = instructionSources.filter((s) => s.included && !s.omitted);
      const omittedSources = instructionSources.filter((s) => s.omitted);
      if (includedSources.length > 0) {
        const names = includedSources.map((s) => s.name).join(', ');
        parts.push(`instructions: [${names}]`);
      }
      if (omittedSources.length > 0) {
        const names = omittedSources.map((s) => s.name).join(', ');
        parts.push(`instructions omitted: [${names}]`);
      }

      // Files
      const includedFiles = files.filter((f) => f.included && !f.omitted);
      const omittedFiles = files.filter((f) => f.omitted);
      if (includedFiles.length > 0) {
        const fileInfos = includedFiles.map((f) => {
          const range = f.lineRange ? `:${f.lineRange.start}-${f.lineRange.end}` : '';
          const flags = [f.summarized ? 'summary' : null, f.truncated ? 'truncated' : null].filter(Boolean).join(',');
          const tokens = f.approximateTokens ? `~${f.approximateTokens}tok` : '';
          const tokenStr = tokens ? ` (${tokens})` : '';
          const flagStr = flags ? ` [${flags}]` : '';
          return `${f.path}${range}${tokenStr}${flagStr}`;
        });
        parts.push(`files: [${fileInfos.join(', ')}]`);
      }
      if (omittedFiles.length > 0) {
        const names = omittedFiles.map((f) => f.path).join(', ');
        parts.push(`files omitted: [${names}]`);
      }

      // Commands
      if (commands.length > 0) {
        const cmdInfos = commands.map((c) => {
          const truncated = c.truncated ? ' (truncated)' : '';
          const tokens = c.approximateTokens ? `~${c.approximateTokens}tok` : '';
          return `${c.command}${tokens}${truncated}`;
        });
        parts.push(`commands: [${cmdInfos.join(', ')}]`);
      }

      // Summaries
      if (summaries.length > 0) {
        const summaryInfos = summaries.map((s) => {
          const tokens = s.approximateTokens ? `~${s.approximateTokens}tok` : '';
          return `${s.source}${tokens}`;
        });
        parts.push(`summaries: [${summaryInfos.join(', ')}]`);
      }

      // Truncations (never silent)
      if (truncations.length > 0) {
        const truncInfos = truncations.map((t) => `[${t.location}] ${t.reason}`);
        parts.push(`truncations: [${truncInfos.join(', ')}]`);
      }

      // Omissions
      if (omissions.length > 0) {
        const omitInfos = omissions.map((o) => `[${o.location}] ${o.reason}`);
        parts.push(`omitted: [${omitInfos.join(', ')}]`);
      }

      return parts.join(' | ');
    },

    getExpanded(): ModelCallEntry {
      return {
        task,
        budget: { ...budget },
        instructionSources: [...instructionSources],
        files: [...files],
        commands: [...commands],
        summaries: [...summaries],
        truncations: [...truncations],
        omissions: [...omissions],
      };
    },

    isSafe(): boolean {
      if (budget.total <= 0) {
        return true;
      }
      return budget.remaining > 0;
    },

    reset(): void {
      task = null;
      budget = { total: 0, used: 0, remaining: 0, approximate: true };
      instructionSources.length = 0;
      files.length = 0;
      commands.length = 0;
      summaries.length = 0;
      truncations.length = 0;
      omissions.length = 0;
    },
  };
}
