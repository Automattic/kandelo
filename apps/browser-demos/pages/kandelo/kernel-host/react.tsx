// React glue around the KernelHost interface. The Kandelo UI's only
// dependency on the host is via these hooks — never reach for kernel
// objects directly inside a component.
//
// Provider lives at the App root; every pane downstream reads through
// `useKernelHost()`. Status/dmesg/snapshot hooks subscribe + manage their
// own state buckets so components only re-render when their slice changes.

import * as React from "react";
import type {
  KernelHost, MachineStatus, DmesgLine, Snapshot, WebPreviewState, DemoPresentation,
  SurfaceAvailability, GalleryItem, GalleryTab,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { DemoGuideConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";

const KernelHostContext = React.createContext<KernelHost | null>(null);

export const KernelHostProvider: React.FC<{
  host: KernelHost;
  children: React.ReactNode;
}> = ({ host, children }) =>
  <KernelHostContext.Provider value={host}>{children}</KernelHostContext.Provider>;

export function useKernelHost(): KernelHost {
  const host = React.useContext(KernelHostContext);
  if (!host) {
    throw new Error("useKernelHost() called outside <KernelHostProvider>");
  }
  return host;
}

export function useStatus(): MachineStatus {
  const host = useKernelHost();
  const [s, setS] = React.useState<MachineStatus>(() => host.getStatus());
  React.useEffect(() => host.subscribeStatus(setS), [host]);
  return s;
}

export function useDmesg(): DmesgLine[] {
  const host = useKernelHost();
  const [lines, setLines] = React.useState<DmesgLine[]>(() => host.dmesgHistory());
  React.useEffect(() => {
    setLines(host.dmesgHistory());
    return host.subscribeDmesg((line) => {
      setLines((prev) => [...prev, line]);
    });
  }, [host]);
  return lines;
}

/**
 * Re-runs `host.snapshot()` whenever status changes. Returns null until the
 * first snapshot resolves.
 */
export function useSnapshot(): Snapshot | null {
  const host = useKernelHost();
  const status = useStatus();
  const [snap, setSnap] = React.useState<Snapshot | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void host.snapshot().then((s) => { if (!cancelled) setSnap(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, [host, status]);
  return snap;
}

export function useWebPreview(): WebPreviewState | null {
  const host = useKernelHost();
  const status = useStatus();
  const [state, setState] = React.useState<WebPreviewState | null>(() => host.getWebPreview());
  React.useEffect(() => {
    setState(host.getWebPreview());
    return host.subscribeWebPreview(setState);
  }, [host, status]);
  return state;
}

export function usePresentation(): DemoPresentation {
  const host = useKernelHost();
  const [state, setState] = React.useState<DemoPresentation>(() => host.getPresentation());
  React.useEffect(() => {
    setState(host.getPresentation());
    return host.subscribePresentation(setState);
  }, [host]);
  return state;
}

export function useSurfaceAvailability(): SurfaceAvailability {
  const host = useKernelHost();
  const [state, setState] = React.useState<SurfaceAvailability>(() => host.getSurfaceAvailability());
  React.useEffect(() => {
    setState(host.getSurfaceAvailability());
    return host.subscribeSurfaceAvailability(setState);
  }, [host]);
  return state;
}

export function useDemoGuide(): DemoGuideConfig | null {
  const host = useKernelHost();
  const [state, setState] = React.useState<DemoGuideConfig | null>(() => host.getDemoGuide());
  React.useEffect(() => {
    setState(host.getDemoGuide());
    return host.subscribeDemoGuide(setState);
  }, [host]);
  return state;
}

export function useGalleryItems(tab: GalleryTab = "presets"): {
  items: GalleryItem[];
  loading: boolean;
} {
  const host = useKernelHost();
  const [items, setItems] = React.useState<GalleryItem[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    const load = () => {
      setLoading(true);
      void host.galleryQuery({ tab }).then(
        (result) => {
          if (cancelled) return;
          setItems(result);
          setLoading(false);
        },
        () => {
          if (cancelled) return;
          setItems([]);
          setLoading(false);
        },
      );
    };
    load();
    const off = host.subscribeGallery(load);
    return () => {
      cancelled = true;
      off();
    };
  }, [host, tab]);

  return { items, loading };
}
