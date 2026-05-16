import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as tls from "node:tls";
import * as http from "node:http";
import * as https from "node:https";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE = join(__dirname, "../../examples/libs/quickjs/bin/node.wasm");
const HAS_NODE = existsSync(NODE);

const TEST_HOSTNAME = "wasm-https-test.local";

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

/* The wasm process can't dial 127.0.0.1 directly (the host network is
   reachable through net.Socket-delegated connect, but only on
   non-loopback addresses on this Mac — see Phase 3 handoff). Same lookup
   as the TLS test fixture. */
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

function makeSelfSignedCert(): { cert: string; key: string } | null {
  const probe = spawnSync("openssl", ["version"], { stdio: "ignore" });
  if (probe.status !== 0) return null;
  const dir = mkdtempSync(join(tmpdir(), "wasm-https-fixture-"));
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

function runNodeProg(src: string, timeout = 30_000) {
  return runCentralizedProgram({
    programPath: NODE,
    argv: ["node", "-e", src],
    enableTcpNetwork: true,
    timeout,
  });
}

/* Spawn an https.Server with the per-test handler. Returns { url, close }. */
async function startHttpsServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = https.createServer(
    { cert: fixture!.cert, key: fixture!.key },
    handler,
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "0.0.0.0", () => resolve()),
  );
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!WASM_DIAL_HOST || !fixture)(
  "node.wasm https (real http/1.1 over tls.TLSSocket)",
  () => {
    it(
      "https.get against a self-signed CA — Content-Length body",
      { timeout: 30_000 },
      async () => {
        const srv = await startHttpsServer((req, res) => {
          res.writeHead(200, {
            "Content-Type": "text/plain",
            "Content-Length": "13",
          });
          res.end("hello, https!");
        });
        try {
          const r = await runNodeProg(`
            const https = require('https');
            const ca = ${JSON.stringify(fixture!.cert)};
            https.get({
              host: '${WASM_DIAL_HOST}',
              port: ${srv.port},
              path: '/',
              servername: '${TEST_HOSTNAME}',
              ca,
            }, (res) => {
              process.stdout.write('status:' + res.statusCode + '\\n');
              process.stdout.write('ct:' + res.headers['content-type'] + '\\n');
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => process.stdout.write('body:' + Buffer.concat(chunks).toString()));
            }).on('error', (e) => process.stdout.write('error:' + e.message));
          `);
          expect(r.stderr).toBe("");
          expect(r.exitCode).toBe(0);
          expect(r.stdout).toContain("status:200");
          expect(r.stdout).toContain("ct:text/plain");
          expect(r.stdout).toContain("body:hello, https!");
        } finally {
          await srv.close();
        }
      },
    );

    it(
      "https.get against a self-signed CA — Transfer-Encoding: chunked body",
      { timeout: 30_000 },
      async () => {
        /* Three chunks. Node writes them as separate chunked encoding
           frames when Content-Length is omitted. */
        const srv = await startHttpsServer((req, res) => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.write("alpha-");
          res.write("beta-");
          res.end("gamma");
        });
        try {
          const r = await runNodeProg(`
            const https = require('https');
            const ca = ${JSON.stringify(fixture!.cert)};
            https.get({
              host: '${WASM_DIAL_HOST}',
              port: ${srv.port},
              path: '/',
              servername: '${TEST_HOSTNAME}',
              ca,
            }, (res) => {
              process.stdout.write('te:' + (res.headers['transfer-encoding'] || 'none') + '\\n');
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => process.stdout.write('body:' + Buffer.concat(chunks).toString()));
            }).on('error', (e) => process.stdout.write('error:' + e.message));
          `);
          expect(r.stderr).toBe("");
          expect(r.exitCode).toBe(0);
          expect(r.stdout).toContain("te:chunked");
          expect(r.stdout).toContain("body:alpha-beta-gamma");
        } finally {
          await srv.close();
        }
      },
    );

    it(
      "https.get follows a relative 302 redirect when followRedirects: true",
      { timeout: 30_000 },
      async () => {
        /* Same-server, relative-Location redirect — the common shape that
           keeps the original SNI valid (the redirect target shares the
           cert's SAN). Cross-origin TLS redirects are out of scope. */
        const srv = await startHttpsServer((req, res) => {
          if (req.url === "/") {
            res.writeHead(302, { "Location": "/final", "Content-Length": "0" });
            res.end();
            return;
          }
          if (req.url === "/final") {
            res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "11" });
            res.end("redirected!");
            return;
          }
          res.writeHead(404, { "Content-Length": "0" });
          res.end();
        });
        try {
          const r = await runNodeProg(`
            const https = require('https');
            const ca = ${JSON.stringify(fixture!.cert)};
            https.get({
              host: '${WASM_DIAL_HOST}',
              port: ${srv.port},
              path: '/',
              servername: '${TEST_HOSTNAME}',
              ca,
              followRedirects: true,
            }, (res) => {
              process.stdout.write('status:' + res.statusCode + '\\n');
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => process.stdout.write('body:' + Buffer.concat(chunks).toString()));
            }).on('error', (e) => process.stdout.write('error:' + e.message));
          `);
          expect(r.stderr).toBe("");
          expect(r.exitCode).toBe(0);
          expect(r.stdout).toContain("status:200");
          expect(r.stdout).toContain("body:redirected!");
        } finally {
          await srv.close();
        }
      },
    );

    it(
      "https.get rejects when the peer cert can't be verified",
      { timeout: 30_000 },
      async () => {
        /* No `ca` option — falls back to the in-kernel Mozilla bundle at
           /etc/ssl/cert.pem, which won't trust our test CA. The handshake
           must fail rather than silently bypass verification. */
        const srv = await startHttpsServer((req, res) => {
          res.writeHead(200, { "Content-Length": "2" });
          res.end("ok");
        });
        try {
          const r = await runNodeProg(`
            const https = require('https');
            const req = https.get({
              host: '${WASM_DIAL_HOST}',
              port: ${srv.port},
              path: '/',
              servername: '${TEST_HOSTNAME}',
            }, (res) => {
              process.stdout.write('unexpected-success:' + res.statusCode);
            });
            req.on('error', (e) => process.stdout.write('error:' + (e.message || 'unknown')));
          `);
          expect(r.exitCode).toBe(0);
          expect(r.stdout).toMatch(/^error:/);
          expect(r.stdout).not.toContain("unexpected-success");
        } finally {
          await srv.close();
        }
      },
    );
  },
);

/* http (cleartext) — the same module flow without TLS. One smoke case is
   enough — TLS is the part the harness can flake on. */
describe.skipIf(!WASM_DIAL_HOST || !HAS_NODE)(
  "node.wasm http (real http/1.1 over net.Socket)",
  () => {
    it(
      "http.get retrieves a Content-Length body from a plain Node http server",
      { timeout: 20_000 },
      async () => {
        const server = http.createServer((req, res) => {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Length": "13",
          });
          res.end('{"ok":true}\n!');
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "0.0.0.0", () => resolve()),
        );
        const port = (server.address() as net.AddressInfo).port;
        try {
          const r = await runNodeProg(`
            const http = require('http');
            http.get({
              host: '${WASM_DIAL_HOST}',
              port: ${port},
              path: '/',
            }, (res) => {
              process.stdout.write('status:' + res.statusCode + '\\n');
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => process.stdout.write('body:' + Buffer.concat(chunks).toString()));
            }).on('error', (e) => process.stdout.write('error:' + e.message));
          `);
          expect(r.stderr).toBe("");
          expect(r.exitCode).toBe(0);
          expect(r.stdout).toContain("status:200");
          expect(r.stdout).toContain('body:{"ok":true}\n!');
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );
  },
);
