// Progress of the root VFS image load, shown while a machine boots.
//
// This lives beside the primary surface in MachineView rather than inside any
// one pane: which pane is mounted during boot is chosen per demo by
// `presentation.bootPrimary` (syslog for most), so a bar attached to a single
// pane would be invisible for every demo that does not select it.
//
// It measures bytes materialized, not bytes off the network: a service worker
// serves shipped images cache-first, so a warm cache fills it almost at once.
// That is still the wait the user experiences, which is why the label reads
// "loading" rather than "downloading".

import * as React from "react";

import { useBootProgress } from "../kernel-host/react";
import type { BootProgress } from "../../../../../web-libs/kandelo-session/src/kernel-host";

export const BootProgressBar: React.FC = () => {
  const progress = useBootProgress();
  if (progress === null) return null;
  return <BootProgressBarView progress={progress} />;
};

const BootProgressBarView: React.FC<{ progress: BootProgress }> = ({
  progress,
}) => {
  const pct = progress.totalBytes && progress.totalBytes > 0
    ? Math.min(100, Math.max(0, (progress.loadedBytes / progress.totalBytes) * 100))
    : null;
  const detail = progress.status === "error"
    ? progress.error ?? "failed"
    : `${humanBytes(progress.loadedBytes)}${
      progress.totalBytes ? ` / ${humanBytes(progress.totalBytes)}` : ""
    }`;

  return (
    <div className={`kpreboot-progress kpreboot-progress-${progress.status}`}>
      <div className="kpreboot-progress-top">
        <span>loading {progress.label}</span>
        <span className="kpreboot-progress-detail">
          {progress.status === "error"
            ? "ERR"
            : pct === null
            ? "..."
            : `${Math.round(pct)}%`}
        </span>
      </div>
      <div
        className={`kpreboot-bar${pct === null ? " indeterminate" : ""}`}
        role="progressbar"
        aria-label={`Loading ${progress.label}`}
        {...(pct === null
          ? { "aria-valuetext": detail }
          : {
            "aria-valuenow": Math.round(pct),
            "aria-valuemin": 0,
            "aria-valuemax": 100,
          })}
      >
        <span style={{ width: pct === null ? "44%" : `${pct}%` }} />
      </div>
      <div className="kpreboot-progress-detail">{detail}</div>
    </div>
  );
};

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
}
