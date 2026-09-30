/**
 * SYN_REPORT frame batching for the host→worker input path.
 *
 * Linux evdev closes every logical event with `EV_SYN`/`SYN_REPORT`, and
 * `BrowserInputSource` follows that convention. Delivering each record to
 * the kernel worker individually costs one `postMessage`, one kernel
 * entry, and one full pending-reader wake scan *per record* — and a
 * single pointer move emits three (REL_X, REL_Y, SYN_REPORT). Batching a
 * whole frame into one crossing collapses that to one message, one entry,
 * and one wake scan per frame.
 */
import type { InputEvent } from "./input-source.js";

const EV_SYN = 0x00;
const SYN_REPORT = 0x00;

/**
 * Wrap a batch sink into a per-event dispatch callback that groups records
 * by SYN_REPORT frame. Records accumulate until the terminating
 * `EV_SYN`/`SYN_REPORT` (inclusive), then the whole frame flushes as one
 * batch.
 *
 * A frame that never terminates is bounded: once `maxBuffered` records
 * accumulate without a `SYN_REPORT`, the partial frame is flushed anyway,
 * so a misbehaving source cannot grow the buffer without limit. The frame
 * is flushed as-is (without a synthesized SYN) — the kernel ring tolerates
 * a SYN-less group, and the next real SYN closes the following frame.
 */
export function batchBySynReport(
  flush: (records: InputEvent[]) => void,
  maxBuffered = 64,
): (ev: InputEvent) => void {
  let frame: InputEvent[] = [];
  return (ev: InputEvent) => {
    frame.push(ev);
    const isSyn = ev.ev_type === EV_SYN && ev.code === SYN_REPORT;
    if (isSyn || frame.length >= maxBuffered) {
      const batch = frame;
      frame = [];
      flush(batch);
    }
  };
}
