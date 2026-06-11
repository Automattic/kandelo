/**
 * `NodeInputSource` — null-source for the Node host. There's no DOM in
 * Node, and the integration tests drive evdev events directly via
 * `kernel.exports.kernel_input_event(…)` instead of synthesising
 * KeyboardEvent / PointerEvent. The host still registers an
 * `InputSource` at boot so the Node-side init path is symmetric with
 * the browser-side one (CLAUDE.md §"Two hosts" — dual-host parity is
 * load-bearing). `start()` and `stop()` are deliberate no-ops; no
 * records are ever emitted through the registered `dispatch` callback.
 */
import type { InputSource, InputEvent } from "./input-source.js";

export class NodeInputSource implements InputSource {
  start(_dispatch: (ev: InputEvent) => void): void {
    /* intentional no-op — tests call kernel_input_event directly */
  }
  stop(): void {
    /* intentional no-op */
  }
}
