import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as tls from "node:tls";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE = join(__dirname, "../../examples/libs/quickjs/bin/node.wasm");
const HAS_NODE = existsSync(NODE);

const TEST_HOSTNAME = "wasm-tls-test.local";

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

/* Generate a self-signed leaf cert that doubles as its own CA. The wasm
   client trusts it via the `ca` option; SAN matches the SNI value
   wasm sends. Falls back to skipping if the host has no `openssl` CLI. */
function makeSelfSignedCert(): { cert: string; key: string } | null {
  const probe = spawnSync("openssl", ["version"], { stdio: "ignore" });
  if (probe.status !== 0) return null;
  const dir = mkdtempSync(join(tmpdir(), "wasm-tls-fixture-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    const r = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256",
      "-days", "1", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-subj", `/CN=${TEST_HOSTNAME}`,
      "-addext", `subjectAltName = DNS:${TEST_HOSTNAME}`,
    ], { stdio: "pipe" });
    if (r.status !== 0) return null;
    return {
      key: readFileSync(keyPath, "utf8"),
      cert: readFileSync(certPath, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fixture = HAS_NODE && WASM_DIAL_HOST ? makeSelfSignedCert() : null;

function runNodeTls(src: string, timeout = 30_000) {
  return runCentralizedProgram({
    programPath: NODE,
    argv: ["node", "-e", src],
    enableTcpNetwork: true,
    timeout,
  });
}

describe.skipIf(!WASM_DIAL_HOST || !fixture)(
  "node.wasm tls (libssl in-wasm + host net.Socket transport)",
  () => {
    let echoServer: tls.Server;
    let echoPort: number;

    beforeAll(async () => {
      echoServer = tls.createServer(
        { cert: fixture!.cert, key: fixture!.key },
        (s) => {
          s.on("data", (d) => {
            s.write(d);
            s.end();
          });
        },
      );
      await new Promise<void>((resolve) =>
        echoServer.listen(0, "0.0.0.0", () => resolve()),
      );
      echoPort = (echoServer.address() as net.AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    });

    it(
      "completes a TLS handshake against a self-signed peer when ca is provided",
      { timeout: 30_000 },
      async () => {
        const r = await runNodeTls(`
          const tls = require('tls');
          const ca = ${JSON.stringify(fixture!.cert)};
          const sock = tls.connect({
            host: '${WASM_DIAL_HOST}',
            port: ${echoPort},
            servername: '${TEST_HOSTNAME}',
            ca,
          });
          sock.on('secureConnect', () => sock.write('hello-tls'));
          sock.on('data', (d) => process.stdout.write(d));
          sock.on('end', () => sock.destroy());
        `);
        expect(r.stderr).toBe("");
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("hello-tls");
      },
    );

    it(
      "rejects when the peer cert can't be verified (default verify on)",
      { timeout: 30_000 },
      async () => {
        const r = await runNodeTls(`
          const tls = require('tls');
          const sock = tls.connect({
            host: '${WASM_DIAL_HOST}',
            port: ${echoPort},
            servername: '${TEST_HOSTNAME}',
          });
          sock.on('secureConnect', () => process.stdout.write('connected'));
          sock.on('error', (e) => process.stdout.write('error:' + (e.message || 'unknown')));
        `);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toMatch(/^error:/);
      },
    );

    it(
      "round-trips a payload larger than one TLS record (>16 KiB)",
      { timeout: 60_000 },
      async () => {
        /* Dedicated server that collects until the expected size before
           echoing — sharing echoServer breaks here because TLS fragments
           the client write across multiple records, and echoServer ends
           after the first 'data' event. */
        const bulkServer = tls.createServer(
          { cert: fixture!.cert, key: fixture!.key },
          (s) => {
            const chunks: Buffer[] = [];
            let total = 0;
            const expected = 50_000;
            s.on("data", (d) => {
              chunks.push(d);
              total += d.length;
              if (total >= expected) {
                s.write(Buffer.concat(chunks));
                s.end();
              }
            });
          },
        );
        await new Promise<void>((resolve) =>
          bulkServer.listen(0, "0.0.0.0", () => resolve()),
        );
        const bulkPort = (bulkServer.address() as net.AddressInfo).port;

        try {
          const r = await runNodeTls(`
            const tls = require('tls');
            const ca = ${JSON.stringify(fixture!.cert)};
            const sock = tls.connect({
              host: '${WASM_DIAL_HOST}',
              port: ${bulkPort},
              servername: '${TEST_HOSTNAME}',
              ca,
            });
            const N = 50000;
            let received = 0, mismatch = 0;
            sock.on('secureConnect', () => {
              const buf = Buffer.alloc(N);
              for (let i = 0; i < N; i++) buf[i] = (i * 17 + (i >> 5)) & 0xff;
              sock.write(buf);
            });
            sock.on('data', (d) => {
              for (let i = 0; i < d.length; i++) {
                const e = ((received + i) * 17 + ((received + i) >> 5)) & 0xff;
                if (d[i] !== e) mismatch++;
              }
              received += d.length;
            });
            sock.on('end', () => {
              process.stdout.write('rx=' + received + ' mismatch=' + mismatch);
              sock.destroy();
            });
          `, 60_000);
          expect(r.stderr).toBe("");
          expect(r.exitCode).toBe(0);
          expect(r.stdout).toBe("rx=50000 mismatch=0");
        } finally {
          await new Promise<void>((resolve) => bulkServer.close(() => resolve()));
        }
      },
    );
  },
);
