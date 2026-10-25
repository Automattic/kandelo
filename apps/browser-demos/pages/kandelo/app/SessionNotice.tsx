import * as React from "react";

export type SessionTransfer = { received: number; total: number };
const size = (bytes: number) => bytes >= 1024 * 1024
  ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;

/** Primary feedback stays above the details in every session dialog. */
export function SessionNotice({ children, detail, tone = "working", transfer, readiness = false }: {
  children: React.ReactNode; detail?: string; tone?: "working" | "success" | "error";
  transfer?: SessionTransfer | null; readiness?: boolean;
}) {
  const percent = transfer ? Math.floor(transfer.received / transfer.total * 100) : null;
  return <div className="knetwork-notice" data-tone={tone} data-join-readiness={readiness ? "" : undefined}>
    <div className="knetwork-notice-message" role={tone === "error" ? "alert" : "status"} aria-atomic="true">
      <span className="knetwork-notice-icon" aria-hidden="true">{tone === "success" ? "✓" : tone === "error" ? "!" : "…"}</span>
      <strong>{children}</strong>
    </div>
    {detail && <p className="knetwork-notice-detail">{detail}</p>}
    {transfer && <div className="knetwork-transfer">
      <div className="knetwork-transfer-values" aria-hidden="true"><strong>{percent}%</strong><span>{size(transfer.received)} / {size(transfer.total)}</span></div>
      <progress value={transfer.received} max={transfer.total} aria-label="Receiving activity files" />
    </div>}
  </div>;
}
