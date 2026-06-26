import * as React from "react";
import { useGalleryItems } from "../kernel-host/react";
import { decodeBootDescriptor } from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import type {
  BootDescriptor,
  GalleryItem,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

type NewMachineSource = "presets" | "url" | "image";

const SOURCE_TABS: Array<{ id: NewMachineSource; label: string }> = [
  { id: "presets", label: "Presets" },
  { id: "url", label: "Kandelo URL" },
  { id: "image", label: "VFS image" },
];

export const NewMachinePane: React.FC<{
  onLaunchItem: (item: GalleryItem) => void;
  onBrowseAll: () => void;
  onApplyDescriptor: (desc: BootDescriptor) => void;
}> = ({ onLaunchItem, onBrowseAll, onApplyDescriptor }) => {
  const { items, loading } = useGalleryItems("presets");
  const featured = items.slice(0, 6);
  const [source, setSource] = React.useState<NewMachineSource>("presets");
  const [url, setUrl] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const bootUrl = async () => {
    if (!url.trim()) return;
    setError(null);
    const hashIndex = url.indexOf("#");
    const fragment = hashIndex === -1 ? url : url.slice(hashIndex + 1);
    try {
      const descriptor = await decodeBootDescriptor(fragment);
      if (!descriptor) {
        setError("Paste a Kandelo URL or k1= fragment.");
        return;
      }
      onApplyDescriptor(descriptor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="knew">
      <div className="knew-tabs" role="tablist" aria-label="New machine sources">
        {SOURCE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={source === tab.id}
            className="knew-tab"
            onClick={() => setSource(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {source === "presets" && (
        <section className="knew-panel" role="tabpanel">
          <div className="knew-section-head">
            <div>
              <h3>Start from a preset</h3>
              <p>Boot a published Kandelo VFS image through the normal gallery descriptor path.</p>
            </div>
            <button type="button" className="knew-link" onClick={onBrowseAll}>
              Browse all
            </button>
          </div>

          {loading ? (
            <div className="knew-empty">Loading presets...</div>
          ) : featured.length === 0 ? (
            <div className="knew-empty">No presets are available.</div>
          ) : (
            <div className="knew-presets">
              {featured.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="knew-preset"
                  onClick={() => onLaunchItem(item)}
                >
                  <span className="knew-preset-glyph" style={{ background: item.accent }}>
                    {item.glyph}
                  </span>
                  <span className="knew-preset-copy">
                    <span className="knew-preset-title">{item.title}</span>
                    <span className="knew-preset-sub">{item.summary}</span>
                  </span>
                  <span className="knew-preset-meta">{item.packages.length} pkgs</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {source === "url" && (
        <section className="knew-panel" role="tabpanel">
          <div className="knew-section-head">
            <div>
              <h3>Open a Kandelo URL</h3>
              <p>Paste a share link or raw k1 fragment. Decoding and booting stay inside KernelHost.</p>
            </div>
          </div>
          <div className="knew-url-row">
            <input
              className="knew-input"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://kandelo.dev/c/shell#k1=..."
            />
            <button type="button" className="knew-primary" onClick={bootUrl}>
              Boot
            </button>
          </div>
          {error && <div className="knew-error">{error}</div>}
          <div className="knew-note">
            Malformed, oversized, or unsupported descriptors fail visibly instead of
            being patched into a demo-only boot path.
          </div>
        </section>
      )}

      {source === "image" && (
        <section className="knew-panel knew-boundary" role="tabpanel">
          <div className="knew-section-head">
            <div>
              <h3>Bring a VFS image</h3>
              <p>Direct image import remains a platform boundary until the host has a durable upload/mount contract.</p>
            </div>
          </div>
          <div className="knew-boundary-list">
            <div>
              <span>Available now</span>
              <strong>Gallery images and Kandelo URLs</strong>
            </div>
            <div>
              <span>Not yet available</span>
              <strong>Local image upload, durable browser mount, or trusted archive import</strong>
            </div>
          </div>
          <div className="knew-note">
            This pane does not fake success for local files. Image import needs a real
            KernelHost/VFS contract with size caps, path validation, and persistence semantics.
          </div>
        </section>
      )}
    </div>
  );
};
