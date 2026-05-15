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
