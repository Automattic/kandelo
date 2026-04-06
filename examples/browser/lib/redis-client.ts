/**
 * Minimal Redis RESP protocol client for kernel pipe-backed connections.
 *
 * Speaks RESP (REdis Serialization Protocol) over kernel pipes:
 *   - Sends commands as RESP arrays
 *   - Reads responses (simple strings, errors, integers, bulk strings, arrays)
 *
 * Operates entirely over kernel pipe pairs (no real TCP).
 * All pipe operations are async (message round-trip to kernel worker).
 */
import type { BrowserKernel } from "./browser-kernel";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RedisResult {
  type: "string" | "error" | "integer" | "bulk" | "array" | "null";
  value: string | number | null | RedisResult[];
}

/**
 * Redis protocol client that communicates via kernel pipes.
 */
export class RedisBrowserClient {
  private kernel: BrowserKernel;
  private pid: number;
  private recvPipeIdx: number; // write to this to send data to server
  private sendPipeIdx: number; // read from this to get data from server
  private readBuffer = new Uint8Array(0);

  private constructor(
    kernel: BrowserKernel,
    pid: number,
    recvPipeIdx: number,
    sendPipeIdx: number,
  ) {
    this.kernel = kernel;
    this.pid = pid;
    this.recvPipeIdx = recvPipeIdx;
    this.sendPipeIdx = sendPipeIdx;
  }

  /**
   * Connect to Redis on the given port.
   */
  static async connect(
    kernel: BrowserKernel,
    port: number,
  ): Promise<RedisBrowserClient> {
    const target = await kernel.pickListenerTarget(port);
    if (!target) throw new Error("No listener on port " + port);

    const recvPipeIdx = await kernel.injectConnection(
      target.pid,
      target.fd,
    );
    if (recvPipeIdx < 0) throw new Error("Failed to inject connection");

    const sendPipeIdx = recvPipeIdx + 1;
    return new RedisBrowserClient(kernel, target.pid, recvPipeIdx, sendPipeIdx);
  }

  /**
   * Send a Redis command and read the response.
   */
  async command(...args: string[]): Promise<RedisResult> {
    // Build RESP array: *<count>\r\n$<len>\r\n<arg>\r\n...
    let cmd = `*${args.length}\r\n`;
    for (const arg of args) {
      const bytes = encoder.encode(arg);
      cmd += `$${bytes.length}\r\n${arg}\r\n`;
    }

    // Send command
    await this.kernel.pipeWrite(this.pid, this.recvPipeIdx, encoder.encode(cmd));
    this.kernel.wakeBlockedReaders(this.recvPipeIdx);

    // Read response
    return await this.readResponse();
  }

  /**
   * Format a result for display.
   */
  static formatResult(result: RedisResult): string {
    if (result.type === "null") return "(nil)";
    if (result.type === "error") return `(error) ${result.value}`;
    if (result.type === "integer") return `(integer) ${result.value}`;
    if (result.type === "string" || result.type === "bulk") {
      return `"${result.value}"`;
    }
    if (result.type === "array") {
      const items = result.value as RedisResult[];
      if (items.length === 0) return "(empty array)";
      return items
        .map((item, i) => `${i + 1}) ${RedisBrowserClient.formatResult(item)}`)
        .join("\n");
    }
    return String(result.value);
  }

  private async readResponse(): Promise<RedisResult> {
    // Read until we have at least the type byte + line
    const line = await this.readLine();
    const type = line[0];
    const data = line.slice(1);

    switch (type) {
      case "+": // Simple string
        return { type: "string", value: data };
      case "-": // Error
        return { type: "error", value: data };
      case ":": // Integer
        return { type: "integer", value: parseInt(data, 10) };
      case "$": { // Bulk string
        const len = parseInt(data, 10);
        if (len === -1) return { type: "null", value: null };
        const bulk = await this.readExact(len);
        await this.readExact(2); // consume \r\n
        return { type: "bulk", value: decoder.decode(bulk) };
      }
      case "*": { // Array
        const count = parseInt(data, 10);
        if (count === -1) return { type: "null", value: null };
        const items: RedisResult[] = [];
        for (let i = 0; i < count; i++) {
          items.push(await this.readResponse());
        }
        return { type: "array", value: items };
      }
      default:
        throw new Error(`Unknown RESP type: ${type}`);
    }
  }

  private async readLine(): Promise<string> {
    // Read until \r\n
    while (true) {
      const idx = this.findCRLF();
      if (idx >= 0) {
        const line = decoder.decode(this.readBuffer.slice(0, idx));
        this.readBuffer = this.readBuffer.slice(idx + 2);
        return line;
      }
      await this.fillBuffer();
    }
  }

  private async readExact(n: number): Promise<Uint8Array> {
    while (this.readBuffer.length < n) {
      await this.fillBuffer();
    }
    const result = this.readBuffer.slice(0, n);
    this.readBuffer = this.readBuffer.slice(n);
    return result;
  }

  private findCRLF(): number {
    for (let i = 0; i < this.readBuffer.length - 1; i++) {
      if (this.readBuffer[i] === 0x0d && this.readBuffer[i + 1] === 0x0a) {
        return i;
      }
    }
    return -1;
  }

  private async fillBuffer(): Promise<void> {
    // Poll for data from the kernel pipe
    for (let attempt = 0; attempt < 200; attempt++) {
      const data = await this.kernel.pipeRead(this.pid, this.sendPipeIdx);
      if (data && data.length > 0) {
        const merged = new Uint8Array(this.readBuffer.length + data.length);
        merged.set(this.readBuffer);
        merged.set(data, this.readBuffer.length);
        this.readBuffer = merged;
        return;
      }
      // Give event loop a chance to process
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Timeout reading from Redis");
  }
}
