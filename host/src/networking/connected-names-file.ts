import type { NetworkIO } from "../types";
import { validateDnsHostname } from "./hostname";

export const CONNECTED_NAMES_PATH = "/run/kandelo/hosts-connected";

/** Implemented by the dedicated kernel worker, not a host filesystem. */
export interface ConnectedNamesFileStorage {
  rootfsStat(path: string): { mode: number; uid: number; gid: number };
  rootfsWriteFile(path: string, data: Uint8Array, mode: number): void;
  rootfsRenameFile(from: string, to: string): void;
  rootfsUnlinkFile(path: string): boolean;
}

function serializeNames(network: NetworkIO): string {
  const entries = network.connectedComputerNames?.() ?? [];
  const byName = new Map(entries.map((entry) => [entry.hostname, entry]));
  const groups = new Map<string, Set<string>>();
  for (const { canonicalName, hostname, address } of entries) {
    // Never let aliases inject hosts records, comments or line breaks.
    validateDnsHostname(hostname);
    validateDnsHostname(canonicalName);
    if (address.length !== 4) throw new Error("Connected name has no IPv4 address");
    const numeric = Array.from(address).join(".");
    // A shadowed canonical name must not reappear as a second address for
    // that name. In that case publish only the actual surviving alias.
    const canonical = byName.get(canonicalName);
    const primary = canonical && Array.from(canonical.address).join(".") === numeric
      ? canonicalName : hostname;
    const key = `${numeric}\t${primary}`;
    let aliases = groups.get(key);
    if (aliases === undefined) { aliases = new Set(); groups.set(key, aliases); }
    if (hostname !== primary) aliases.add(hostname);
  }
  return [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, aliases]) => `${key}${[...aliases].sort().map((name) => ` ${name}`).join("")}\n`).join("");
}

/**
 * Publish complete membership snapshots through the normal kernel VFS.
 * Source notifications only schedule work; no VFS entry occurs in a network
 * callback. Revisions and disposal revoke queued/staged publications.
 */
export class ConnectedNamesFile {
  private revision = 0;
  private closed = false;
  private pending: Promise<void> | undefined;
  private stopNames: (() => void) | undefined;
  private published: string | undefined;
  private failure: { error: unknown } | undefined;

  constructor(
    private readonly storage: ConnectedNamesFileStorage,
    private readonly network: NetworkIO,
    private readonly reportFailure: (error: unknown) => void,
  ) {}

  async start(): Promise<void> {
    if (this.stopNames !== undefined || this.closed) throw new Error("Name publisher cannot be restarted");
    this.stopNames = this.network.onConnectedComputerNamesChanged?.(() => this.update()) ?? (() => {});
    await this.ready();
  }

  /** A successful response means the current membership, not just routing, is published. */
  async ready(): Promise<void> {
    if (this.closed) throw new Error("Name publisher is closed");
    this.update();
    while (this.pending !== undefined) await this.pending;
    if (this.closed) throw new Error("Name publisher is closed");
    if (this.failure !== undefined) throw this.failure.error;
  }

  private update(): void {
    if (this.closed) return;
    this.revision++;
    if (this.pending !== undefined) return;
    this.pending = Promise.resolve().then(() => {
      this.pending = undefined;
      if (this.closed) return;
      const revision = this.revision;
      const staged = `${CONNECTED_NAMES_PATH}.staged-${revision}`;
      let stageAttempted = false;
      try {
        const contents = serializeNames(this.network);
        if (contents === this.published && this.failure === undefined) return;
        // /run and /run/kandelo are native boot namespaces. Refuse an unsafe
        // or missing namespace instead of writing through a guest-owned path.
        for (const path of ["/run", "/run/kandelo"]) {
          const stat = this.storage.rootfsStat(path);
          if ((stat.mode & 0o170000) !== 0o040000 || stat.uid !== 0 || stat.gid !== 0 ||
              (stat.mode & 0o777) !== 0o755) {
            throw new Error(`Unsafe connected-name directory: ${path}`);
          }
        }
        stageAttempted = true;
        this.storage.rootfsWriteFile(staged, new TextEncoder().encode(contents), 0o644);
        if (this.closed || revision !== this.revision) return;
        this.storage.rootfsRenameFile(staged, CONNECTED_NAMES_PATH);
        stageAttempted = false; // The staged name was consumed by rename.
        this.published = contents;
        this.failure = undefined;
      } catch (error) {
        this.failure = { error };
        this.reportFailure(error);
      } finally {
        if (stageAttempted) {
          try { this.storage.rootfsUnlinkFile(staged); }
          catch (error) { this.failure = { error }; this.reportFailure(error); }
        }
      }
    });
  }

  /** Called before network/kernel disposal; a queued old generation cannot commit. */
  close(): void {
    this.closed = true;
    this.revision++;
    this.stopNames?.(); this.stopNames = undefined;
  }
}
