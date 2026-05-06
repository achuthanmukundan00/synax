export interface InspectedRange {
  path: string;
  startLine: number;
  endLine: number;
}

export interface InspectionLedger {
  recordFileRange(path: string, startLine: number, endLine: number): void;
  recordFileRead(path: string, startLine: number, endLine: number, text: string): void;
  recordGitStatus(): void;
  recordGitDiff(): void;
  hasInspectedFile(path: string): boolean;
  hasInspectedRange(path: string, startLine: number, endLine: number): boolean;
  hasReadText(path: string, text: string): boolean;
  hasGitStatusInspection(): boolean;
  hasGitDiffInspection(): boolean;
  getInspectedRanges(): InspectedRange[];
}

export function createInspectionLedger(): InspectionLedger {
  const ranges: InspectedRange[] = [];
  const reads: Array<{ path: string; text: string }> = [];
  let inspectedGitStatus = false;
  let inspectedGitDiff = false;

  return {
    recordFileRange(path: string, startLine: number, endLine: number): void {
      ranges.push({ path, startLine, endLine });
    },

    recordFileRead(path: string, startLine: number, endLine: number, text: string): void {
      ranges.push({ path, startLine, endLine });
      reads.push({ path, text });
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

    hasGitStatusInspection(): boolean {
      return inspectedGitStatus;
    },

    hasGitDiffInspection(): boolean {
      return inspectedGitDiff;
    },

    getInspectedRanges(): InspectedRange[] {
      return [...ranges];
    },
  };
}
