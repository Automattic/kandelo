import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE = join(__dirname, "../../examples/libs/quickjs/bin/node.wasm");
const HAS_NODE = existsSync(NODE);

/* Smoke test for the in-kernel cacert bundle vendored at /etc/ssl/cert.pem.
   We don't go through TLS here — just confirm the synthetic file exists,
   has plausible PEM content, and is sized like Mozilla's CA roundup. */
describe.skipIf(!HAS_NODE)("/etc/ssl/cert.pem (kernel-vended Mozilla CA bundle)", () => {
  it("is readable as a Mozilla-formatted CA bundle", async () => {
    const src = `
      const fs = require('fs');
      const data = fs.readFileSync('/etc/ssl/cert.pem', 'utf8');
      const begins = (data.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
      const ends   = (data.match(/-----END CERTIFICATE-----/g) || []).length;
      const headerOk = data.startsWith('##');
      console.log(JSON.stringify({ length: data.length, begins, ends, headerOk }));
    `;
    const r = await runCentralizedProgram({
      programPath: NODE,
      argv: ["node", "-e", src],
      timeout: 10_000,
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.headerOk).toBe(true);
    expect(out.begins).toBeGreaterThanOrEqual(100);
    expect(out.begins).toBe(out.ends);
    expect(out.length).toBeGreaterThan(150_000);
  });
});
