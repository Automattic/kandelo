import * as React from "react";
import { useKernelHost, useStatus } from "../kernel-host/react";
import { useDialogDismiss } from "./use-dialog-dismiss";
import { createExportSink, excludedExportPath, exportChildPath, exportFilesZip, supportsStreamingExport, type ExportProgress } from "./export-files";
import type { ReferenceVfsReader } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { ExportSink } from "./export-files";

export function ExportFilesDialog({ onClose }: { onClose: () => void }) {
  const host = useKernelHost();
  const status = useStatus();
  const referenceFiles = host.referenceFiles;
  const referenceAvailable = referenceFiles !== undefined && referenceFiles.unavailableReason === undefined;
  const [mode, setMode] = React.useState<"changes" | "all">(() => referenceAvailable ? "changes" : "all");
  const dialog = React.useRef<HTMLDialogElement>(null);
  const controller = React.useRef<AbortController | null>(null);
  const [folder, setFolder] = React.useState("/");
  const [folders, setFolders] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState<ExportProgress | null>(null);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const { close, ...dismiss } = useDialogDismiss(dialog, () => {
    controller.current?.abort();
    onClose();
  });
  React.useEffect(() => {
    dialog.current?.showModal();
    return () => { controller.current?.abort(); dialog.current?.close(); };
  }, []);
  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setMessage("");
    void (async () => {
      const entries = await host.captureVfsReader().readDir(folder);
      if (!entries) throw new Error(`Cannot read folder: ${folder}`);
      return entries.filter(entry => (entry.mode & 0xf000) === 0x4000 && entry.name !== "." && entry.name !== "..")
        .map(entry => exportChildPath(folder, entry.name)).filter(path => !excludedExportPath(path)).sort();
    })().then(paths => { if (active) setFolders(paths); })
      .catch(cause => { if (active) { setError(String(cause instanceof Error ? cause.message : cause)); setFolders([]); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [host, folder]);
  React.useEffect(() => {
    if (status !== "running") controller.current?.abort();
  }, [status]);
  const download = async () => {
    if (controller.current) return;
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true);
    setError("");
    setMessage("");
    setProgress(null);
    let reference: ReferenceVfsReader | undefined;
    let sink: ExportSink | undefined;
    try {
      const reader = host.captureVfsReader();
      const title = folder === "/" ? host.getBootDescriptor().title || "kandelo-files" : folder.split("/").at(-1)!;
      const name = `${title.replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 100) || "kandelo-files"}${mode === "changes" ? "-changes" : ""}.zip`;
      sink = await createExportSink(name, operation.signal);
      if (mode === "changes") {
        if (!referenceAvailable) throw new Error(referenceFiles?.unavailableReason ?? "A reference image is not available");
        reference = await referenceFiles.open(operation.signal);
      }
      const result = await exportFilesZip(reader, folder, sink, operation.signal, setProgress, reference);
      await reference?.dispose();
      reference = undefined;
      setMessage(`ZIP handed to your browser. ${result.files} files and symbolic links exported.${mode === "changes" ? ` ${result.unchanged} unchanged ${result.unchanged === 1 ? "file" : "files"} omitted.` : ""}${result.skipped ? ` ${result.skipped} ${result.skipped === 1 ? "entry" : "entries"} excluded (virtual folders or special files).` : ""}`);
    } catch (cause) {
      await sink?.abort().catch(() => {});
      if (operation.signal.aborted || cause instanceof DOMException && cause.name === "AbortError") setMessage("Export cancelled.");
      else setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      try { await reference?.dispose(); }
      catch (cause) { setError(`Reference image cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
      controller.current = null;
      setBusy(false);
    }
  };
  return <dialog ref={dialog} className="khelp-dialog kexport-dialog" aria-labelledby="kexport-title" {...dismiss}>
    <header className="kpopin-heading"><h2 id="kexport-title">Export files</h2><button type="button" className="kshare-x" aria-label="Close" onClick={close}>×</button></header>
    <p>Download a ZIP with hidden files, empty folders, and symbolic links. Virtual folders and special files are excluded.</p>
    <p>Files are read while the computer is running. Stop apps that are writing files for a more consistent export.</p>
    <fieldset disabled={busy || status !== "running"} className="kexport-mode">
      <legend>Include</legend>
      <label><input type="radio" name="export-mode" value="changes" checked={mode === "changes"} disabled={!referenceAvailable} onChange={() => { setMode("changes"); setMessage(""); setError(""); }} /> Added and changed files</label>
      <label><input type="radio" name="export-mode" value="all" checked={mode === "all"} onChange={() => { setMode("all"); setMessage(""); setError(""); }} /> All files</label>
    </fieldset>
    {referenceAvailable ? <p>{mode === "changes" ? "Unchanged files are omitted; deleted files are not included. Apps’ generated files may appear. Comparison may download reference files." : "Includes unchanged files from the reference image too."}</p> : <p>{referenceFiles?.unavailableReason ?? "A reference image is not available for comparison. You can export all files."}</p>}
    <fieldset disabled={busy || status !== "running"}>
      <legend>Folder to export</legend>
      <div className="kexport-location"><code aria-label="Selected folder">{folder}</code><button type="button" className="kshare-btn" disabled={folder === "/"} onClick={() => setFolder(folder.slice(0, folder.lastIndexOf("/")) || "/")}>Up one folder</button></div>
      {folder !== "/" && <button type="button" className="kshare-btn" onClick={() => setFolder("/")}>Whole filesystem</button>}
      <div className="kexport-folders" aria-label="Folders">
        {loading ? <p>Reading folders…</p> : folders.length ? folders.map(path => <button type="button" className="kshare-btn" key={path} onClick={() => setFolder(path)}>{path.split("/").at(-1)}/</button>) : <p>No subfolders</p>}
      </div>
    </fieldset>
    {!supportsStreamingExport() && <p>This browser buffers the ZIP before downloading (up to 256 MB).</p>}
    {status !== "running" && <p role="alert">Start the computer to export its files.</p>}
    {busy && <div role="status"><p>{progress ? `${progress.files} files · ${(progress.bytes / 1048576).toFixed(1)} MB read${mode === "changes" ? ` · ${progress.unchanged} unchanged` : ""}` : mode === "changes" ? "Opening reference image…" : "Preparing export…"}</p><progress aria-label="Export progress" /><p className="kexport-path">{progress?.path}</p></div>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
    <footer className="kexport-actions">
      {busy ? <button type="button" className="kshare-btn" onClick={() => controller.current?.abort()}>Cancel export</button> : <button type="button" className="kshare-btn kshare-btn-primary" autoFocus disabled={loading || status !== "running"} onClick={() => void download()}>Download ZIP</button>}
    </footer>
  </dialog>;
}
