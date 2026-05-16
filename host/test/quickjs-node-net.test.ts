import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import { lookup } from "node:dns";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE = join(__dirname, "../../examples/libs/quickjs/bin/node.wasm");
const HAS_NODE = existsSync(NODE);

// Wasm `connect(127.0.0.1, _)` is hard-routed to in-kernel cross-process
// loopback and never reaches `TcpNetworkBackend` (see crates/kernel/src/syscalls.rs
// `sys_connect`). To exercise the host backend we must dial a different IP.
//
// 127.0.0.2 works on Linux (whole 127/8 is loopback) and on macOS only when
// the user has aliased `lo0`. As a portable fallback we use the first
// non-internal IPv4 of this machine. If neither is reachable the suite skips.
async function tcpReachable(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.once("timeout", () => finish(false));
    sock.connect(port, host);
  });
}

async function pickWasmDialHost(): Promise<string | null> {
  if (!HAS_NODE) return null;
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "0.0.0.0", () => r()));
  const port = (probe.address() as net.AddressInfo).port;
  try {
    const candidates = ["127.0.0.2"];
    for (const ifs of Object.values(os.networkInterfaces())) {
      for (const a of ifs ?? []) {
        if (a.family === "IPv4" && !a.internal) candidates.push(a.address);
      }
    }
    for (const c of candidates) {
      if (await tcpReachable(c, port)) return c;
    }
    return null;
  } finally {
    await new Promise<void>((r) => probe.close(() => r()));
  }
}

const WASM_DIAL_HOST = await pickWasmDialHost();

// Pick a hostname that (a) isn't shortcut by musl (not "localhost"), (b)
// resolves via dns.lookup, (c) maps to an IP the echo server is reachable
// at. Skips otherwise. Exercises the non-blocking getaddrinfo path.
async function dnsLookup(host: string): Promise<string | null> {
  return new Promise((resolve) =>
    lookup(host, 4, (err, addr) => resolve(err ? null : addr)),
  );
}

async function pickWasmDialHostname(): Promise<string | null> {
  if (!HAS_NODE) return null;
  const sysHost = os.hostname();
  if (!sysHost || sysHost === "localhost") return null;
  const candidates = [sysHost, `${sysHost}.local`];
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "0.0.0.0", () => r()));
  const port = (probe.address() as net.AddressInfo).port;
  try {
    for (const c of candidates) {
      const ip = await dnsLookup(c);
      if (!ip || ip.startsWith("127.")) continue; // 127.x routes in-kernel
      if (await tcpReachable(ip, port)) return c;
    }
    return null;
  } finally {
    await new Promise<void>((r) => probe.close(() => r()));
  }
}

const WASM_DIAL_HOSTNAME = await pickWasmDialHostname();

function runNodeNet(src: string, timeout = 15_000) {
  return runCentralizedProgram({
    programPath: NODE,
    argv: ["node", "-e", src],
    enableTcpNetwork: true,
    timeout,
  });
}

describe.skipIf(!WASM_DIAL_HOST)(
  "node.wasm net (real TCP via host backend)",
  () => {
    let echoServer: net.Server;
    let echoPort: number;

    beforeAll(async () => {
      echoServer = net.createServer((s) => {
        s.on("data", (d) => {
          s.write(d);
          s.end();
        });
      });
      await new Promise<void>((resolve) =>
        echoServer.listen(0, "0.0.0.0", () => resolve()),
      );
      echoPort = (echoServer.address() as net.AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    });

    it("connects and echoes a small payload", { timeout: 30_000 }, async () => {
      const r = await runNodeNet(`
        const net = require('net');
        const sock = net.connect(${echoPort}, '${WASM_DIAL_HOST}');
        sock.on('connect', () => sock.write('hello'));
        sock.on('data', (d) => process.stdout.write(d));
        sock.on('end', () => sock.destroy());
      `);
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("hello");
    });

    it("emits 'end' when the peer closes the connection (EOF)", { timeout: 30_000 }, async () => {
      const r = await runNodeNet(`
        const net = require('net');
        const sock = net.connect(${echoPort}, '${WASM_DIAL_HOST}');
        sock.on('connect', () => sock.write('x'));
        sock.on('data', (d) => process.stdout.write('data:' + d.length + ';'));
        sock.on('end', () => { process.stdout.write('end'); sock.destroy(); });
      `);
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("data:1;end");
    });

    it("emits 'error' when connecting to a closed port", { timeout: 30_000 }, async () => {
      // Find a port nothing is listening on by opening then immediately closing.
      const probe = net.createServer();
      await new Promise<void>((resolve) =>
        probe.listen(0, "0.0.0.0", () => resolve()),
      );
      const closedPort = (probe.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));

      const r = await runNodeNet(`
        const net = require('net');
        const sock = net.connect(${closedPort}, '${WASM_DIAL_HOST}');
        sock.on('connect', () => process.stdout.write('connected'));
        sock.on('error', (e) => process.stdout.write('error'));
      `);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("error");
    });

    it.skipIf(!WASM_DIAL_HOSTNAME)(
      "resolves a real hostname via host DNS without deadlocking",
      { timeout: 30_000 },
      async () => {
        const r = await runNodeNet(`
          const net = require('net');
          const sock = net.connect(${echoPort}, ${JSON.stringify(WASM_DIAL_HOSTNAME)});
          sock.on('connect', () => sock.write('hello'));
          sock.on('data', (d) => process.stdout.write(d));
          sock.on('end', () => sock.destroy());
        `);
        expect(r.stderr).toBe("");
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("hello");
      },
    );

    it("transfers a payload larger than a single read chunk (>64 KiB)", { timeout: 60_000 }, async () => {
      const bulkServer = net.createServer((s) => {
        const chunks: Buffer[] = [];
        let total = 0;
        const expected = 200_000;
        s.on("data", (d) => {
          chunks.push(d);
          total += d.length;
          if (total >= expected) {
            s.write(Buffer.concat(chunks));
            s.end();
          }
        });
      });
      await new Promise<void>((resolve) =>
        bulkServer.listen(0, "0.0.0.0", () => resolve()),
      );
      const bulkPort = (bulkServer.address() as net.AddressInfo).port;

      try {
        const r = await runNodeNet(
          `
          const net = require('net');
          const sock = net.connect(${bulkPort}, '${WASM_DIAL_HOST}');
          const N = 200000;
          let received = 0;
          let mismatch = 0;
          sock.on('connect', () => {
            const buf = Buffer.alloc(N);
            for (let i = 0; i < N; i++) buf[i] = (i * 31 + (i >> 3)) & 0xff;
            sock.write(buf);
          });
          sock.on('data', (d) => {
            for (let i = 0; i < d.length; i++) {
              const expect = ((received + i) * 31 + ((received + i) >> 3)) & 0xff;
              if (d[i] !== expect) mismatch++;
            }
            received += d.length;
          });
          sock.on('end', () => {
            process.stdout.write('rx=' + received + ' mismatch=' + mismatch);
            sock.destroy();
          });
        `,
          30_000,
        );
        expect(r.stderr).toBe("");
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("rx=200000 mismatch=0");
      } finally {
        await new Promise<void>((resolve) => bulkServer.close(() => resolve()));
      }
    });
  },
);
