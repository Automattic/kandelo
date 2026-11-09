/**
 * Non-fatal GL host diagnostics: emulation the GL host could not apply, so a
 * guest draw ran with WebGL's behavior where ES 2.0's differs. They are not
 * GL errors (the guest's commands were valid and the draw is not refused),
 * so they reach the embedder through the kernel's existing host-diagnostic
 * channel (`KernelCallbacks.onHostDiagnostic`): the worker entries log them
 * and post a `host_diagnostic` message, which `NodeKernelHost` and
 * `BrowserKernel` expose through their own `onHostDiagnostic`. Fatal host
 * faults go through native-recovery.ts instead.
 *
 * Reporters emit at variant build or shader rewrite time, once per cause,
 * never per draw.
 */
import type { HostDiagnostic } from "../host-diagnostic.js";

let reporter: ((diagnostic: HostDiagnostic) => void) | null = null;

/** The kernel installs its host-diagnostic callback here, beside its fault
 * reporter (native-recovery.ts). One kernel owns the renderers of a worker
 * realm. */
export function setGlDiagnosticReporter(next: ((diagnostic: HostDiagnostic) => void) | null): void {
  reporter = next;
}

/** Report a diagnostic for `pid`. Without an installed reporter (a GL host
 * running outside a kernel) the message goes to the console, so it is
 * never dropped. A failing reporter must not fail the draw that found it. */
export function reportGlDiagnostic(pid: number, source: string, message: string): void {
  if (!reporter) { console.warn(`[webgl] ${message}`); return; }
  try { reporter({ pid, source, message }); }
  catch (error) { console.error("[webgl] host diagnostic reporter failed:", error); }
}
