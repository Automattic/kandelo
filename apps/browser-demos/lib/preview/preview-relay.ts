/**
 * The Kandelo page's end of the preview relay: one hidden, sandboxed
 * preview-origin frame per tab, created on first use and kept across machine
 * switches. It registers the preview service worker in the tab's storage
 * partition and moves each machine's bridge port to it.
 *
 * TRUST: every message from the relay is preview-origin input. A guest page
 * on the preview origin can script the relay's window (same origin), so it
 * can forge any relay message. Nothing here grants more than a guest could
 * already do on its own origin: a forged `preview-need-bridge` makes the
 * owner bind its machine again (with its secret, to the same worker), and a
 * forged machine status only makes an owner check its own port or a viewer
 * take its frame down. Those two name a machine only by
 * `machineNameHash`, since every relay hears them.
 *
 * SECRETS: `bind` and `closing` send the machine's secret to this tab's
 * relay frame, which forwards it to the preview service worker. A guest page
 * framed in this same tab can script that relay frame and read it; nothing
 * outside this tab can (the relay never stores, broadcasts or echoes it).
 * See docs/browser-support.md, "Guest web previews run on their own origin".
 */
import {
  PREVIEW_PROTOCOL_VERSION,
  PREVIEW_RELAY_SANDBOX,
  MACHINE_NAME_HASH_PATTERN,
  isMachineName,
  machineNameHash,
  previewRelayUrl,
  type PreviewRefusalCode,
} from "./protocol";
import { configuredPreviewRelayPath } from "./config";

const RELAY_READY_TIMEOUT_MS = 20_000;
const BIND_TIMEOUT_MS = 10_000;

export class PreviewBindRefused extends Error {
  constructor(readonly code: PreviewRefusalCode, name: string) {
    super(`The preview origin refused machine ${name}: ${code}`);
  }
}

export type PreviewMachineStatus = "offline";
type StatusListener = (status: PreviewMachineStatus) => void;

const relays = new Map<string, PreviewRelay>();

/**
 * What the pane says when the relay could not register the preview worker.
 *
 * The Service Workers spec rejects a registration lookup or `register()`
 * with `SecurityError` when the browser will not give the calling origin
 * storage (obtaining its storage key fails). Its other `SecurityError` cases
 * (an untrustworthy or foreign script URL or scope) cannot arise for the
 * relay, which registers its own origin's worker for its own directory; an
 * insecure context has no `navigator.serviceWorker` and fails earlier with
 * its own message. Measured: Firefox with "All cross-site cookies" blocked
 * (`network.cookie.cookieBehavior=1`) denies every third-party frame
 * storage, so the relay fails this way ("The operation is insecure.")
 * whenever the preview origin is on another site than Kandelo
 * (`test/preview-storage-blocked.spec.ts`). That is a setting the user or
 * the deployer can change, so name the origin and both remedies, and keep
 * the browser's own words. The relay reports the exception's name; nothing
 * here guesses from the user agent. A guest page can forge a relay message
 * and gains nothing by this one: it only settles a relay not yet started.
 */
export function relayFailureMessage(previewOrigin: string, error: string, errorName: string): string {
  if (errorName === "SecurityError") {
    return `This browser blocks storage for the preview origin ${previewOrigin}, so web previews can't start. ` +
      `Allow cookies and site data for ${previewOrigin}, or use a Kandelo deployment whose preview origin ` +
      `is on the same site as Kandelo. (The browser said: ${error})`;
  }
  return `The preview origin could not start: ${error}`;
}

export class PreviewRelay {
  /** The tab's relay for this preview origin and scope, created on first use. */
  static forPage(previewOrigin: string, scope: string): PreviewRelay {
    const key = `${previewOrigin}${scope}`;
    let relay = relays.get(key);
    if (!relay) {
      relay = new PreviewRelay(previewOrigin, scope);
      relays.set(key, relay);
    }
    return relay;
  }

  private readonly frame: HTMLIFrameElement;
  private readonly readyPromise: Promise<void>;
  private settleReady!: (error?: Error) => void;
  private readonly binds = new Map<string, {
    seq: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: number;
  }>();
  private readonly needBridge = new Map<string, () => void>();
  private readonly statusListeners = new Map<string, Set<StatusListener>>();
  /** name -> machineNameHash(name), for the names this tab listens for. */
  private readonly nameHashes = new Map<string, Promise<string>>();
  private readonly workerChangeListeners = new Set<() => void>();

