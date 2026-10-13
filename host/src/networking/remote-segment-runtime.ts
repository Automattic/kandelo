import type { NetworkIO } from "../types";
import { RemoteVirtualNetwork, type RemoteSegmentSnapshot } from "./remote-segment";
import { RemoteSegmentPortTransport, type RemoteSegmentInit, type RemoteSegmentPeer } from "./remote-segment-port";

/** Worker-owned lifecycle shared by the Node and browser kernel entries. */
export class RemoteSegmentRuntime {
  private segment?: RemoteVirtualNetwork;

  async initialize(config: RemoteSegmentInit, fallback?: NetworkIO): Promise<NetworkIO> {
    if (this.segment) throw new Error("a remote segment is already configured");
    if (!config || (config.role !== "host" && config.role !== "joiner")) throw new Error("invalid remote segment role");
    const segment = new RemoteVirtualNetwork(config.role, fallback);
    this.segment = segment;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (config.role === "joiner") segment.attachPeer(new RemoteSegmentPortTransport(config.peer));
      // Do not instantiate the kernel with an unassigned interface. The same
      // bound applies on both hosts; ICE already succeeded before port setup.
      await Promise.race([
        segment.ready,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("the forwarding host did not assign a remote segment address within 30 seconds")), 30_000);
        }),
      ]);
      return segment;
    } catch (error) {
      this.close();
      throw error;
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }

  attachPeer(peer: RemoteSegmentPeer): number {
    if (!this.segment || this.segment.role !== "host") {
      peer.port.close();
      throw new Error("only an initialized forwarding host can attach remote peers");
    }
    let transport: RemoteSegmentPortTransport | undefined;
    try {
      transport = new RemoteSegmentPortTransport(peer);
      return this.segment.attachPeer(transport);
    } catch (error) {
      if (transport) transport.close(); else peer.port.close();
      throw error;
    }
  }

  snapshot(): RemoteSegmentSnapshot {
    if (!this.segment) throw new Error("this machine has no remote segment");
    return this.segment.snapshot();
  }

  close(): void { this.segment?.close(); this.segment = undefined; }
}
