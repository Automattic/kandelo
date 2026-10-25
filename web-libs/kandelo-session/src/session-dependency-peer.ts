import { MAX_DEPENDENCY_BYTES, verifyDependency, type OfferedDependency } from "./session-dependencies";

export const DEPENDENCY_CHANNEL = "activity-data-v1";
const CHUNK = 16 * 1024;
/** One requested chunk at a time bounds both RTC buffering and receiver allocation. */
export class SessionDependencyPeer {
  private pending: { handshake: boolean; resolve(value: ArrayBuffer | string): void; reject(error: Error): void } | null = null;
  private disposed = false;
  private receiving = false;
  constructor(private channel: RTCDataChannel, private shared: () => ReadonlyMap<string, Uint8Array>) {
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", this.message);
    channel.addEventListener("close", this.closed);
  }
  private message = (event: MessageEvent) => {
    if (this.disposed) return;
    if (event.data instanceof ArrayBuffer) {
      if (event.data.byteLength > CHUNK) { this.dispose(); return; }
      this.pending?.resolve(event.data); return;
    }
    if (typeof event.data !== "string" || event.data.length > 1024) { this.dispose(); return; }
    let request: any;
    try { request = JSON.parse(event.data); } catch { this.dispose(); return; }
    if (request?.type === "ready" || request?.type === "error") {
      if (request.type === "error" || this.pending?.handshake) this.pending?.resolve(event.data);
      return;
    }
    if (this.channel.bufferedAmount > CHUNK * 16) { this.dispose(); return; }
    if (request?.type === "hello") { this.channel.send(JSON.stringify({ type: "ready" })); return; }
    if (request?.type !== "read" || typeof request.digest !== "string" || !/^[a-f0-9]{64}$/.test(request.digest)
      || !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset % CHUNK !== 0) { this.dispose(); return; }
    const bytes = this.shared().get(request.digest);
    if (!bytes || request.offset >= bytes.length) { this.channel.send(JSON.stringify({ type: "error" })); return; }
    this.channel.send(bytes.slice(request.offset, request.offset + CHUNK).buffer);
  };
  private closed = () => this.dispose();
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.channel.removeEventListener("message", this.message);
    this.channel.removeEventListener("close", this.closed);
    this.pending?.reject(new Error("The activity data connection closed")); this.pending = null;
  }
  private exchange(request: object, signal: AbortSignal, handshake = false): Promise<ArrayBuffer | string> {
    if (this.disposed || signal.aborted || this.pending) return Promise.reject(new Error("Activity transfer cancelled or busy"));
    return new Promise((resolve, reject) => {
      let retry: ReturnType<typeof setInterval> | undefined;
      const finish = (error: Error | null, value?: ArrayBuffer | string) => {
        clearTimeout(timer); clearInterval(retry); signal.removeEventListener("abort", abort); this.pending = null;
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => finish(new Error("Activity transfer cancelled"));
      const timer = setTimeout(() => finish(new Error("Activity data transfer timed out")), 15_000);
      this.pending = { handshake, resolve: value => finish(null, value), reject: error => finish(error) };
      signal.addEventListener("abort", abort, { once: true });
      const send = () => { try { this.channel.send(JSON.stringify(request)); } catch { finish(new Error("Activity data connection is unavailable")); } };
      if (handshake) retry = setInterval(send, 500);
      send();
    });
  }
  async receive(content: OfferedDependency, signal: AbortSignal, progress: (received: number) => void): Promise<Uint8Array> {
    if (this.receiving || content.size <= 0 || content.size > MAX_DEPENDENCY_BYTES) throw new Error("Invalid or concurrent activity transfer");
    this.receiving = true;
    try {
      const ready = await this.exchange({ type: "hello" }, signal, true);
      if (ready !== JSON.stringify({ type: "ready" })) throw new Error("Activity sender is unavailable");
      const bytes = new Uint8Array(content.size);
      for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        const chunk = await this.exchange({ type: "read", digest: content.sha256, offset }, signal);
        if (!(chunk instanceof ArrayBuffer) || chunk.byteLength !== Math.min(CHUNK, bytes.length - offset)) throw new Error("Activity sender did not provide the required data");
        bytes.set(new Uint8Array(chunk), offset); progress(offset + chunk.byteLength);
      }
      await verifyDependency(bytes, content);
      return bytes;
    } finally { this.receiving = false; }
  }
}