  private constructor(readonly previewOrigin: string, readonly scope: string) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.settleReady(new Error(
          `The preview origin ${previewOrigin} did not answer; web previews are unavailable.`,
        ));
      }, RELAY_READY_TIMEOUT_MS);
      let settled = false;
      this.settleReady = (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
    });
    // A rejection with no waiter yet must not surface as an unhandled one.
    this.readyPromise.catch(() => {});
    window.addEventListener("message", this.onMessage);
    this.frame = document.createElement("iframe");
    this.frame.className = "kpreview-relay";
    this.frame.title = "Kandelo preview relay";
    this.frame.hidden = true;
    this.frame.tabIndex = -1;
    this.frame.setAttribute("aria-hidden", "true");
    this.frame.setAttribute("sandbox", PREVIEW_RELAY_SANDBOX);
    // The relay learns which Kandelo origin embeds it from document.referrer
    // and checks it against its build-time allow list.
    this.frame.referrerPolicy = "origin";
    this.frame.src = previewRelayUrl(previewOrigin, scope, configuredPreviewRelayPath());
    document.body.append(this.frame);
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Bind `name` to `port` in the preview service worker. `secret` proves
   * this tab owns the name; the worker replaces any port it held for it,
   * unless it already accepted a bind or closing with a larger `seq`.
   * Only the answer carrying this bind's `seq` settles it.
   */
  async bind(name: string, secret: string, port: MessagePort, seq: number): Promise<void> {
    await this.ready();
    const target = this.frame.contentWindow;
    if (!target) throw new Error("The preview relay frame is gone");
    this.binds.get(name)?.reject(new Error(`Machine ${name} was bound again`));
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.binds.delete(name);
        reject(new Error(`The preview origin did not confirm machine ${name}`));
      }, BIND_TIMEOUT_MS);
      this.binds.set(name, { seq, resolve, reject, timer });
      target.postMessage(
        { type: "preview-bridge", v: PREVIEW_PROTOCOL_VERSION, name, secret, seq },
        this.previewOrigin,
        [port],
      );
    });
  }

  /** Tell the preview service worker this tab no longer serves `name`. */
  closing(name: string, secret: string, seq: number): void {
    this.frame.contentWindow?.postMessage(
      { type: "preview-machine-closing", v: PREVIEW_PROTOCOL_VERSION, name, secret, seq },
      this.previewOrigin,
    );
  }

  /** The preview origin's active service worker changed; it holds no ports. */
  onWorkerChanged(listener: () => void): () => void {
    this.workerChangeListeners.add(listener);
    return () => this.workerChangeListeners.delete(listener);
  }

  /** Only the owner of `name` registers; it answers with a fresh port. */
  onNeedBridge(name: string, handler: () => void): () => void {
    this.needBridge.set(name, handler);
    return () => {
      if (this.needBridge.get(name) === handler) this.needBridge.delete(name);
    };
  }

  /** Status reports for machine `name` (a viewer, or the owner checking its port). */
  onMachineStatus(name: string, listener: StatusListener): () => void {
    let listeners = this.statusListeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.statusListeners.set(name, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.statusListeners.get(name) === listeners) {
        this.statusListeners.delete(name);
      }
    };
  }

  private hashOf(name: string): Promise<string> {
    let hash = this.nameHashes.get(name);
    if (!hash) {
      hash = machineNameHash(name);
      this.nameHashes.set(name, hash);
    }
    return hash;
  }

  /** The names this tab listens for (in `names`) whose hash is `hash`. */
  private async namesWithHash(hash: string, names: Iterable<string>): Promise<string[]> {
    const candidates = [...names];
    const hashes = await Promise.all(candidates.map((name) => this.hashOf(name)));
    return candidates.filter((_name, index) => hashes[index] === hash);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.origin !== this.previewOrigin || event.source !== this.frame.contentWindow) return;
    const message = event.data as Record<string, unknown> | null;
    if (!message || typeof message !== "object" || typeof message.type !== "string") return;
    if (message.v !== PREVIEW_PROTOCOL_VERSION) {
      this.settleReady(new Error(
        `The preview origin speaks preview protocol ${String(message.v)}, ` +
          `this app speaks ${PREVIEW_PROTOCOL_VERSION}; deploy both bundles together.`,
      ));
      return;
    }
    switch (message.type) {
      case "preview-relay-ready":
        this.settleReady();
        return;
      case "preview-relay-failed":
        this.settleReady(new Error(relayFailureMessage(
          this.previewOrigin,
          String(message.error),
          typeof message.errorName === "string" ? message.errorName : "",
        )));
        return;
      case "preview-worker-changed":
        for (const listener of this.workerChangeListeners) listener();
        return;
      case "preview-need-bridge": {
        if (typeof message.nameHash !== "string" || !MACHINE_NAME_HASH_PATTERN.test(message.nameHash)) return;
        void this.namesWithHash(message.nameHash, this.needBridge.keys()).then((names) => {
          for (const name of names) this.needBridge.get(name)?.();
        });
        return;
      }
      case "preview-machine-status": {
        if (message.status !== "offline") return;
        if (typeof message.nameHash !== "string" || !MACHINE_NAME_HASH_PATTERN.test(message.nameHash)) return;
        void this.namesWithHash(message.nameHash, this.statusListeners.keys()).then((names) => {
          for (const name of names) {
            for (const listener of this.statusListeners.get(name) ?? []) listener("offline");
          }
        });
        return;
      }
    }
    if (!isMachineName(message.name)) return;
    const name = message.name;
    switch (message.type) {
      case "preview-bridge-ready": {
        const pending = this.binds.get(name);
        // An answer to an earlier bind of this name says nothing about this one.
        if (!pending || message.seq !== pending.seq) return;
        this.binds.delete(name);
        window.clearTimeout(pending.timer);
        pending.resolve();
        return;
      }
      case "preview-bridge-refused": {
        const pending = this.binds.get(name);
        if (!pending || message.seq !== pending.seq) return;
        this.binds.delete(name);
        window.clearTimeout(pending.timer);
        const code = message.code === "not-owner" || message.code === "version-mismatch" ||
            message.code === "superseded"
          ? message.code
          : "invalid";
        pending.reject(new PreviewBindRefused(code, name));
        return;
      }
    }
  };
}
