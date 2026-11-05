import * as React from "react";
import { CommunityLinks } from "./CommunityLinks";
import { useDialogDismiss } from "./use-dialog-dismiss";

export const AboutDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const { close, ...dismiss } = useDialogDismiss(dialog, onClose);
  React.useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="kabout-dialog" aria-labelledby="kabout-title" {...dismiss}>
    <header className="kpopin-heading"><h2 id="kabout-title">About Kandelo</h2><button type="button" autoFocus className="kshare-x" title="Close" aria-label="Close" onClick={close}>×</button></header>
    <p>Kandelo runs real programs in your browser. It is based on POSIX and aims to be POSIX-compatible. Open a shell, run a web server or database, or launch a graphical application. Keep a computer and its files on this device, or start a temporary one.</p>
    <p>Programs are compiled to WebAssembly and run against a Rust kernel that manages processes, files, networking, and devices. The browser provides storage and other host services; no remote virtual machine is required. A journaled filesystem backed by browser storage lets a computer grow beyond its in-memory cache.</p>
    <CommunityLinks />
  </dialog>;
};
