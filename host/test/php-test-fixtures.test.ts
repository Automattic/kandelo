import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preparePhpTestFixtures } from "../../images/vfs/scripts/php-test-fixtures";

describe("preparePhpTestFixtures", () => {
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
