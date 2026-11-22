import * as React from "react";
import { CommunityLinks } from "./CommunityLinks";
import { useDialogDismiss } from "./use-dialog-dismiss";

export const HelpDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const { close, ...dismiss } = useDialogDismiss(dialog, onClose);
  React.useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="khelp-dialog" aria-labelledby="khelp-title" {...dismiss}>
    <header className="kpopin-heading"><h2 id="khelp-title">Welcome to Kandelo</h2><button type="button" autoFocus className="kshare-x" title="Close" aria-label="Close" onClick={close}>×</button></header>
    <p>Kandelo is an experimental computer that runs in your browser. It runs Unix-style software compiled to WebAssembly, including shells, editors, programming languages, web servers, and games.</p>
    <h3>Get started</h3>
    <p>Open <strong>Library</strong> to create or reopen a computer. Choose <strong>Base Shell</strong> for a terminal, or try a Web Stack or WordPress computer. Use <strong>Activities</strong> to launch installed apps.</p>
    <h3>Bring files in</h3>
    <p>Drop files onto the computer or use <strong>Send files</strong>. The usual destination is <code>~/Downloads/</code> inside Kandelo; some apps handle dropped files themselves.</p>
    <h3>Get files out</h3>
    <p>Open <strong>More → Export files…</strong> to download a ZIP of added and changed files, or choose <strong>All files</strong>. You can export the whole tree or a folder. To save a single file from the terminal, run:</p>
    <pre><code>kandelo-publish ./report.pdf</code></pre>
    <p>Then click <strong>Save</strong> on the output card to download it to your device. For a folder, create an archive first.</p>
    <h3>Keep your work</h3>
    <p>Computers are stored in this browser. Keep a temporary computer through Library to retain it. Browser storage is not a backup: export important files before clearing site data or updating Kandelo.</p>
    <p><a href="https://automattic.github.io/kandelo/guide/" target="_blank" rel="noopener noreferrer">Read the user guide</a></p>
    <CommunityLinks />
  </dialog>;
};
