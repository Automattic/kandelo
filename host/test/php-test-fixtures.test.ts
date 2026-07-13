import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preparePhpTestFixtures } from "../../images/vfs/scripts/php-test-fixtures";

describe("preparePhpTestFixtures", () => {
  it("patches and re-signs the wasm32 no-phar fixture exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-php-fixtures-phar-test-"));
    try {
      const sourceRoot = join(root, "source");
      const fixtureDir = join(sourceRoot, "ext/phar/tests/files");
      const fixture = join(fixtureDir, "nophar.phar");
      mkdirSync(fixtureDir, { recursive: true });

      const payload = Buffer.from(
        "prefix 0xffffffff middle 0xffffffff suffix",
        "ascii",
      );
      const trailer = Buffer.alloc(28);
      createHash("sha1").update(payload).digest().copy(trailer, 0);
      trailer.writeUInt32LE(2, 20);
      trailer.write("GBMB", 24, "ascii");
      writeFileSync(fixture, Buffer.concat([payload, trailer]));

      preparePhpTestFixtures(sourceRoot, join(root, "missing-fixtures"));
      const once = readFileSync(fixture);
      expect(once.length).toBe(payload.length + trailer.length);
      expect(once.toString("ascii", 0, payload.length)).toBe(
        "prefix (-1)       middle (-1)       suffix",
      );
      expect(once.readUInt32LE(once.length - 8)).toBe(2);
      expect(once.subarray(once.length - 4).toString("ascii")).toBe("GBMB");
      expect(once.subarray(once.length - 28, once.length - 8)).toEqual(
        createHash("sha1")
          .update(once.subarray(0, once.length - 28))
          .digest(),
      );

      preparePhpTestFixtures(sourceRoot, join(root, "missing-fixtures"));
      expect(readFileSync(fixture)).toEqual(once);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies non-OpenSSL maintenance once when SNI fixtures are absent", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-php-fixtures-test-"));
    try {
      const mysqliDir = join(root, "source/ext/mysqli/tests");
      const fakeServer = join(mysqliDir, "fake_server.inc");
      mkdirSync(mysqliDir, { recursive: true });
      writeFileSync(
        fakeServer,
        `    public function read($bytes_len = 1024)
    {
        // wait 20ms to fill the buffer
        usleep(20000);
        $data = fread($this->conn, $bytes_len);
        if ($data) {
            fprintf(STDERR, "[*] Received: %s\\n", bin2hex($data));
        }
    }`,
      );

      const sourceRoot = join(root, "source");
      const missingFixtureRoot = join(root, "missing-fixtures");
      preparePhpTestFixtures(sourceRoot, missingFixtureRoot);
      const once = readFileSync(fakeServer, "utf8");
      expect(once).toContain("MYSQLI_FAKE_SERVER_DRAIN_IDLE_MS");

      preparePhpTestFixtures(sourceRoot, missingFixtureRoot);
      expect(readFileSync(fakeServer, "utf8")).toBe(once);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
