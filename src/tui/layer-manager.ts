/**
 * Simple layer composition for the TUI render pipeline.
 *
 * Layers let the interactive TUI compose base + overlay + replace renderers
 * without hardcoded offset mutations. Each layer declares its screen region
 * and an optional z-order for compositing.
 *
 * Layer order (lowest to highest):
 *   0 — Base (renderLayout)
 *   1 — Overlay (autocomplete)
 *   2 — Replace (modals: settings, resume picker)
 *
 * Replace layers take over the full screen. Overlays composite on top of base.
 */

import { visibleLength } from './text-utils';

export interface Layer {
  /** Render the layer's content as screen lines. */
  render(): string[];
  /**
   * Row range this layer occupies (0 = first row of the screen).
   * Undefined means full-screen.
   */
  region?: { start: number; end: number };
}

export class LayerStack {
  private layers: Map<string, { z: number; layer: Layer }> = new Map();

  set(name: string, z: number, layer: Layer): void {
    this.layers.set(name, { z, layer });
  }

  remove(name: string): void {
    this.layers.delete(name);
  }

  has(name: string): boolean {
    return this.layers.has(name);
  }

  /** Render the full composited screen. Returns the final set of lines. */
  render(height: number, width: number): string[] {
    const sorted = Array.from(this.layers.entries()).sort((a, b) => a[1].z - b[1].z);
    let lines: string[] | null = null;

    for (const [, { layer }] of sorted) {
      const layerLines = layer.render();
      const region = layer.region;
      if (region) {
        // Overlay mode — composite onto existing lines
        if (lines === null) {
          lines = Array.from({ length: height }, () => '');
        }
        for (let i = region.start; i < Math.min(region.end, height) && i - region.start < layerLines.length; i++) {
          lines[i] = padLine(layerLines[i - region.start], width);
        }
      } else {
        // Replace mode — full screen takeover
        lines = layerLines.slice(0, height);
      }
    }

    // Pad to full height
    if (lines === null) {
      lines = Array.from({ length: height }, () => '');
    }
    while (lines.length < height) {
      lines.push('');
    }
    return lines.map((l) => padLine(l, width));
  }
}

function padLine(text: string, width: number): string {
  const visible = visibleLength(text);
  if (visible >= width) return text;
  return text + ' '.repeat(width - visible);
}
