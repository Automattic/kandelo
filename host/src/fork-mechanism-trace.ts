export interface ProcessMemoryStatsSource<T> {
  getRetirementStats(): T;
}

export function sampleProcessMemoryStats<T>(
  enabled: boolean,
  source: ProcessMemoryStatsSource<T>,
): T | undefined {
  return enabled ? source.getRetirementStats() : undefined;
}
