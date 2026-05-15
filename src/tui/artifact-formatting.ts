import { renderAiCore } from './ai-core';
import type { SemanticEventClass } from './semantic-events';

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

const GLYPHS: Record<SemanticEventClass, string> = {
  plan: '...',
  edit: '+',
  diff: '!',
  command: '$',
  tool_result: '+',
  review: '!',
  commit: '#',
  checkpoint: '+',
  approval: '!',
  status: '...',
  error: 'x',
  note: '>',
  assistant_text: '>',
};

function labelFor(eventClass: SemanticEventClass): string {
  if (eventClass === 'assistant_text') return 'Note';
  if (eventClass === 'tool_result') return 'Result';
  return eventClass.replace(/_/g, ' ').replace(/^\w/, (char) => char.toUpperCase());
}

export function formatEventCrown(eventClass: SemanticEventClass): string {
  return `  ${GLYPHS[eventClass]}  ${labelFor(eventClass)}  `;
}

export function promptInputHeight(prompt: string, terminalWidth = 80): number {
  const wrapColumns = Math.max(16, terminalWidth - 4);
  const explicitLines = stripAnsi(prompt).split('\n');
  const visualLines = explicitLines.reduce((count, line) => {
    const lineLength = Math.max(1, line.length);
    return count + Math.max(1, Math.ceil(lineLength / wrapColumns));
  }, 0);
  return Math.max(1, visualLines);
}

export function renderSplashLogo(frame: number, options?: { color?: boolean }): string[] {
  const useColor = options?.color !== false;
  return renderAiCore('idle', frame / 8)
    .slice(0, 9)
    .map((line) => (useColor ? stripAnsi(line) : stripAnsi(line).replace(/[╭╮╰╯─│○◎●•·]/g, '.')));
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}
