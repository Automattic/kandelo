// Top-level Kandelo app. The machine remains the primary canvas; the dock
// switches machine views and opens exploratory panes for gallery, config,
// sharing, and new machine setup.

import * as React from "react";
import { useKernelHost } from "../kernel-host/react";
import { Dock, DockPane, type DockPaneId, type DockViewId } from "./Dock";
import { NewMachinePane } from "./NewMachinePane";
import { MachineView, useMachineSurfaceController } from "../views/MachineView";
import { Gallery, descriptorFromGalleryItem } from "../views/Gallery";
import { Config } from "../views/Config";
import { EmptyState } from "../views/EmptyState";
import { SharePanel } from "../dialogs/ShareDialog";
import { createShellTerminal, type ShellTerminal } from "../panes/Shell";
import { navigateToGalleryItemUrl } from "../url-state";
import type { BootDescriptor, GalleryItem } from "../../../../../web-libs/kandelo-session/src/kernel-host";

type InternalsTab = "syslog" | "procs" | "vfs" | "lazy-load" | "config" | "syscalls";

const PANE_META: Record<DockPaneId, { title: string; subtitle: string }> = {
  new: {
    title: "New machine",
    subtitle: "Start from a preset, open a Kandelo URL, or review image import boundaries.",
  },
  gallery: {
    title: "Gallery",
    subtitle: "Published Kandelo systems and local demo images.",
  },
  config: {
    title: "This machine",
    subtitle: "Edit the current boot descriptor through KernelHost.",
  },
  share: {
    title: "Share and export",
    subtitle: "Create a Kandelo URL and check what state it can carry.",
  },
};

export const App: React.FC = () => {
  const host = useKernelHost();
  const surface = useMachineSurfaceController();

  const [dockPane, setDockPane] = React.useState<DockPaneId | null>(null);
  const [internalsTab, setInternalsTab] = React.useState<InternalsTab>("syslog");
  const [shareTarget, setShareTarget] = React.useState<BootDescriptor | null>(null);
  const [terminals, setTerminals] = React.useState<ShellTerminal[]>(() => [createShellTerminal(1)]);
  const [activeTerminalId, setActiveTerminalId] = React.useState("tty-1");
  const nextTerminalIndex = React.useRef(2);

  const desc = host.getBootDescriptor();

  const closeDockPane = React.useCallback(() => {
    setDockPane(null);
    setShareTarget(null);
  }, []);

  const selectDockPane = React.useCallback((pane: DockPaneId | null) => {
    setShareTarget(null);
    setDockPane((current) => current === pane ? null : pane);
  }, []);

  const selectMachineView = React.useCallback((view: DockViewId) => {
    setShareTarget(null);
    setDockPane(null);
    surface.chooseView(view);
  }, [surface]);

  const applyDescriptor = React.useCallback((d: BootDescriptor) => {
    void host.applyBootDescriptor(d).then(closeDockPane).catch((err) => {
      console.warn("applyBootDescriptor failed:", err);
    });
  }, [host, closeDockPane]);

  const onLaunchGalleryItem = React.useCallback((item: GalleryItem) => {
    if (item.vfsImageUrl) {
      navigateToGalleryItemUrl(item);
      return;
    }

    const next = descriptorFromGalleryItem(item, host.getBootDescriptor());
    void host.applyBootDescriptor(next).then(closeDockPane).catch((err) => {
      console.warn("applyBootDescriptor failed:", err);
    });
  }, [host, closeDockPane]);

  const onShareGalleryItem = React.useCallback((item: GalleryItem) => {
    setShareTarget(descriptorFromGalleryItem(item, host.getBootDescriptor()));
    setDockPane("share");
  }, [host]);

  const onAddTerminal = React.useCallback(() => {
    const terminal = createShellTerminal(nextTerminalIndex.current++);
    setTerminals((prev) => [...prev, terminal]);
    setActiveTerminalId(terminal.id);
  }, []);

  const isEmpty = surface.status === "idle";
  const meta = dockPane ? PANE_META[dockPane] : null;

  return (
    <div className="kapp kdocked-app">
      <main className={`kmain kdocked-main${isEmpty ? " kmain-flush" : ""}`}>
        {isEmpty ? (
          <EmptyState
            onLaunchItem={onLaunchGalleryItem}
            onBrowseAll={() => setDockPane("gallery")}
            onApplyDescriptor={applyDescriptor}
          />
        ) : (
          <MachineView
            surface={surface}
            internalsTab={internalsTab}
            onInternalsTab={(t) => setInternalsTab(t as InternalsTab)}
            terminals={terminals}
            activeTerminalId={activeTerminalId}
            onActiveTerminalId={setActiveTerminalId}
            onAddTerminal={onAddTerminal}
          />
        )}
      </main>

      {dockPane && meta && (
        <DockPane
          pane={dockPane}
          title={meta.title}
          subtitle={meta.subtitle}
          onClose={closeDockPane}
        >
          {dockPane === "new" && (
            <NewMachinePane
              onLaunchItem={onLaunchGalleryItem}
              onBrowseAll={() => setDockPane("gallery")}
              onApplyDescriptor={applyDescriptor}
            />
          )}
          {dockPane === "gallery" && (
            <Gallery
              compact
              onLaunch={onLaunchGalleryItem}
              onShare={onShareGalleryItem}
            />
          )}
          {dockPane === "config" && (
            <Config onApplied={closeDockPane} />
          )}
          {dockPane === "share" && (
            <SharePanel
              embedded
              descriptor={shareTarget ?? undefined}
              presetId={shareTarget ? shareTarget.id : desc.id}
              onClose={closeDockPane}
            />
          )}
        </DockPane>
      )}

      <Dock
        activePane={dockPane}
        activeView={isEmpty ? null : surface.activeView}
        status={surface.status}
        machineTitle={desc.title}
        viewDisabled={{
          demo: !surface.canOpenDemo,
          terminal: !surface.canUseTerminal,
          internals: !surface.canUseInternals,
        }}
        onSelectPane={selectDockPane}
        onSelectView={selectMachineView}
      />
    </div>
  );
};
