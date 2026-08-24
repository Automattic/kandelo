export type DinitServiceCompletion = {
  serviceName: string;
  outcome: "succeeded" | "failed";
};

/**
 * Complete dinit target/dependency closures for browser web demos.
 *
 * Every listed service participates in readiness and failure reporting. This
 * prevents a dependency failure from being hidden behind a still-running init
 * process or a later HTTP 502 response.
 */
export const REQUIRED_DINIT_SERVICES = {
  nginx: ["nginx"],
  "nginx-php": ["php-fpm", "nginx"],
  "wordpress-sqlite": [
    "wp-config-init",
    "smtp-capture",
    "php-fpm",
    "nginx",
  ],
  "wordpress-mariadb": [
    "mariadb",
    "wp-config-init",
    "smtp-capture",
    "mariadb-ready",
    "php-fpm",
    "nginx",
  ],
} as const;

export class DinitBootStatusTracker {
  private completedServices = new Map<
    string,
    DinitServiceCompletion["outcome"]
  >();
  private startingServices = new Set<string>();
  private outputTails = new Map<string, string>();

  constructor(
    private tick: (msg: string) => void,
    private onServiceCompleted?: (completion: DinitServiceCompletion) => void,
  ) {}

  observeProcessOutput(text: string, stream: string): void {
    if (!text) return;
    const normalized = `${this.outputTails.get(stream) ?? ""}${text}`.replace(
      /\r/g,
      "",
    );
    const lines = normalized.split("\n");
    this.outputTails.set(
      stream,
      text.endsWith("\n") ? "" : (lines.pop() ?? ""),
    );
    for (const line of lines) {
      const completion = parseDinitCompletionLine(line);
      if (!completion) continue;
      if (this.completedServices.has(completion.serviceName)) continue;
      this.emitStarting(completion.serviceName);
      this.completedServices.set(completion.serviceName, completion.outcome);
      this.onServiceCompleted?.(completion);
    }
  }

  hasSucceeded(serviceName: string): boolean {
    return this.completedServices.get(serviceName) === "succeeded";
  }

  hasFailed(serviceName: string): boolean {
    return this.completedServices.get(serviceName) === "failed";
  }

  private emitStarting(serviceName: string): void {
    if (this.completedServices.has(serviceName)) return;
    if (this.startingServices.has(serviceName)) return;
    this.startingServices.add(serviceName);
    this.tick(`Starting ${serviceName}...`);
  }
}

function parseDinitCompletionLine(
  line: string,
): DinitServiceCompletion | null {
  const match = stripAnsi(line)
    .trim()
    .match(/^\[(\s*OK\s*|FAILED)\]\s+(.+)$/);
  const serviceName = match?.[2]?.trim();
  if (!serviceName) return null;
  return {
    serviceName,
    outcome: match?.[1]?.trim() === "OK" ? "succeeded" : "failed",
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
