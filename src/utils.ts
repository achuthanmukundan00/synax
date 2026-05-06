export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}
