// An icon-only dock button with a tooltip naming what it does.
//
// The dock clips its own overflow (it animates its height), so a tooltip
// drawn inside it would be cut off. The tooltip is portaled to <body> and
// placed above the button from its on-screen box instead. The button's
// accessible name is its aria-label; the tooltip repeats it for pointer and
// keyboard users, so it is hidden from assistive technology.

import * as React from "react";
import { createPortal } from "react-dom";

export const DockIconButton: React.FC<{
  label: string;
  icon: React.ReactNode;
  testId?: string;
  disabled?: boolean;
  /** Marks a button whose action is the machine's current state. */
  active?: boolean;
  onClick: () => void;
}> = ({ label, icon, testId, disabled = false, active = false, onClick }) => {
  const wrapRef = React.useRef<HTMLSpanElement>(null);
  const [tip, setTip] = React.useState<{ x: number; y: number } | null>(null);

  const show = React.useCallback(() => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (box) setTip({ x: box.left + box.width / 2, y: box.top });
  }, []);
  const hide = React.useCallback(() => setTip(null), []);

  // A disabled button receives no pointer events, so the wrapper listens;
  // a disabled control still says what it would do.
  return (
    <span
      ref={wrapRef}
      className="kfb-icon-wrap"
      onPointerEnter={(event) => { if (event.pointerType !== "touch") show(); }}
      onPointerLeave={hide}
    >
      <button
        type="button"
        className="kfb-icon-btn"
        aria-label={label}
        data-testid={testId}
        data-active={active ? "true" : "false"}
        disabled={disabled}
        onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) show(); }}
        onBlur={hide}
        onClick={() => { hide(); onClick(); }}
      >
        {icon}
      </button>
      {tip && createPortal(
        <div
          className="kdock-tooltip"
          aria-hidden="true"
          style={{ left: tip.x, top: tip.y }}
        >
          {label}
        </div>,
        document.body,
      )}
    </span>
  );
};

export const SaveStateIcon = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 2.5h8l2.5 2.5v8.5H3z" />
    <path d="M5.5 2.5v3h5v-3M5.5 13.5V9.5h5v4" />
  </svg>
);

export const ResetIcon = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3.2 8a4.8 4.8 0 1 0 1.4-3.4" />
    <path d="M3 2.5v2.6h2.6" />
  </svg>
);

export const PowerIcon = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2v5.5" />
    <path d="M4.6 4.3a5 5 0 1 0 6.8 0" />
  </svg>
);
