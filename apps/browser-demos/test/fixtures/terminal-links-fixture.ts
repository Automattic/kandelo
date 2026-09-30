/**
 * Mount the real Shell pane against a fake KernelHost so a browser test can
 * push bytes into xterm.js and click the links it produces.
 *
 * Nothing about the link path is stubbed: this is the shipped `Shell`, the
 * shipped `registerTerminalLinks` wiring, and a real xterm.js buffer. Only the
 * kernel underneath the PTY is fake, because the link policy does not depend
 * on it.
 */
import * as React from "react";
import * as ReactDOM from "react-dom/client";

import { KernelHostProvider } from "../../pages/kandelo/kernel-host/react";
import { Shell } from "../../pages/kandelo/panes/Shell";
import type {
  KernelHost,
  PtyHandle,
  WebPreviewState,
} from "../../../../web-libs/kandelo-session/src/kernel-host";

export interface TerminalLinkFixture {
  /** Write bytes into the PTY as if a program had printed them. */
  write(text: string): Promise<void>;
  /** Viewport rectangle of a 0-based terminal row, or null if not rendered. */
  rowRect(row: number): { x: number; y: number; width: number; height: number } | null;
  unmount(): void;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function mountLinkShell(
  container: HTMLElement,
  webPreview: WebPreviewState | null,
): TerminalLinkFixture {
  let emit: ((bytes: Uint8Array) => void) | null = null;
  const pty: PtyHandle = {
    close() {},
    onData: (cb: (bytes: Uint8Array) => void) => {
      emit = cb;
      return () => {
        emit = null;
      };
    },
    resize() {},
    write() {},
  };
  const host = {
    attachPty: () => Promise.resolve(pty),
    getStatus: () => "running",
    subscribeStatus: () => () => {},
    getWebPreview: () => webPreview,
    subscribeWebPreview: () => () => {},
  } as unknown as KernelHost;

  const root = ReactDOM.createRoot(container);
  root.render(
    React.createElement(
      KernelHostProvider,
      { host },
      React.createElement(Shell, { autoFocus: false }),
    ),
  );

  return {
    async write(text: string) {
      // React has to commit, the Shell effect has to attach the PTY, and xterm
      // has to render the bytes; two frames after a microtask drain covers all
      // three reliably enough for a test that then polls for the row.
      for (let attempt = 0; attempt < 200 && !emit; attempt++) await nextFrame();
      if (!emit) throw new Error("PTY never attached");
      emit(new TextEncoder().encode(text));
      await nextFrame();
      await nextFrame();
    },
    rowRect(row: number) {
      const rows = container.querySelectorAll(".xterm-rows > div");
      const target = rows[row];
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    },
    unmount: () => root.unmount(),
  };
}
