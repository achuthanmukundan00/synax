import { tuiStats } from '../tui/telemetry';

describe('TUI telemetry', () => {
  beforeEach(() => {
    tuiStats.reset();
  });

  it('starts at zero', () => {
    const stats = tuiStats.getStats();
    expect(stats.cardsRendered).toBe(0);
    expect(stats.repaintCount).toBe(0);
    expect(stats.expandEvents).toBe(0);
  });

  it('records card renders and tracks largest card', () => {
    tuiStats.recordCardRendered(10);
    tuiStats.recordCardRendered(5);
    const stats = tuiStats.getStats();
    expect(stats.cardsRendered).toBe(2);
    expect(stats.largestCardLineCount).toBe(10);
    expect(stats.totalCardLines).toBe(15);
  });

  it('records peak card lines', () => {
    tuiStats.recordCardRendered(3);
    tuiStats.recordCardRendered(20);
    tuiStats.recordCardRendered(7);
    const stats = tuiStats.getStats();
    expect(stats.peakCardLines).toBe(20);
  });

  it('records repaints', () => {
    tuiStats.recordRepaint();
    tuiStats.recordRepaint();
    expect(tuiStats.getStats().repaintCount).toBe(2);
  });

  it('records expand toggles', () => {
    tuiStats.recordExpandToggle();
    tuiStats.recordExpandToggle();
    expect(tuiStats.getStats().expandEvents).toBe(2);
  });

  it('reset clears all stats', () => {
    tuiStats.recordCardRendered(99);
    tuiStats.recordRepaint();
    tuiStats.reset();
    const stats = tuiStats.getStats();
    expect(stats.cardsRendered).toBe(0);
    expect(stats.repaintCount).toBe(0);
    expect(stats.largestCardLineCount).toBe(0);
  });

  it('formatReport returns string with all fields', () => {
    tuiStats.recordCardRendered(5);
    tuiStats.recordRepaint();
    const report = tuiStats.formatReport();
    expect(report).toContain('Cards rendered');
    expect(report).toContain('Repaints');
    expect(report).toContain('Largest card');
  });
});
