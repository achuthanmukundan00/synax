export interface InspectedRange {
  path: string;
  startLine: number;
  endLine: number;
}

export interface InspectionLedger {
  recordFileRange(path: string, startLine: number, endLine: number): void;
  recordFileRead(path: string, startLine: number, endLine: number, text: string, truncated?: boolean): void;
  recordGitStatus(): void;
  recordGitDiff(): void;
  hasInspectedFile(path: string): boolean;
  hasInspectedRange(path: string, startLine: number, endLine: number): boolean;
  hasReadText(path: string, text: string): boolean;
  hasReadTextFromCompleteRead(path: string, text: string): boolean;
  markPathAsTruncated(path: string): void;
  hasGitStatusInspection(): boolean;
  hasGitDiffInspection(): boolean;
  getInspectedRanges(): InspectedRange[];
  getOrientation(fileReadCounts?: Map<string, number>, compactedFilePaths?: string[]): string;
}

export function createInspectionLedger(): InspectionLedger {
  const ranges: InspectedRange[] = [];
  const reads: Array<{ path: string; text: string; truncated: boolean }> = [];
  const truncatedPaths = new Set<string>();
  const readCounts = new Map<string, number>();
  let inspectedGitStatus = false;
  let inspectedGitDiff = false;

  return {
    recordFileRange(path: string, startLine: number, endLine: number): void {
      ranges.push({ path, startLine, endLine });
      readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
    },

    recordFileRead(path: string, startLine: number, endLine: number, text: string, truncated = false): void {
      ranges.push({ path, startLine, endLine });
      reads.push({ path, text, truncated });
      readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
      if (truncated) {
        truncatedPaths.add(path);
      } else {
        truncatedPaths.delete(path);
      }
    },

    recordGitStatus(): void {
      inspectedGitStatus = true;
    },

    recordGitDiff(): void {
      inspectedGitDiff = true;
    },

    hasInspectedFile(path: string): boolean {
      return ranges.some((range) => range.path === path);
    },

    hasInspectedRange(path: string, startLine: number, endLine: number): boolean {
      const relevantRanges = ranges
        .filter((range) => range.path === path)
        .sort((left, right) => left.startLine - right.startLine);
      let coveredUntil = startLine - 1;

      for (const range of relevantRanges) {
        if (range.endLine < startLine) {
          continue;
        }

        if (range.startLine > coveredUntil + 1) {
          return false;
        }

        coveredUntil = Math.max(coveredUntil, range.endLine);
        if (coveredUntil >= endLine) {
          return true;
        }
      }

      return false;
    },

    hasReadText(path: string, text: string): boolean {
      return reads.some((read) => read.path === path && read.text === text);
    },

    hasReadTextFromCompleteRead(path: string, text: string): boolean {
      if (truncatedPaths.has(path)) return false;
      return reads.some((read) => read.path === path && read.text === text && !read.truncated);
    },

    markPathAsTruncated(path: string): void {
      truncatedPaths.add(path);
    },

    hasGitStatusInspection(): boolean {
      return inspectedGitStatus;
    },

    hasGitDiffInspection(): boolean {
      return inspectedGitDiff;
    },

    getInspectedRanges(): InspectedRange[] {
      return [...ranges];
    },

    getOrientation(fileReadCounts?: Map<string, number>, compactedFilePaths?: string[]): string {
      const counts = fileReadCounts ?? readCounts;
      const compactedSet = new Set(compactedFilePaths ?? []);
      const lines: string[] = [];

      // Compact heading
      lines.push('WORKING CONTEXT:');

      // Files inspected with their ranges
      const inspected = new Map<string, { min: number; max: number; truncated: boolean }>();
      for (const range of ranges) {
        const existing = inspected.get(range.path);
        if (existing) {
          existing.min = Math.min(existing.min, range.startLine);
          existing.max = Math.max(existing.max, range.endLine);
        } else {
          inspected.set(range.path, {
            min: range.startLine,
            max: range.endLine,
            truncated: truncatedPaths.has(range.path),
          });
        }
      }

      if (inspected.size === 0) {
        lines.push('  (nothing inspected yet)');
      } else {
        lines.push('  Inspected files:');
        for (const [path, info] of inspected) {
          const rangeStr = info.min === info.max ? `line ${info.min}` : `lines ${info.min}-${info.max}`;
          const count = counts.get(path);
          const countStr = count && count > 1 ? ` (read ${count}x)` : '';
          const tags: string[] = [];
          if (info.truncated) tags.push('TRUNCATED');
          else if (compactedSet.has(path)) tags.push('compacted from model view');
          const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
          lines.push(`    ${path}  ${rangeStr}${countStr}${tagStr}`);
        }
      }

      // Three categories for edit safety
      const modelVisible: string[] = [];
      const compactedFromModel: string[] = [];
      const truncatedFiles: string[] = [];
      for (const [path, info] of inspected) {
        if (info.truncated) {
          truncatedFiles.push(path);
        } else if (compactedSet.has(path)) {
          compactedFromModel.push(path);
        } else {
          modelVisible.push(path);
        }
      }

      if (modelVisible.length > 0) {
        lines.push('  Editable from memory (exact text currently visible to model):');
        for (const path of modelVisible.slice(0, 20)) {
          lines.push(`    ${path}`);
        }
      }

      if (compactedFromModel.length > 0) {
        lines.push('  Compated from model view (reread target range before editing):');
        for (const path of compactedFromModel.slice(0, 20)) {
          lines.push(`    ${path}`);
        }
      }

      if (truncatedFiles.length > 0) {
        lines.push('  Needs reread before editing (was truncated):');
        for (const path of truncatedFiles.slice(0, 20)) {
          lines.push(`    ${path}`);
        }
      }

      // Git status
      const gitItems: string[] = [];
      if (inspectedGitStatus) gitItems.push('status inspected');
      if (inspectedGitDiff) gitItems.push('diff inspected');
      if (gitItems.length > 0) {
        lines.push(`  Git: ${gitItems.join(', ')}`);
      }

      // Cap total output
      let result = lines.join('\n');
      if (result.length > 6000) {
        result = result.slice(0, 5997) + '...';
      }
      return result;
    },
  };
}
