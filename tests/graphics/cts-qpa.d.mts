export interface CtsCaseResult {
  path: string;
  status: string;
  description: string;
}
export interface CtsQpaResults {
  rows: CtsCaseResult[];
  counts: Record<string, number>;
  incomplete: string[];
  duplicates: string[];
  missing: string[];
  unexpected: string[];
}
export function parseCtsQpa(text: string, expected: readonly string[]): CtsQpaResults;
export const GLES2_NEGATIVE_STATE_CASES: readonly string[];
