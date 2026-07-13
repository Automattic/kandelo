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
