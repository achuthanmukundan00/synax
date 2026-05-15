/**
 * Central slash-command registry.
 *
 * All slash commands are registered here. The TUI autocomplete reads
 * this registry to filter and display commands. Commands are dispatched
 * through the chat session's handleSlashCommand.
 */

// ─── Types ──────────────────────────────────────────────────

export type SlashCommandCategory = 'settings' | 'session' | 'runtime' | 'debug' | 'navigation';

export type SlashCommandHandler = (args?: string) => Promise<SlashCommandResult> | SlashCommandResult;

export interface SlashCommand {
  /** Command name without leading slash, e.g. "settings" */
  name: string;
  /** Short description for autocomplete display */
  description: string;
  /** Alternative names */
  aliases?: string[];
  /** Category for grouping */
  category?: SlashCommandCategory;
  /** Handler — called when the command is selected */
  handler: SlashCommandHandler;
  /** If true, opens the settings menu rather than dispatching inline */
  opensSettings?: boolean;
  /** If true, opens the resume picker */
  opensResume?: boolean;
}

export interface SlashCommandResult {
  handled: boolean;
  exit?: boolean;
  output?: string;
  newSession?: boolean;
  /** For commands that open a modal / settings menu */
  openSettings?: boolean;
  /** For /resume */
  openResume?: boolean;
}

// ─── Registry ───────────────────────────────────────────────

const registry = new Map<string, SlashCommand>();

export function registerCommand(command: SlashCommand): void {
  registry.set(command.name, command);
  if (command.aliases) {
    for (const alias of command.aliases) {
      registry.set(alias, command);
    }
  }
}

export function getCommand(name: string): SlashCommand | undefined {
  return registry.get(name);
}

export function getAllCommands(): SlashCommand[] {
  const seen = new Set<string>();
  const commands: SlashCommand[] = [];
  for (const cmd of registry.values()) {
    if (!seen.has(cmd.name)) {
      seen.add(cmd.name);
      commands.push(cmd);
    }
  }
  return commands;
}

export function filterCommands(query: string): SlashCommand[] {
  if (!query) return getAllCommands();
  const lower = query.toLowerCase();
  return getAllCommands().filter(
    (cmd) =>
      cmd.name.toLowerCase().includes(lower) ||
      cmd.description.toLowerCase().includes(lower) ||
      cmd.aliases?.some((a) => a.toLowerCase().includes(lower)),
  );
}

// ─── Built-in commands ──────────────────────────────────────

export function registerBuiltinCommands(): void {
  const commands: SlashCommand[] = [
    {
      name: 'settings',
      description: 'Open settings menu',
      category: 'settings',
      handler: () => ({ handled: true, openSettings: true }),
      opensSettings: true,
    },
    {
      name: 'model',
      description: 'Select model',
      category: 'settings',
      aliases: ['models'],
      handler: () => ({ handled: true, openSettings: true }),
      opensSettings: true,
    },
    {
      name: 'providers',
      description: 'Configure providers',
      category: 'settings',
      handler: () => ({ handled: true, openSettings: true }),
      opensSettings: true,
    },
    {
      name: 'skills',
      description: 'View or toggle installed skills',
      category: 'settings',
      handler: () => ({ handled: true, openSettings: true }),
      opensSettings: true,
    },
    {
      name: 'mcp',
      description: 'View or toggle configured MCP servers',
      category: 'settings',
      handler: () => ({ handled: true, openSettings: true }),
      opensSettings: true,
    },
    {
      name: 'resume',
      description: 'Resume previous session',
      category: 'session',
      handler: () => ({ handled: true, openResume: true }),
      opensResume: true,
    },
    {
      name: 'login',
      description: 'Add/configure providers',
      category: 'settings',
      handler: () => ({ handled: true, openSettings: true }),
      opensSettings: true,
    },
    {
      name: 'export',
      description: 'Export session',
      category: 'session',
      handler: () => ({ handled: true, output: '[synax] session export is not yet implemented' }),
    },
    {
      name: 'import',
      description: 'Import/resume session',
      category: 'session',
      handler: () => ({ handled: true, openResume: true }),
      opensResume: true,
    },
    {
      name: 'status',
      description: 'Show runtime status',
      category: 'runtime',
      handler: () => ({ handled: false, output: '[synax] use /inspect for full status' }),
    },
    {
      name: 'help',
      description: 'Show help',
      category: 'navigation',
      handler: () => ({ handled: false }), // pass through to session for inline help
    },
    {
      name: 'exit',
      description: 'Exit Synax',
      category: 'navigation',
      aliases: ['quit'],
      handler: () => ({ handled: true, exit: true, output: '[synax] bye' }),
    },
    {
      name: 'clear',
      description: 'Clear conversation',
      category: 'session',
      handler: () => ({ handled: true, newSession: true, output: '[synax] conversation cleared' }),
    },
    {
      name: 'new',
      description: 'Start a fresh session',
      category: 'session',
      handler: () => ({ handled: true, newSession: true, output: '[synax] new session started' }),
    },
    {
      name: 'tools',
      description: 'Show model-facing tools',
      category: 'debug',
      handler: () => ({ handled: false }),
    },
    {
      name: 'budget',
      description: 'Show context budget',
      category: 'debug',
      handler: () => ({ handled: false }),
    },
    {
      name: 'test-provider',
      description: 'Probe provider connection',
      category: 'debug',
      handler: () => ({ handled: false }),
    },
    {
      name: 'inspect',
      description: 'Show project profile',
      category: 'debug',
      handler: () => ({ handled: false }),
    },
    {
      name: 'diff',
      description: 'Show bounded git diff',
      category: 'debug',
      handler: () => ({ handled: false }),
    },
    {
      name: 'undo-last-edit',
      description: 'Revert last Synax edit',
      category: 'debug',
      handler: () => ({ handled: false }),
    },
    {
      name: 'verify',
      description: 'Run verification command',
      category: 'debug',
      handler: () => ({ handled: false }),
    },
    {
      name: 'theme',
      description: 'Switch TUI theme',
      category: 'settings',
      handler: () => ({ handled: false }),
    },
    {
      name: 'checkpoint',
      description: 'Create a manual checkpoint',
      category: 'session',
      handler: () => ({ handled: false }),
    },
    {
      name: 'checkpoints',
      description: 'List recent checkpoints',
      category: 'session',
      handler: () => ({ handled: false }),
    },
    {
      name: 'restore',
      description: 'Restore a checkpoint',
      category: 'session',
      handler: () => ({ handled: false }),
    },
    {
      name: 'mouse',
      description: 'Toggle mouse mode (SGR tracking for wheel scroll)',
      category: 'navigation',
      handler: () => ({ handled: true, output: '[synax] mouse toggled' }),
    },
  ];

  for (const cmd of commands) {
    registerCommand(cmd);
  }
}

// ─── Initialize on import ───────────────────────────────────

registerBuiltinCommands();
