import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const nodeCompatPatch = readFileSync(
  join(testDirectory, "../patches/0012-kandelo-node-compat-shell-entry.patch"),
  "utf8",
);

function patchFunction(name: string): string {
  const start = nodeCompatPatch.indexOf(`static bool ${name}`);
  const end = nodeCompatPatch.indexOf("\n+static bool ", start + 1);
  expect(start, `${name} is missing`).toBeGreaterThanOrEqual(0);
  return nodeCompatPatch.slice(start, end < 0 ? undefined : end);
}

describe("SpiderMonkey native TLS readiness contract", () => {
  it("drives handshake and response I/O through readiness watches", () => {
    for (const entrypoint of [
      "KandeloNativeTlsConnect",
      "KandeloNativeTlsRead",
      "KandeloNativeTlsWrite",
    ]) {
      expect(patchFunction(entrypoint)).toContain(
        "KandeloDispatchTlsWatch(watch)",
      );
    }
    const dispatcher = patchFunction("KandeloTlsWatchNeedsRetry");
    expect(dispatcher).toMatch(/SSL_ERROR_WANT_READ[\s\S]*POLLIN/);
    expect(dispatcher).toMatch(/SSL_ERROR_WANT_WRITE[\s\S]*POLLOUT/);
    expect(nodeCompatPatch).not.toContain("if (SSL_connect(ssl) != 1)");
  });
});
