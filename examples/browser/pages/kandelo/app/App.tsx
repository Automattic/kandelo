// Top-level Kandelo app. View router (sidebar item → main panel content);
// holds the per-session UI state (sidebar collapsed flag, current view,
// inspector tab, share dialog open).
//
// Today only the 'machine' surface is wired. Other views show a placeholder
// while their components are built.

import * as React from "react";
import { useKernelHost, useStatus } from "../kernel-host/react";
import { Sidebar, type ViewId, type InternalsTab } from "./Sidebar";
import { LiveUrlBar } from "./LiveUrlBar";
import { MachineView } from "../views/MachineView";
import { Gallery, descriptorFromGalleryItem } from "../views/Gallery";
import { Config } from "../views/Config";
import { EmptyState } from "../views/EmptyState";
import { ShareDialog } from "../dialogs/ShareDialog";
import type { BootDescriptor, GalleryItem } from "../../../../../host/src/kandelo-ui/kernel-host";

export const App: React.FC = () => {
  const host = useKernelHost();
  const status = useStatus();

  const [collapsed, setCollapsed] = React.useState(false);
  const [view, setView] = React.useState<ViewId>("machine");
  const [internalsTab, setInternalsTab] = React.useState<InternalsTab>("syslog");
  /**
   * Share dialog state. `null` = closed; `true` = sharing the running
   * machine; a BootDescriptor = sharing a gallery preset that hasn't been
   * applied yet (e.g. user clicked the share icon on a gallery card).
   */
  const [shareTarget, setShareTarget] = React.useState<true | BootDescriptor | null>(null);

  const desc = host.getBootDescriptor();

  const onNav = (id: ViewId) => {
    if (id === "share") {
      setShareTarget(true);
      return;
    }
    setView(id);
  };

  const onLaunchGalleryItem = React.useCallback((item: GalleryItem) => {
    const next = descriptorFromGalleryItem(item, host.getBootDescriptor());
    setView("machine");
    void host.applyBootDescriptor(next).catch((err) => {
      console.warn("applyBootDescriptor failed:", err);
    });
  }, [host]);

  const onShareGalleryItem = React.useCallback((item: GalleryItem) => {
    setShareTarget(descriptorFromGalleryItem(item, host.getBootDescriptor()));
  }, [host]);

  const isMachineView = view === "machine" || view === "internals";
  const isEmpty = isMachineView && status === "idle";
  const flushMain = view === "gallery" || view === "browse" || view === "export" || view === "config" || isEmpty;

  const onApplyPastedDescriptor = React.useCallback((d: BootDescriptor) => {
    void host.applyBootDescriptor(d).catch((err) => {
      console.warn("applyBootDescriptor failed:", err);
    });
  }, [host]);

  return (
    <div className="kapp">
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((c) => !c)}
        view={view}
        onNav={onNav}
        internalsTab={internalsTab}
        onInternalsTab={(t) => {
          setView("internals");
          setInternalsTab(t);
        }}
        status={status}
        descriptorTitle={desc.title}
        descriptorId={desc.id}
      />

      <main className={"kmain" + (flushMain ? " kmain-flush" : "")}>
        {isEmpty ? (
          <EmptyState
            onLaunchItem={onLaunchGalleryItem}
            onBrowseAll={() => setView("gallery")}
            onApplyDescriptor={onApplyPastedDescriptor}
          />
        ) : isMachineView ? (
          <>
            <LiveUrlBar onOpenShare={() => onNav("share")} />
            <MachineView
              internalsTab={internalsTab}
              onInternalsTab={(t) => setInternalsTab(t as InternalsTab)}
            />
          </>
        ) : view === "gallery" ? (
          <Gallery onLaunch={onLaunchGalleryItem} onShare={onShareGalleryItem} />
        ) : view === "config" ? (
          <Config onApplied={() => setView("machine")} />
        ) : (
          <PlaceholderView view={view} />
        )}
      </main>

      {shareTarget && (
        <ShareDialog
          descriptor={shareTarget === true ? undefined : shareTarget}
          presetId={shareTarget === true ? desc.id : shareTarget.id}
          onClose={() => setShareTarget(null)}
        />
      )}
    </div>
  );
};

const PlaceholderView: React.FC<{ view: ViewId }> = ({ view }) => {
  const label =
    view === "gallery" ? "Gallery"
    : view === "browse" ? "Browse Systems"
    : view === "config" ? "System Config"
    : view === "export" ? "Export VFS"
    : "View";
  return (
    <div style={{
      flex: 1,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      color: "var(--k-text-faint)",
      padding: 32,
      textAlign: "center",
    }}>
      <div style={{
        fontSize: 28,
        fontWeight: 700,
        letterSpacing: "-0.02em",
        color: "var(--k-text)",
      }}>{label}</div>
      <div style={{ fontSize: 14, maxWidth: 480, color: "var(--k-text-muted)" }}>
        This surface is in the implementation order but not built yet. The
        Sidebar/LiveURLBar/MachineView chassis comes first; this view is
        wired once the chassis is signed off.
      </div>
    </div>
  );
};
