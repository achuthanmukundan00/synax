/**
 * Thin wrapper around @chenglou/pretext for measured text layout.
 * Provides caching, SSR safety, and convenience helpers.
 *
 * Pretext uses Canvas 2D for measurement, which is unavailable during
 * SSR/static build. We gracefully return zero-height results in that case.
 */

import {
  prepare,
  prepareWithSegments,
  layout,
  layoutWithLines,
  walkLineRanges,
  measureLineStats,
  layoutNextLine,
  materializeLineRange,
  type PreparedText,
  type PreparedTextWithSegments,
  type LayoutResult,
  type LayoutLinesResult,
  type LayoutLine,
  type LayoutLineRange,
  type LayoutCursor,
  type PrepareOptions,
  type LineStats,
} from '@chenglou/pretext'

// ---------------------------------------------------------------------------
// SSR detection
// ---------------------------------------------------------------------------

function isSSR(): boolean {
  return typeof document === 'undefined' || typeof HTMLCanvasElement === 'undefined'
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  plain: PreparedText | null
  segmented: PreparedTextWithSegments | null
}

const prepareCache = new Map<string, CacheEntry>()

function cacheKey(text: string, font: string, options?: PrepareOptions): string {
  return JSON.stringify({ t: text, f: font, o: options ?? {} })
}

/**
 * Prepare text for measurement. Results are cached by text+font+options.
 * Returns null if canvas is unavailable (SSR).
 */
export function prepareMeasuredText(
  text: string,
  font: string,
  options?: PrepareOptions,
): PreparedText | null {
  if (isSSR()) return null
  const key = cacheKey(text, font, options)
  let entry = prepareCache.get(key)
  if (!entry) {
    entry = { plain: null, segmented: null }
    prepareCache.set(key, entry)
  }
  if (!entry.plain) {
    entry.plain = prepare(text, font, options)
  }
  return entry.plain
}

/**
 * Prepare text for manual line layout. Results are cached.
 * Returns null if canvas is unavailable (SSR).
 */
export function prepareMeasuredTextWithSegments(
  text: string,
  font: string,
  options?: PrepareOptions,
): PreparedTextWithSegments | null {
  if (isSSR()) return null
  const key = cacheKey(text, font, options)
  let entry = prepareCache.get(key)
  if (!entry) {
    entry = { plain: null, segmented: null }
    prepareCache.set(key, entry)
  }
  if (!entry.segmented) {
    entry.segmented = prepareWithSegments(text, font, options)
  }
  return entry.segmented
}

/**
 * Measure a text block's height and line count at a given max width.
 * Returns zero results if prepared is null (SSR).
 */
export function measureTextBlock(
  prepared: PreparedText | null,
  maxWidth: number,
  lineHeight: number,
): LayoutResult {
  if (!prepared) return { height: 0, lineCount: 0 }
  return layout(prepared, maxWidth, lineHeight)
}

/**
 * Lay out text into lines with measured widths. Useful for terminal/code blocks.
 * Returns empty lines if prepared is null (SSR).
 */
export function layoutMeasuredLines(
  prepared: PreparedTextWithSegments | null,
  maxWidth: number,
  lineHeight: number,
): LayoutLinesResult {
  if (!prepared) return { height: 0, lineCount: 0, lines: [] }
  return layoutWithLines(prepared, maxWidth, lineHeight)
}

/**
 * Get line statistics (count + max width) without allocating line strings.
 */
export function getLineStats(
  prepared: PreparedTextWithSegments | null,
  maxWidth: number,
): LineStats {
  if (!prepared) return { lineCount: 0, maxLineWidth: 0 }
  return measureLineStats(prepared, maxWidth)
}

/**
 * Walk line ranges — calls onLine for each line without allocating strings.
 */
export function walkMeasuredLineRanges(
  prepared: PreparedTextWithSegments | null,
  maxWidth: number,
  onLine: (line: LayoutLineRange) => void,
): number {
  if (!prepared) return 0
  return walkLineRanges(prepared, maxWidth, onLine)
}

/**
 * Build a single next line from a cursor position. For variable-width layout.
 */
export function nextMeasuredLine(
  prepared: PreparedTextWithSegments | null,
  start: LayoutCursor,
  maxWidth: number,
): LayoutLine | null {
  if (!prepared) return null
  return layoutNextLine(prepared, start, maxWidth)
}

/**
 * Turn a line range back into a full line with text.
 */
export function materializeMeasuredLine(
  prepared: PreparedTextWithSegments | null,
  line: LayoutLineRange,
): LayoutLine | null {
  if (!prepared) return null
  return materializeLineRange(prepared, line)
}

/**
 * Clear the internal prepare cache. Useful if cycling through many
 * different texts/fonts.
 */
export function clearMeasuredTextCache(): void {
  prepareCache.clear()
}
