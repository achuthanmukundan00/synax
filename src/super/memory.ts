export type SuperMemoryConsolidationInput = {
  shortTermItems: string[];
  now?: Date;
};

export type SuperMemoryConsolidationResult = {
  longTermNotes: string[];
  digest: string;
  questionsForUser: string[];
};

export interface SuperMemoryConsolidator {
  consolidate(input: SuperMemoryConsolidationInput): Promise<SuperMemoryConsolidationResult>;
}

export class NoopSuperMemoryConsolidator implements SuperMemoryConsolidator {
  async consolidate(input: SuperMemoryConsolidationInput): Promise<SuperMemoryConsolidationResult> {
    return {
      longTermNotes: [],
      digest: input.shortTermItems.join('\n'),
      questionsForUser: [],
    };
  }
}
