import type { BenchmarkArtifacts } from "./types.js";

export function assertRequiredBenchmarkArtifacts(artifacts: BenchmarkArtifacts): void {
  const missing: string[] = [];
  for (const [name, artifact] of Object.entries(artifacts.files)) {
    if (artifact.required === true && artifact.missing === true && artifact.used !== false) {
      missing.push(`${name} (${artifact.path})`);
    }
  }
  for (const [name, artifact] of Object.entries(artifacts.directories ?? {})) {
    if (artifact.required === true && artifact.missing === true && artifact.used !== false) {
      missing.push(`${name} (${artifact.path})`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      "Cannot run benchmark without required selected artifact evidence:\n" +
      missing.map((name) => `  ${name}`).join("\n"),
    );
  }
}
