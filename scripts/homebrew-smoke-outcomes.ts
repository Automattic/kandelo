import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SmokeOutcomeStatus = "pass" | "fail" | "skip";

export interface SmokeOutcome {
  name: string;
  status: SmokeOutcomeStatus;
  durationMs: number;
  details?: string;
  error?: string;
  artifactPath?: string;
}

export class SkipCase extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkipCase";
  }
}

export function countOutcomes(outcomes: SmokeOutcome[]): {
  pass: number;
  fail: number;
  skip: number;
} {
  return {
    pass: outcomes.filter((outcome) => outcome.status === "pass").length,
    fail: outcomes.filter((outcome) => outcome.status === "fail").length,
    skip: outcomes.filter((outcome) => outcome.status === "skip").length,
  };
}

export function writeOutcomeLists(
  resultDir: string,
  outcomes: SmokeOutcome[],
  options: { includeArtifactPath?: boolean } = {},
): void {
  const listsDir = join(resultDir, "outcome-lists");
  mkdirSync(listsDir, { recursive: true });
  const passed = outcomes.filter((outcome) => outcome.status === "pass");
  const failed = outcomes.filter((outcome) => outcome.status === "fail");
  const skipped = outcomes.filter((outcome) => outcome.status === "skip");
  const withArtifact = options.includeArtifactPath === true;

  writeFileSync(
    join(listsDir, "passed-tests.tsv"),
    [
      withArtifact ? "test\tduration_ms\tdetails\tartifact_path" : "test\tduration_ms\tdetails",
      ...passed.map((outcome) => [
        outcome.name,
        String(outcome.durationMs),
        tsv(outcome.details ?? ""),
        ...(withArtifact ? [tsv(outcome.artifactPath ?? "")] : []),
      ].join("\t")),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(listsDir, "failed-tests.tsv"),
    [
      withArtifact ? "test\tduration_ms\terror\tartifact_path" : "test\tduration_ms\terror",
      ...failed.map((outcome) => [
        outcome.name,
        String(outcome.durationMs),
        tsv(outcome.error ?? outcome.details ?? ""),
        ...(withArtifact ? [tsv(outcome.artifactPath ?? "")] : []),
      ].join("\t")),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(listsDir, "skipped-tests.tsv"),
    [
      withArtifact ? "test\treason\tartifact_path" : "test\treason",
      ...skipped.map((outcome) => [
        outcome.name,
        tsv(outcome.details ?? ""),
        ...(withArtifact ? [tsv(outcome.artifactPath ?? "")] : []),
      ].join("\t")),
    ].join("\n") + "\n",
  );
  writeFileSync(join(resultDir, "failures.json"), `${JSON.stringify(failed, null, 2)}\n`);
}

function tsv(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, "\\n");
}
