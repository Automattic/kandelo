/**
 * Host-runtime diagnostic delivered outside a guest process's fd 2 stream.
 *
 * `status` is present when the diagnostic describes a process disposition.
 * Protocol/setup failures that are not tied to an exit status leave it absent.
 */
export interface HostDiagnostic {
  pid: number;
  status?: number;
  source: string;
  message: string;
}

export interface HostDiagnosticMessage extends HostDiagnostic {
  type: "host_diagnostic";
}

export function formatHostErrorDiagnostic(error: unknown): string {
  try {
    const messages: string[] = [];
    const seen = new Set<unknown>();
    let current = error;
    let deepestStack = "";
    for (let depth = 0; depth < 4 && !seen.has(current); depth += 1) {
      seen.add(current);
      if (!(current instanceof Error)) {
        messages.push(String(current).slice(0, 512));
        break;
      }
      messages.push(current.message.slice(0, 512));
      try {
        if (typeof current.stack === "string") deepestStack = current.stack.slice(0, 4096);
      } catch {}
      const cause = Object.getOwnPropertyDescriptor(current, "cause");
      if (cause === undefined || !("value" in cause)) break;
      current = cause.value;
    }
    return `${messages.join("\nCaused by: ")}${deepestStack ? `\n${deepestStack}` : ""}`;
  } catch {
    return "host failure could not be formatted";
  }
}
