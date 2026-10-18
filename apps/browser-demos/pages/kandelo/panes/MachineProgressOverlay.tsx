// One centred, full-page overlay for a whole machine switch: teardown of the
// outgoing machine, then the incoming machine's image load.
//
// Centred on purpose. The bar this replaces rendered inside the primary
// surface slot, so it appeared in whatever pane happened to be mounted and
// read as a stray element in a left-hand column. A machine switch is a
// whole-page event and has to look like one.

import * as React from "react";

import { useMachineProgress } from "../kernel-host/react";
import { formatMachineProgress } from "./machine-progress-format";

export const MachineProgressOverlay: React.FC = () => {
  const progress = useMachineProgress();
  if (progress === null) return null;

  const { headline, detail, percent, valueText } =
    formatMachineProgress(progress);

  return (
    <div
      className={`kmprogress-overlay kmprogress-${progress.status}`}
      role="status"
      aria-live="polite"
    >
      <div className="kmprogress-card">
        <div className="kmprogress-headline">{headline}</div>
        <div
          className={`kmprogress-bar${percent === null ? " indeterminate" : ""}`}
          role="progressbar"
          aria-label={headline}
          {...(percent === null
            ? { "aria-valuetext": valueText }
            : {
              "aria-valuenow": Math.round(percent),
              "aria-valuemin": 0,
              "aria-valuemax": 100,
              "aria-valuetext": valueText,
            })}
        >
          <span style={{ width: percent === null ? "44%" : `${percent}%` }} />
        </div>
        <div className="kmprogress-detail">{detail}</div>
      </div>
    </div>
  );
};
