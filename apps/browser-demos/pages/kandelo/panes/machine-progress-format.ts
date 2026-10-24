import type { MachineProgress } from "../../../../../web-libs/kandelo-session/src/kernel-host";

export interface FormattedMachineProgress {
  headline: string;
  detail: string;
  /** Null when no total is known; the bar renders indeterminate. */
  percent: number | null;
  /** Spoken form; a bare "+" conveys nothing to a screen reader. */
  valueText: string;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
}

export function formatMachineProgress(
  progress: MachineProgress,
): FormattedMachineProgress {
  const headline = progress.operation === "checkpoint"
    ? progress.label
    : progress.phase === "destroying"
    ? `Unloading ${progress.label}`
    : progress.operation === "download"
    ? `Downloading ${progress.label}`
    : progress.operation === "mount"
    ? `Opening ${progress.label} from OPFS`
    : `Loading ${progress.label}`;
  const percent = progress.total && progress.total > 0
    ? Math.min(100, Math.max(0, (progress.completed / progress.total) * 100))
    : null;

  if (progress.status === "error") {
    return {
      headline,
      detail: progress.error ?? "failed",
      percent,
      valueText: progress.error ?? "failed",
    };
  }

  if (progress.unit === "bytes") {
    if (progress.operation === "mount") {
      const detail = "Reading filesystem metadata and recovering journal; file blocks load on demand";
      return { headline, detail, percent: null, valueText: detail };
    }
    if (progress.operation === "checkpoint" && progress.completed === 0 && progress.total === undefined) {
      return { headline, detail: "Working…", percent: null, valueText: "Working; total not yet known" };
    }
    const detail = progress.total === undefined
      ? humanBytes(progress.completed)
      : `${humanBytes(progress.completed)} / ${humanBytes(progress.total)}`;
    return { headline, detail, percent, valueText: detail };
  }

  if (progress.total === undefined) {
    const detail = progress.completed === 0
      ? "Waiting for guest processes to stop…"
      : `${progress.completed} processes`;
    return { headline, detail, percent, valueText: detail };
  }
  const marker = progress.totalProvisional ? "+" : "";
  return {
    headline,
    detail: `${progress.completed} of ${progress.total}${marker} processes`,
    percent,
    valueText: progress.totalProvisional
      ? `${progress.completed} of at least ${progress.total} processes`
      : `${progress.completed} of ${progress.total} processes`,
  };
}
