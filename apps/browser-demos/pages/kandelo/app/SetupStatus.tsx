import * as React from "react";
import { HelpDialog } from "./HelpDialog";

export function SetupStatus({ error }: { error?: string }) {
  const [helpOpen, setHelpOpen] = React.useState(false);
  return <div style={{ padding: 32, maxWidth: 780 }}>
    <strong>{error ? "LiveKernelHost setup failed" : "Preparing this computer…"}</strong>
    {error && <pre role="alert" style={{ whiteSpace: "pre-wrap" }}>{error}</pre>}
    <p><button type="button" onClick={() => setHelpOpen(true)}>Help</button></p>
    {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
  </div>;
}
