import * as React from "react";
import type { ComputerBootProfile, ComputerLibrary, ComputerLibrarySnapshot, ComputerRetention, StoredComputer } from "../../../../../web-libs/kandelo-session/src/computer-library";
import { computerStorageFormatLabel, DEFAULT_COMPUTER_RETENTION, JOURNALED_OPFS_IMAGE_STORAGE_FORMAT } from "../../../../../web-libs/kandelo-session/src/computer-library";
import type { GalleryItem } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { randomComputerName } from "../../../../../web-libs/kandelo-session/src/computer-name";
import { useGalleryItems } from "../kernel-host/react";
import { computerTemplateFor, computerTemplates, type ComputerTemplate } from "./computer-templates";
import { useDialogDismiss } from "../app/use-dialog-dismiss";
import { PersistenceReleaseWarning, PERSISTENCE_RELEASE_WARNING } from "../app/PersistenceReleaseWarning";

const EMPTY_LIBRARY: ComputerLibrarySnapshot = { current: null, computers: [], issues: [], storageProtected: false };
const noSubscription = () => () => {};
const emptySnapshot = () => EMPTY_LIBRARY;

const DeleteComputerDialog: React.FC<{
  title: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onDelete: () => void;
}> = ({ title, busy, error, onClose, onDelete }) => {
  const dialog = React.useRef<HTMLDialogElement | null>(null);
  const [confirmation, setConfirmation] = React.useState("");
  const { close, ...dismiss } = useDialogDismiss(dialog, onClose, !busy);
  React.useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="kopen-website" aria-label="Delete computer" {...dismiss}>
    <header className="kpopin-heading"><h2>Delete computer</h2><button type="button" className="kshare-x" aria-label="Cancel deletion" disabled={busy} onClick={close}>×</button></header>
    <p>Delete <strong>{title}</strong> and all its local data? This cannot be undone. Other computers will not be changed.</p>
    {error && <p role="alert" className="kcomputer-error">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); if (!busy && confirmation === title) onDelete(); }}>
      <label>Type the computer name to confirm<input autoFocus autoComplete="off" spellCheck={false} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>
      <button type="submit" className="kshare-btn" disabled={busy || confirmation !== title}>{busy ? "Deleting…" : "Delete computer"}</button>
    </form>
  </dialog>;
};

export function useComputerLibrary(library: ComputerLibrary | undefined): ComputerLibrarySnapshot {
  return React.useSyncExternalStore(library?.subscribe ?? noSubscription, library?.getSnapshot ?? emptySnapshot);
}

export const NewComputerOptions: React.FC<{
  retention: ComputerRetention;
  onChange: (retention: ComputerRetention) => void;
}> = ({ retention, onChange }) => (
  <fieldset className="kcomputer-retention">
    <legend>New computer storage</legend>
    <PersistenceReleaseWarning />
    <p data-storage-format={JOURNALED_OPFS_IMAGE_STORAGE_FORMAT}>Storage format: {computerStorageFormatLabel(JOURNALED_OPFS_IMAGE_STORAGE_FORMAT)}</p>
    <label><input type="radio" name="computer-retention" value="saved" checked={retention === "saved"} onChange={() => onChange("saved")} /> Saved on this device</label>
    <label><input type="radio" name="computer-retention" value="temporary" checked={retention === "temporary"} onChange={() => onChange("temporary")} /> Temporary</label>
    <p className={retention === "temporary" ? "kcomputer-temporary-warning" : undefined}>{retention === "saved"
      ? "Changes save automatically. Reload reopens this computer. Delete it from Library when you no longer need it; export important work as a backup."
      : "Temporary computer — not kept permanently. Reload keeps your work, but this computer can be deleted after 24 hours without opening it. Use Keep this computer in Library to keep it on this device."}</p>
  </fieldset>
);

