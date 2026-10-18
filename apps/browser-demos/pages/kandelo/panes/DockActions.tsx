// Image-declared dock buttons (`dockActions` in /etc/kandelo/demo.json) for
// the display panes. Each one replaces the machine's foreground program with
// the image's `restart` command; runDemoDockAction owns how. A menu action
// opens a list instead, and the chosen entry's command runs the same way.

import * as React from "react";
import { createPortal } from "react-dom";
import { useDemoDockActions, useKernelHost, useStatus } from "../kernel-host/react";
import type {
  DemoDockCommandConfig,
  DemoDockMenuActionConfig,
  DemoDockMenuEntryConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";
import {
  dockActionProgramName,
  dockActionProgress,
  followShellOutput,
  runDemoDockAction,
  shellPromptReturned,
  type DockActionPhase,
  type DockActionProgress,
} from "../../../../../web-libs/kandelo-session/src/demo-dock-action";

const PHASE_LABELS: Record<DockActionPhase, string> = {
  stopping: "stopping…",
  starting: "starting…",
  done: "starting…",
};

/** Frames the display must present before the replacement counts as up. */
const FRAMES_UNTIL_RUNNING = 5;

/** Keep only the tail: progress lives at the end of the output. */
const OUTPUT_TAIL_CHARS = 8192;

interface Following {
  label: string;
  progress: DockActionProgress;
}

/**
 * The buttons for the dock and the toasts for the stage. `controls` is null
 * when the machine is not running or its image declares no actions.
 *
 * `frameCount` is the display's presented-frame counter. With one, the
 * command's own status lines are shown on the stage until the display is
 * presenting again, because the stage is dark in between. Without one
 * (null) there is no signal for "running again", so no progress is shown.
 */
export function useDockActions(testIdPrefix: string, frameCount: number | null = null): {
  controls: React.ReactNode;
  toasts: React.ReactNode;
} {
  const host = useKernelHost();
  const status = useStatus();
  const actions = useDemoDockActions();
  const [running, setRunning] = React.useState<{ id: string; phase: DockActionPhase } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [following, setFollowing] = React.useState<Following | null>(null);
  const frameCountRef = React.useRef(frameCount);
  frameCountRef.current = frameCount;
  const baselineRef = React.useRef<number | null>(null);
  const stopFollowingRef = React.useRef<(() => void) | null>(null);

  const stopFollowing = React.useCallback(() => {
    stopFollowingRef.current?.();
    stopFollowingRef.current = null;
    baselineRef.current = null;
    setFollowing(null);
  }, []);
  React.useEffect(() => stopFollowing, [stopFollowing]);

  // The replacement is up once the display has presented a few new frames.
  React.useEffect(() => {
    const baseline = baselineRef.current;
    if (baseline === null || frameCount === null) return;
    if (frameCount - baseline >= FRAMES_UNTIL_RUNNING) stopFollowing();
  }, [frameCount, stopFollowing]);

  // `buttonId` is the dock button that shows the phase: the action's own,
  // or the menu's when the command is one of its entries.
  const run = React.useCallback(async (action: DemoDockCommandConfig, buttonId: string) => {
    if (running !== null) return;
    stopFollowing();
    setError(null);
    setRunning({ id: buttonId, phase: "stopping" });
    const programName = dockActionProgramName(action.restart);
    let output = "";
    try {
      await runDemoDockAction(host, action, {
        onPhase: async (phase) => {
          setRunning({ id: buttonId, phase });
          if (phase !== "starting" || frameCountRef.current === null) return;
          // From here on the stage is dark until the replacement draws.
          baselineRef.current = frameCountRef.current;
          setFollowing({ label: action.label, progress: { status: null, percent: null } });
          stopFollowingRef.current = await followShellOutput(host, (text) => {
            output = (output + text).slice(-OUTPUT_TAIL_CHARS);
            const progress = dockActionProgress(output, programName);
            if (shellPromptReturned(output)) {
              // It exited instead of taking over the display: its last word
              // is the explanation.
              stopFollowing();
              setError(`${action.label}: ${progress.status ?? "the command exited"}`);
              return;
            }
            setFollowing({ label: action.label, progress });
          });
        },
      });
    } catch (err) {
      stopFollowing();
      setError(`${action.label}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(null);
    }
  }, [host, running, stopFollowing]);

  const controls = React.useMemo(() => {
    if (status !== "running" || actions.length === 0) return null;
    const busy = running !== null || following !== null;
    return actions.map((action) => {
      const label = running?.id === action.id ? PHASE_LABELS[running.phase] : action.label;
      if ("menu" in action) {
        return (
          <DockMenu
            key={action.id}
            action={action}
            label={label}
            testIdPrefix={testIdPrefix}
            disabled={busy}
            onPick={(entry) => void run(entry, action.id)}
          />
        );
      }
      return (
        <button
          key={action.id}
          type="button"
          className="kdemo-surface-action"
          data-testid={`${testIdPrefix}-dock-action-${action.id}`}
          title={action.description}
          disabled={busy}
          onClick={() => void run(action, action.id)}
        >
          {label}
        </button>
      );
    });
  }, [actions, following, run, running, status, testIdPrefix]);

  const toasts = (
    <>
      {following && (
        <div
          className="kdemo-toast kdemo-progress"
          data-testid={`${testIdPrefix}-dock-action-progress`}
          role="status"
          aria-live="polite"
        >
          <span className="kdemo-progress-text">
            <span className="kdemo-progress-label">{following.label}</span>
            <span data-testid={`${testIdPrefix}-dock-action-status`}>
              {following.progress.status ?? "starting…"}
              {following.progress.percent !== null && ` ${Math.floor(following.progress.percent)}%`}
            </span>
          </span>
          {following.progress.percent !== null && (
            <progress
              className="kdemo-progress-bar"
              max={100}
              value={following.progress.percent}
            />
          )}
        </div>
      )}
      {error && running === null && !following && (
        <div
          className="kdemo-toast"
          data-error="true"
          data-testid={`${testIdPrefix}-dock-action-error`}
          role="alert"
        >
          {error}
          <button
            type="button"
            className="kdemo-toast-dismiss"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
    </>
  );

  return { controls, toasts };
}

/**
 * A dock button that opens its action's entries above the dock. Entries an
 * image declares `unavailable` stay listed, disabled, with the reason: the
 * gap is part of what the machine can and cannot do.
 *
 * The list renders into document.body, fixed above the button: the dock's
 * control row clips what overflows it, and the stage above the dock (whose
 * canvas takes the pointer) would cover a list positioned inside the dock.
 */
function DockMenu({
  action,
  label,
  testIdPrefix,
  disabled,
  onPick,
}: {
  action: DemoDockMenuActionConfig;
  label: string;
  testIdPrefix: string;
  disabled: boolean;
  onPick: (entry: DemoDockCommandConfig) => void;
}): React.ReactElement {
  const [anchor, setAnchor] = React.useState<{ right: number; bottom: number } | null>(null);
  const open = anchor !== null;
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const setOpen = React.useCallback((next: boolean) => {
    const rect = buttonRef.current?.getBoundingClientRect();
    setAnchor(next && rect
      ? { right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.top + 6 }
      : null);
  }, []);
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !listRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    // The list is placed for the button's position when it opened.
    const onResize = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open, setOpen]);
  React.useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled, setOpen]);

  const pick = (entry: DemoDockMenuEntryConfig) => {
    if (!("restart" in entry)) return;
    setOpen(false);
    onPick({ id: entry.id, label: entry.label, restart: entry.restart });
  };

  return (
    <span className="kdemo-dock-menu">
      <button
        ref={buttonRef}
        type="button"
        className="kdemo-surface-action"
        data-testid={`${testIdPrefix}-dock-action-${action.id}`}
        title={action.description}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {label} ▾
      </button>
      {anchor !== null && createPortal(
        <div
          ref={listRef}
          className="kdemo-dock-menu-list"
          style={{ right: anchor.right, bottom: anchor.bottom }}
          role="menu"
          aria-label={action.label}
          data-testid={`${testIdPrefix}-dock-menu-${action.id}`}
        >
          {action.menu.map((entry, index) => {
            const group = entry.group !== undefined
              && entry.group !== action.menu[index - 1]?.group
              ? entry.group
              : null;
            const unavailable = "unavailable" in entry ? entry.unavailable : null;
            return (
              <React.Fragment key={entry.id}>
                {group !== null && <div className="kdemo-dock-menu-group">{group}</div>}
                <button
                  type="button"
                  role="menuitem"
                  className="kdemo-dock-menu-item"
                  data-testid={`${testIdPrefix}-dock-menu-entry-${entry.id}`}
                  disabled={unavailable !== null}
                  title={unavailable ?? undefined}
                  onClick={() => pick(entry)}
                >
                  <span className="kdemo-dock-menu-label">{entry.label}</span>
                  <span className="kdemo-dock-menu-detail">
                    {unavailable !== null ? "unavailable" : entry.detail}
                  </span>
                  {unavailable !== null && (
                    <span className="kdemo-dock-menu-reason">{unavailable}</span>
                  )}
                </button>
              </React.Fragment>
            );
          })}
        </div>,
        document.body,
      )}
    </span>
  );
}
