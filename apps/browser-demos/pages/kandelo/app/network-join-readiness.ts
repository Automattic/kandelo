export function networkJoinReadiness({ failed, error, invitationError, running, ready, progress, busy }: {
  failed?: boolean;
  error?: string | null;
  invitationError?: string | null;
  running: boolean;
  ready: boolean;
  progress?: string | null;
  busy: boolean;
}): { tone: "working" | "success" | "error"; message: string } {
  if (failed) return { tone: "error", message: "Computer failed to start." };
  if (invitationError) return { tone: "error", message: "Cannot join this activity." };
  if (error) return { tone: "error", message: "Couldn’t join. Try again." };
  if (!running) return { tone: "working", message: "Starting computer…" };
  if (!ready) return { tone: "working", message: "Loading activity…" };
  if (progress || busy) return { tone: "working", message: progress ?? "Connecting to host…" };
  return { tone: "success", message: "Ready to join." };
}
