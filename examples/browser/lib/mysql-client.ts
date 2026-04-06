/**
 * Minimal MySQL wire protocol client for kernel pipe-backed connections.
 *
 * Speaks just enough MySQL/MariaDB protocol to:
 *   1. Read server greeting (Initial Handshake)
 *   2. Send HandshakeResponse (with skip-grant-tables, no password needed)
 *   3. Send COM_QUERY and read result sets
 *
 * Operates entirely over kernel pipe pairs (no real TCP).
 * All pipe operations are async (message round-trip to kernel worker).
 */
import type { BrowserKernel } from "./browser-kernel";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface MySqlColumn {
  name: string;
}

export interface MySqlResult {
  columns: string[];
  rows: string[][];
  affectedRows?: number;
  info?: string;
}

/**
 * MySQL wire protocol client that communicates via kernel pipes.
 */
export class MySqlBrowserClient {
  private kernel: BrowserKernel;
  private pid: number;
  private recvPipeIdx: number; // write to this to send data to server
  private sendPipeIdx: number; // read from this to get data from server
  private seqNum = 0;
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
   * Connect to MariaDB on the given port. Performs the initial handshake.
   */
  static async connect(
    kernel: BrowserKernel,
    port: number,
  ): Promise<MySqlBrowserClient> {
    const target = await kernel.pickListenerTarget(port);
    if (!target) throw new Error("No listener on port " + port);

    const recvPipeIdx = await kernel.injectConnection(
      target.pid,
      target.fd,
      [127, 0, 0, 1],
      Math.floor(Math.random() * 60000) + 1024,
    );
    if (recvPipeIdx < 0) throw new Error("Failed to inject connection");
    const sendPipeIdx = recvPipeIdx + 1;

    kernel.wakeBlockedReaders(recvPipeIdx);

    const client = new MySqlBrowserClient(kernel, target.pid, recvPipeIdx, sendPipeIdx);
    try {
      await client.handshake();
    } catch (e) {
      // Clean up pipe pairs on handshake failure to avoid stale connections
      // accumulating in the accept backlog
      client.close();
      throw e;
    }
    return client;
  }

  /**
   * Execute a SQL query and return the result.
   */
  async query(sql: string): Promise<MySqlResult> {
    this.seqNum = 0;
    const payload = new Uint8Array(1 + encoder.encode(sql).length);
    payload[0] = 0x03; // COM_QUERY
    payload.set(encoder.encode(sql), 1);
    await this.sendPacket(payload);
    this.kernel.wakeBlockedReaders(this.recvPipeIdx);

    const resp = await this.readPacket();
    if (!resp || resp.length === 0) {
      return { columns: [], rows: [], info: "Empty response" };
    }

    // OK packet
    if (resp[0] === 0x00) {
      return this.parseOkPacket(resp);
    }

    // ERR packet
    if (resp[0] === 0xff) {
      const errCode = resp[1] | (resp[2] << 8);
      const errMsg = decoder.decode(resp.subarray(3));
      throw new Error(`MySQL error ${errCode}: ${errMsg}`);
    }

    // Result set — first byte is column count (length-encoded int)
    const columnCount = this.readLenEnc(resp, 0)[0];
    return this.readResultSet(columnCount);
  }

  /**
   * Close the connection by closing both pipe ends.
   */
  close(): void {
    this.kernel.pipeCloseWrite(this.pid, this.recvPipeIdx);
    this.kernel.pipeCloseRead(this.pid, this.sendPipeIdx);
  }

  // --- Protocol internals ---

  private async handshake(): Promise<void> {
    // Read server greeting
    const greeting = await this.readPacket();
    if (!greeting) throw new Error("No greeting from server");

    // Parse enough to know the protocol version
    const protocolVersion = greeting[0];
    if (protocolVersion !== 10) {
      throw new Error("Unexpected protocol version: " + protocolVersion);
    }

    // Find end of server version string (null-terminated)
    let pos = 1;
    while (pos < greeting.length && greeting[pos] !== 0) pos++;
    pos++; // skip null

    // Connection ID (4 bytes)
    pos += 4;

    // Auth plugin data part 1 (8 bytes)
    const authData1 = greeting.subarray(pos, pos + 8);
    pos += 8;

    // Filler (1 byte)
    pos += 1;

    // Capabilities (lower 2 bytes)
    const capLow = greeting[pos] | (greeting[pos + 1] << 8);
    pos += 2;

    // Character set, status, capabilities upper, auth data len, reserved
    pos += 1 + 2 + 2 + 1 + 10;

    // Auth plugin data part 2
    const authDataLen = Math.max(13, 0);
    const authData2 = greeting.subarray(pos, pos + authDataLen);

    // Send HandshakeResponse41
    // With skip-grant-tables we send an empty auth response
    const username = encoder.encode("root");
    const responsePayload = new Uint8Array(32 + username.length + 1 + 1 + 1);
    let wp = 0;

    // Client capabilities (4 bytes) — basic client flags
    const caps = 0x0000_a685; // CLIENT_PROTOCOL_41 | CLIENT_SECURE_CONNECTION | etc
    responsePayload[wp++] = caps & 0xff;
    responsePayload[wp++] = (caps >> 8) & 0xff;
    responsePayload[wp++] = (caps >> 16) & 0xff;
    responsePayload[wp++] = (caps >> 24) & 0xff;

    // Max packet size (4 bytes)
    responsePayload[wp++] = 0x00;
    responsePayload[wp++] = 0x00;
    responsePayload[wp++] = 0x40; // 4MB
    responsePayload[wp++] = 0x00;

    // Character set (1 byte) — utf8
    responsePayload[wp++] = 33; // utf8_general_ci

    // Reserved (23 bytes of zeros)
    wp += 23;

    // Username (null-terminated)
    responsePayload.set(username, wp);
    wp += username.length;
    responsePayload[wp++] = 0;

    // Auth response length + data (empty for skip-grant)
    responsePayload[wp++] = 0; // auth data length = 0

    await this.sendPacket(responsePayload.subarray(0, wp));
    this.kernel.wakeBlockedReaders(this.recvPipeIdx);

    // Read OK or ERR
    const authResp = await this.readPacket();
    if (!authResp) throw new Error("No auth response");
    if (authResp[0] === 0xff) {
      const errMsg = decoder.decode(authResp.subarray(3));
      throw new Error("Auth failed: " + errMsg);
    }
    // 0x00 = OK, 0xfe = auth switch (shouldn't happen with skip-grant)
  }