export const ComputerLibraryView: React.FC<{
  library: ComputerLibrary | undefined;
  onOpened: () => void;
  onCreate: (item: GalleryItem, retention: ComputerRetention, title: string) => Promise<void>;
  initialScreen?: "computers" | "templates";
}> = ({ library, onOpened, onCreate, initialScreen = "computers" }) => {
  const snapshot = useComputerLibrary(library);
  const { items, loading } = useGalleryItems("presets");
  const templates = React.useMemo(() => computerTemplates(items), [items]);
  const [screen, setScreen] = React.useState<"computers" | "templates" | "create" | "boot">(initialScreen);
  const [layout, setLayout] = React.useState<"gallery" | "list">("gallery");
  const [filter, setFilter] = React.useState("");
  const [template, setTemplate] = React.useState<ComputerTemplate | null>(null);
  const [retention, setRetention] = React.useState<ComputerRetention>(DEFAULT_COMPUTER_RETENTION);
  const [profileId, setProfileId] = React.useState("");
  const [bootComputer, setBootComputer] = React.useState<StoredComputer | null>(null);
  const [profiles, setProfiles] = React.useState<ComputerBootProfile[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [renameId, setRenameId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<{ id: string; title: string } | null>(null);
  const [name, setName] = React.useState("");
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  React.useEffect(() => {
    if (library) void run(() => library.refresh());
  }, [library]);

  const chooseTemplate = (chosen: ComputerTemplate) => {
    setTemplate(chosen); setProfileId(chosen.representative.id);
    setName(randomComputerName(snapshot.computers.map(computer => computer.title)));
    setRetention(DEFAULT_COMPUTER_RETENTION); setError(null); setScreen("create");
  };
  const newComputer = () => { setFilter(""); setError(null); setScreen("templates"); };
  const chooseBoot = (computer: StoredComputer) => void run(async () => {
    const choices = await library!.bootProfiles(computer.id);
    setBootComputer(computer); setProfiles(choices);
    setProfileId(choices.find(profile => profile.selected)?.id ?? choices[0]?.id ?? "");
    setScreen("boot");
  });
  const matches = (text: string) => text.toLocaleLowerCase().includes(filter.toLocaleLowerCase());
  const visibleComputers = snapshot.computers.filter(computer => matches(computer.title));
  const visibleTemplates = templates.filter(candidate => matches(`${candidate.title} ${candidate.profiles.map(profile => `${profile.id} ${profile.title}`).join(" ")}`));
  const back = () => { setError(null); setScreen(screen === "create" ? "templates" : "computers"); };

  return <section className="kcomputer-library" aria-label="Computer library" aria-busy={busy}>
    <div className="kcomputer-toolbar">
      <div>
        {screen !== "computers" && <button className="kcomputer-back" type="button" disabled={busy} onClick={back}>← {screen === "create" ? "Choose image" : "Your computers"}</button>}
        <h3>{screen === "computers" ? "Your computers" : screen === "templates" ? "Choose an image" : screen === "create" ? "Make it yours" : "Boot computer"}</h3>
        <p>{screen === "computers" ? "Your files stay with your computer. Pick up where you left off."
          : screen === "templates" ? "One image, many ways to boot. Choose your starting filesystem first."
          : screen === "create" ? `${template?.title} · choose what starts when this computer boots.`
          : "Choose what starts. Your computer and its saved files stay the same."}</p>
      </div>
      {screen === "computers" && <button className="kshare-btn kshare-btn-primary" type="button" disabled={busy} onClick={newComputer}>+ New computer</button>}
    </div>
    {(screen === "computers" || screen === "boot") && <PersistenceReleaseWarning />}
    {(screen === "computers" || screen === "templates") && <div className="kcomputer-browse-tools">
      <input type="search" aria-label={screen === "templates" ? "Find images" : "Find computers"} placeholder={screen === "templates" ? "Find an image or boot profile…" : "Find a computer…"} value={filter} onChange={event => setFilter(event.target.value)} />
      <div role="group" aria-label="Library layout">
        <button type="button" className="kgal-row-btn" aria-pressed={layout === "gallery"} onClick={() => setLayout("gallery")}>Gallery</button>
        <button type="button" className="kgal-row-btn" aria-pressed={layout === "list"} onClick={() => setLayout("list")}>List</button>
      </div>
    </div>}
    <div className="kcomputer-content">
      {error && <p role="alert">{error}</p>}
      {screen === "templates" && (loading ? <p role="status">Loading images…</p> : <>
        <ul className={`kcomputer-list kcomputer-layout-${layout}`} aria-label="Computer images">
          {visibleTemplates.map(candidate => <li key={candidate.id} data-image-id={candidate.id} className="kcomputer-template">
            <button type="button" disabled={busy} aria-label={`Choose ${candidate.title}`} onClick={() => chooseTemplate(candidate)}>
              <ComputerArtwork item={candidate.representative} />
              <strong>{candidate.title}</strong>
              <p>{candidate.representative.summary}</p>
              <small>{candidate.profiles.length} boot {candidate.profiles.length === 1 ? "profile" : "profiles"}</small>
              <span className="kcomputer-profile-tags">{candidate.profiles.slice(0, 4).map(profile => <span key={profile.id}>{profile.title}</span>)}{candidate.profiles.length > 4 && <span>+{candidate.profiles.length - 4}</span>}</span>
            </button>
          </li>)}
        </ul>
        {visibleTemplates.length === 0 && <p>No images match your search.</p>}
      </>)}
      {screen === "create" && template && <form className="kcomputer-configure" aria-label="New computer" onSubmit={event => {
        event.preventDefault();
        const profile = template.profiles.find(candidate => candidate.id === profileId);
        if (profile) void run(async () => { await onCreate(profile, retention, name.trim()); onOpened(); });
      }}>
        <ComputerArtwork item={template.representative} />
        <div className="kcomputer-name">
          <label>Computer name<input value={name} maxLength={120} required disabled={busy} onChange={event => setName(event.target.value)} /></label>
          <button type="button" className="kgal-row-btn kcomputer-regenerate-name" aria-label="Generate another name" title="Generate another name" disabled={busy} onClick={() => setName(currentName => randomComputerName([...snapshot.computers.map(computer => computer.title), currentName.trim()]))}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M20 7v5h-5" /><path d="M20 12a8 8 0 1 0-2.3 5.7M20 12a8 8 0 0 0-2.3-5.7" /></svg>
          </button>
        </div>
        <label>Boot profile<select value={profileId} disabled={busy} onChange={event => setProfileId(event.target.value)}>
          {template.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.title}</option>)}
        </select></label>
        <p>{template.profiles.find(profile => profile.id === profileId)?.summary}</p>
        {library && <NewComputerOptions retention={retention} onChange={setRetention} />}
        {!library && <p>This boot mode does not support the computer library. This computer will be memory-only.</p>}
        <div className="kcomputer-actions"><button type="button" className="kshare-btn" disabled={busy} onClick={back}>Back</button><button type="submit" className="kshare-btn kshare-btn-primary" disabled={busy || !name.trim()}>{busy ? "Starting…" : "Create and boot"}</button></div>
      </form>}
      {screen === "boot" && bootComputer && library && <form className="kcomputer-configure" aria-label="Boot options" onSubmit={event => {
        event.preventDefault();
        void run(async () => { await library.open(bootComputer.id, profileId); onOpened(); });
      }}>
        <h4>{bootComputer.title}</h4>
        <label>Boot profile<select value={profileId} disabled={busy} onChange={event => setProfileId(event.target.value)}>
          {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.title}{profile.selected ? " · Last used" : ""}</option>)}
        </select></label>
        <p>{profiles.find(profile => profile.id === profileId)?.summary}</p>
        <p className="kcomputer-storage-note">This choice is remembered. Reload opens the same computer with this profile; it does not create a new filesystem.</p>
        <p className="kcomputer-storage-note">Missing profile assets are downloaded and verified before software starts. Existing files are kept.</p>
        <div className="kcomputer-actions"><button type="button" className="kshare-btn" disabled={busy} onClick={back}>Cancel</button><button type="submit" className="kshare-btn kshare-btn-primary" disabled={busy || !profileId}>{busy ? "Starting…" : snapshot.current?.id === bootComputer.id ? "Reboot computer" : "Boot computer"}</button></div>
      </form>}
      {screen === "computers" && <>
      {!library && <p>The computer library is unavailable in this boot mode. You can still create a memory-only computer.</p>}
      {snapshot.issues.map(issue => <p key={issue.id} role="alert">Computer {issue.id}: {issue.message}. Its data has not been replaced. <button type="button" className="kgal-row-btn" disabled={busy || !library || snapshot.current?.id === issue.id} onClick={() => {
        setDeleting({ id: issue.id, title: issue.id });
      }}>Delete computer data</button></p>)}
      {snapshot.computers.length === 0 && <div className="kcomputer-empty"><h4>A place for your computers</h4><p>Create a saved computer to come back to, or a temporary one to experiment.</p><button type="button" className="kshare-btn kshare-btn-primary" onClick={newComputer}>Choose an image</button></div>}
      <ul className={`kcomputer-list kcomputer-layout-${layout}`} aria-label="Stored computers">
        {visibleComputers.map(computer => {
          const initialTemplate = computerTemplateFor(computer, templates);
          const imageType = initialTemplate?.title ?? "VFS image";
          return <li key={computer.id} data-computer-id={computer.id} aria-current={snapshot.current?.id === computer.id ? "true" : undefined}>
          <ComputerArtwork item={initialTemplate?.representative} />
          <div className="kcomputer-details">
            <strong>{computer.title}</strong>
            {snapshot.current?.id === computer.id && <span className="kcomputer-current-badge">Current computer</span>}
            <div className="kcomputer-retention-status">
              <span className={computer.retention === "temporary" ? "kcomputer-temporary-badge" : undefined}>{computer.retention === "saved" ? "Saved on this device" : "Temporary"}</span>
              {computer.retention === "temporary" && <button type="button" className="kgal-row-btn" disabled={busy || !library} onClick={() => {
                if (window.confirm(`Keep “${computer.title}” on this device? It will stay in your Library until you delete it.\n\n${PERSISTENCE_RELEASE_WARNING}`)) void run(() => library!.keep(computer.id));
              }}>Keep this computer</button>}
            </div>
            <small className="kcomputer-image-info" title={`Initial image: ${imageType} · Storage: ${computerStorageFormatLabel(computer.storageFormat)}`}><span aria-label={`Initial image: ${imageType}`}>{imageType}</span> · <span data-storage-format={computer.storageFormat} title={computer.storageFormat}>{computerStorageFormatLabel(computer.storageFormat)}</span></small>
            <small>Last opened {new Date(computer.lastOpenedAt).toLocaleString()}{computer.expiresAt === null ? "" : ` · Cleanup eligible ${new Date(computer.expiresAt).toLocaleString()}`}</small>
          </div>
          <div className="kcomputer-actions">
            <button type="button" className="kgal-row-btn kgal-row-btn-primary" disabled={busy || !library} onClick={() => chooseBoot(computer)}>{snapshot.current?.id === computer.id ? "Boot options" : "Open"}</button>
            <button type="button" className="kgal-row-btn" disabled={busy} onClick={() => { setRenameId(computer.id); setName(computer.title); }}>Rename</button>
            <button type="button" className="kgal-row-btn" disabled={busy || !library || snapshot.current?.id === computer.id} title={snapshot.current?.id === computer.id ? "Open another computer before deleting this one" : "Delete this computer and its local data"} onClick={() => {
              setDeleting({ id: computer.id, title: computer.title });
            }}>Delete</button>
          </div>
          {renameId === computer.id && <form className="kcomputer-rename" onSubmit={event => {
            event.preventDefault();
            void run(async () => { await library!.rename(computer.id, name); setRenameId(null); });
          }}>
            <input aria-label="Computer name" maxLength={120} value={name} onChange={event => setName(event.target.value)} />
            <button type="submit" className="kgal-row-btn" disabled={busy}>Save name</button>
            <button type="button" className="kgal-row-btn" onClick={() => setRenameId(null)}>Cancel</button>
          </form>}
        </li>;
        })}
      </ul>
      {snapshot.computers.length > 0 && visibleComputers.length === 0 && <p>No computers match your search.</p>}
      {deleting && library && <DeleteComputerDialog key={deleting.id} title={deleting.title} busy={busy} error={error} onClose={() => { if (!busy) setDeleting(null); }} onDelete={() => void run(async () => { await library.remove(deleting.id); setDeleting(null); })} />}
      <p className="kcomputer-storage-note">{snapshot.storageProtected
        ? "Saved in this browser · Storage protection granted. Clearing site data still deletes these computers. Export important work."
        : "Saved in this browser · Storage protection not granted. Site data can be evicted. Export important work."}</p>
      </>}
    </div>
  </section>;
};

const ComputerArtwork: React.FC<{ item?: GalleryItem }> = ({ item }) => <div className="kcomputer-art" style={{ "--computer-accent": item?.accent ?? "var(--k-accent)" } as React.CSSProperties} aria-hidden="true">
  <div className="kcomputer-monitor"><span>{item?.glyph ?? ">_"}</span><i /><i /><i /></div>
  <div className="kcomputer-stand" />
</div>;
