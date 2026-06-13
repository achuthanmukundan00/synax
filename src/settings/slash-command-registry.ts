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
      name: 'changelog',
      description: 'Show the latest release changelog',
      category: 'navigation',
      handler: async () => {
        try {
          const { readFileSync } = await import('fs');
          const { join } = await import('path');
          const changelog = readFileSync(join(process.cwd(), 'CHANGELOG.md'), 'utf-8');
          const releaseMatch = changelog.match(/^##\s+\[([^\]]+)\]([\s\S]*?)(?=\n##\s|\n\[|$)/m);
          if (!releaseMatch) return { handled: true, output: 'No release entries found in CHANGELOG.md.' };
          const version = releaseMatch[1];
          const body = releaseMatch[2].trim();
          return { handled: true, output: `## [${version}]\n\n${body}` };
        } catch {
          return { handled: true, output: 'CHANGELOG.md not found.' };
        }
      },
    },
    {
      name: 'settings',
      description: 'Open settings',
      category: 'settings',
      handler: () => ({ handled: true, openSettings: true }),
      opensSettings: true,
    },
    {
      name: 'model',
      description: 'Change model',
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
      description: 'Manage skills',
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
      name: 'help',
      description: 'Show help',
      category: 'navigation',
      handler: () => ({ handled: false }),
    },
    {
      name: 'exit',
      description: 'Exit Synax',
      category: 'navigation',
      aliases: ['quit'],
      handler: () => ({ handled: true, exit: true }),
    },
    {
      name: 'clear',
      description: 'Clear conversation',
      category: 'session',
      handler: () => ({ handled: true, newSession: true }),
    },
    {
      name: 'new',
      description: 'Start a fresh session',
      category: 'session',
      handler: () => ({ handled: true, newSession: true }),
    },
  ];

  for (const cmd of commands) {
    registerCommand(cmd);
  }
}

// ─── Initialize on import ───────────────────────────────────

registerBuiltinCommands();
