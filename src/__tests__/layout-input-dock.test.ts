import { createInitialRunStateSnapshot } from '../agent/tui-state';
import { renderLayout } from '../tui/layout';

describe('layout input dock', () => {
  it('expands beyond two lines and keeps latest text visible', () => {
    const objectiveInput = `${'expand the prompt dock '.repeat(22)}TAIL_MARKER`;
    const lines = renderLayout(
      {
        run: createInitialRunStateSnapshot(0),
        objectiveInput,
        coreMode: 'idle',
        nowMs: 2000,
      },
      90,
      24,
    ).map(stripAnsi);

    const dockTop = findLastIndex(lines, (line) => line.trimStart().startsWith('┌'));
    const dock = dockTop >= 0 ? lines.slice(dockTop) : [];

    expect(dock.length).toBeGreaterThan(4);
    expect(dock[0]?.trimStart().startsWith('┌')).toBe(true);
    expect(dock.at(-1)?.trimStart().startsWith('└ Enter submit')).toBe(true);
    expect(lines.join('\n')).toContain('TAIL_MARKER');
  });
});

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}