  private async sendPacket(payload: Uint8Array): Promise<void> {
    const packet = new Uint8Array(4 + payload.length);
    // 3-byte length
    packet[0] = payload.length & 0xff;
    packet[1] = (payload.length >> 8) & 0xff;
    packet[2] = (payload.length >> 16) & 0xff;
    // 1-byte sequence number
    packet[3] = this.seqNum++;
    packet.set(payload, 4);

    await this.kernel.pipeWrite(this.pid, this.recvPipeIdx, packet);
  }

  private async readPacket(): Promise<Uint8Array | null> {
    // Ensure we have at least the 4-byte header in the buffer
    while (this.readBuffer.length < 4) {
      const more = await this.readBytesFromPipe();
      if (!more) return null;
      this.appendToBuffer(more);
    }

    const payloadLen =
      this.readBuffer[0] | (this.readBuffer[1] << 8) | (this.readBuffer[2] << 16);
    this.seqNum = this.readBuffer[3] + 1;

    // Ensure we have the full packet payload
    while (this.readBuffer.length < 4 + payloadLen) {
      const more = await this.readBytesFromPipe();
      if (!more) break;
      this.appendToBuffer(more);
    }

    const packet = new Uint8Array(this.readBuffer.subarray(4, 4 + payloadLen));
    // Consume the packet from the buffer, keeping leftover bytes
    this.readBuffer = new Uint8Array(this.readBuffer.subarray(4 + payloadLen));
    return packet;
  }

  private appendToBuffer(data: Uint8Array): void {
    const combined = new Uint8Array(this.readBuffer.length + data.length);
    combined.set(this.readBuffer);
    combined.set(data, this.readBuffer.length);
    this.readBuffer = combined;
  }

  private async readBytesFromPipe(): Promise<Uint8Array | null> {
    // Poll the pipe for data with timeout (30s = 1500 × 20ms)
    for (let i = 0; i < 1500; i++) {
      const data = await this.kernel.pipeRead(this.pid, this.sendPipeIdx);
      if (data && data.length > 0) return data;
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  }

  private parseOkPacket(data: Uint8Array): MySqlResult {
    let pos = 1; // skip 0x00 header
    const [affectedRows, newPos1] = this.readLenEnc(data, pos);
    pos = newPos1;
    const [_lastInsertId, newPos2] = this.readLenEnc(data, pos);
    pos = newPos2;
    // status flags (2 bytes), warnings (2 bytes)
    pos += 4;
    const info = pos < data.length ? decoder.decode(data.subarray(pos)) : "";
    return { columns: [], rows: [], affectedRows, info };
  }

  private async readResultSet(columnCount: number): Promise<MySqlResult> {
    // Read column definitions
    const columns: string[] = [];
    for (let i = 0; i < columnCount; i++) {
      const pkt = await this.readPacket();
      if (!pkt) break;
      columns.push(this.parseColumnDef(pkt));
    }

    // Read EOF marker (or OK in MariaDB deprecating EOF)
    const eof1 = await this.readPacket();

    // Read rows until EOF
    const rows: string[][] = [];
    for (;;) {
      const pkt = await this.readPacket();
      if (!pkt) break;
      // EOF packet
      if (pkt[0] === 0xfe && pkt.length < 9) break;
      // ERR packet
      if (pkt[0] === 0xff) break;
      // Row data — each column is a length-encoded string
      rows.push(this.parseRow(pkt, columnCount));
    }

    return { columns, rows };
  }

  private parseColumnDef(data: Uint8Array): string {
    let pos = 0;
    // Skip: catalog, schema, table, org_table
    for (let i = 0; i < 4; i++) {
      const [len, newPos] = this.readLenEnc(data, pos);
      pos = newPos + len;
    }
    // Column name
    const [nameLen, namePos] = this.readLenEnc(data, pos);
    return decoder.decode(data.subarray(namePos, namePos + nameLen));
  }

  private parseRow(data: Uint8Array, columnCount: number): string[] {
    const row: string[] = [];
    let pos = 0;
    for (let i = 0; i < columnCount; i++) {
      if (pos >= data.length) {
        row.push("");
        continue;
      }
      // NULL
      if (data[pos] === 0xfb) {
        row.push("NULL");
        pos++;
        continue;
      }
      const [len, newPos] = this.readLenEnc(data, pos);
      pos = newPos;
      row.push(decoder.decode(data.subarray(pos, pos + len)));
      pos += len;
    }
    return row;
  }

  private readLenEnc(data: Uint8Array, pos: number): [number, number] {
    if (pos >= data.length) return [0, pos];
    const first = data[pos];
    if (first < 0xfb) return [first, pos + 1];
    if (first === 0xfc) {
      return [data[pos + 1] | (data[pos + 2] << 8), pos + 3];
    }
    if (first === 0xfd) {
      return [
        data[pos + 1] | (data[pos + 2] << 8) | (data[pos + 3] << 16),
        pos + 4,
      ];
    }
    // 0xfe — 8-byte int (unlikely for our use case)
    return [0, pos + 9];
  }
}
