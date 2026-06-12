export interface TuiStats {
  cardsRendered: number;
  repaintCount: number;
  renderedFrames: number;
  skippedIdleFrames: number;
  averageFrameIntervalMs: number;
  largestCardLineCount: number;
  expandEvents: number;
  totalCardLines: number;
  peakCardLines: number;
}

class TuiStatsCollector {
  private stats: TuiStats = {
    cardsRendered: 0,
    repaintCount: 0,
    renderedFrames: 0,
    skippedIdleFrames: 0,
    averageFrameIntervalMs: 0,
    largestCardLineCount: 0,
    expandEvents: 0,
    totalCardLines: 0,
    peakCardLines: 0,
  };

  recordCardRendered(lineCount: number): void {
    this.stats.cardsRendered++;
    this.stats.totalCardLines += lineCount;
    if (lineCount > this.stats.largestCardLineCount) {
      this.stats.largestCardLineCount = lineCount;
    }
    if (lineCount > this.stats.peakCardLines) {
      this.stats.peakCardLines = lineCount;
    }
  }

  recordRepaint(): void {
    this.stats.repaintCount++;
  }

  recordFrame(stats: {
    renderedFrames: number;
    skippedIdleFrames: number;
    averageActiveFrameIntervalMs: number;
  }): void {
    this.stats.renderedFrames = stats.renderedFrames;
    this.stats.skippedIdleFrames = stats.skippedIdleFrames;
    this.stats.averageFrameIntervalMs = stats.averageActiveFrameIntervalMs;
  }

  recordExpandToggle(): void {
    this.stats.expandEvents++;
  }

  getStats(): TuiStats {
    return { ...this.stats };
  }

  reset(): void {
    this.stats = {
      cardsRendered: 0,
      repaintCount: 0,
      renderedFrames: 0,
      skippedIdleFrames: 0,
      averageFrameIntervalMs: 0,
      largestCardLineCount: 0,
      expandEvents: 0,
      totalCardLines: 0,
      peakCardLines: 0,
    };
  }

  formatReport(): string {
    const s = this.stats;
    return [
      `Cards rendered: ${s.cardsRendered}`,
      `Repaints: ${s.repaintCount}`,
      `Rendered frames: ${s.renderedFrames}`,
      `Skipped idle frames: ${s.skippedIdleFrames}`,
      `Avg frame interval: ${s.averageFrameIntervalMs.toFixed(1)}ms`,
      `Largest card: ${s.largestCardLineCount} lines`,
      `Expand toggles: ${s.expandEvents}`,
      `Total card lines: ${s.totalCardLines}`,
      `Peak card lines: ${s.peakCardLines}`,
    ].join('\n');
  }
}

export const tuiStats = new TuiStatsCollector();

// ─── Cost formatting ────────────────────────────────────────────────────────

/**
 * Format a USD cost with adaptive decimal precision.
 *
 * - ≥ $100:    2 decimal places (e.g. $123.45)
 * - ≥ $0.0001: 4 decimal places (e.g. $1.2345, $0.0123)
 * - < $0.0001: up to 10 decimal places, trailing zeros stripped (e.g. $0.000342)
 * - $0.00:     explicit zero display
 */
export function formatCost(usd: number): string {
  if (usd === 0 || Object.is(usd, -0)) return '$0.00';
  const abs = Math.abs(usd);
  const sign = usd < 0 ? '-' : '';
  if (abs >= 100) return `${sign}$${abs.toFixed(2)}`;
  if (abs >= 0.01) return `${sign}$${abs.toFixed(4)}`;
  // Very small: show significant digits up to 10 decimal places, strip trailing zeros
  const raw = abs.toFixed(10);
  const trimmed = raw.replace(/0+$/, '').replace(/\.$/, '.0');
  return `${sign}$${trimmed}`;
}

/**
 * Format a per-1M-token price compactly.
 *
 * Strips trailing zeros and unnecessary decimal points for readability.
 * Handles sub-cent per-1M pricing with appropriate precision.
 */
export function formatPricePer1M(price: number): string {
  if (price === 0) return '$0/M';
  // For prices ≥ 1, strip trailing zeros after 2 decimal places
  if (price >= 1) {
    const s = price.toFixed(2);
    const trimmed = s.replace(/0+$/, '').replace(/\.$/, '');
    return `$${trimmed}/M`;
  }
  // For prices < 1, show up to 6 decimal places, strip trailing zeros
  const s = price.toFixed(6);
  const trimmed = s.replace(/0+$/, '').replace(/\.$/, '');
  return `$${trimmed}/M`;
}
