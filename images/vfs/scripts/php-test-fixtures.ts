import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function preparePhpTestFixtures(
  sourceRoot: string,
  fixtureRoot: string,
): void {
  // PHP 8.3.15's upstream SNI PHPT fixtures expired on 2026-04-02. Do not
  // fake guest time to make them pass: that would compromise Kandelo as a
  // general POSIX platform. Instead, treat this as test-fixture maintenance
  // and copy equivalent long-lived certificates into the local test tree
  // before discovery/VFS packaging.
  const fixtureDir = join(fixtureRoot, "openssl-sni-2036");
  const destDir = join(sourceRoot, "ext/openssl/tests");
  if (existsSync(fixtureDir) && existsSync(destDir)) {
    for (const entry of readdirSync(fixtureDir)) {
      if (!entry.startsWith("sni_server_") || !entry.endsWith(".pem")) continue;
      cpSync(join(fixtureDir, entry), join(destDir, entry));
    }
  }

  // PHP 8.3.15's FPM test fixtures need small harness-side maintenance under
  // Kandelo:
  // - ext/opcache/tests/preload_user_004.phpt calls FPM\Tester::getLogLines(),
  //   but the shipped FPM tester helper does not define that method.
  // - logreader.inc has a native three-second default that is too short for
  //   OPcache preload startup under emulation.
  // - fcgi.inc has a native five-second client read/write timeout; under
  //   wasm emulation, OPcache preload requests can legitimately take longer
  //   while still producing the correct FastCGI response.
  //
  // These changes only affect the copied PHPT fixture tree used by the
  // harness. They do not change PHP runtime behavior or Kandelo kernel
  // behavior.
  const fpmTester = join(sourceRoot, "sapi/fpm/tests/tester.inc");
  if (existsSync(fpmTester)) {
    const text = readFileSync(fpmTester, "utf8");
    if (text.includes("class Tester")) {
      const marker = "    /**\n     * Expect no log lines to be logged.\n";
      const method = `    /**\n     * Return currently available FPM log lines.\n     *\n     * @param int $timeoutSeconds Seconds to wait for the first line.\n     * @param int $timeoutMicroseconds Additional microseconds to wait for the first line.\n     *\n     * @return array\n     * @throws \\Exception\n     */\n    public function getLogLines(int $timeoutSeconds = 3, int $timeoutMicroseconds = 0): array\n    {\n        $configuredTimeout = getenv('TEST_FPM_LOG_TIMEOUT_SECONDS');\n        if ($configuredTimeout !== false && is_numeric($configuredTimeout)) {\n            $timeoutSeconds = max($timeoutSeconds, (int) $configuredTimeout);\n        }\n\n        $lines = [];\n        $line = $this->logReader->getLine($timeoutSeconds, $timeoutMicroseconds);\n        while ($line !== null) {\n            if ($line !== '') {\n                $lines[] = $line;\n            }\n            $line = $this->logReader->getLine(timeoutSeconds: 0, timeoutMicroseconds: 1000);\n        }\n\n        return $lines;\n    }\n\n`;
      let next = text;
      if (text.includes("function getLogLines(")) {
        const start = text.indexOf("    /**\n     * Return currently available FPM log lines.");
        const end = text.indexOf(marker, start);
        if (start < 0 || end <= start) {
          throw new Error(
            `Unable to update PHP FPM tester fixture: getLogLines block not found in ${fpmTester}`,
          );
        }
        next = text.slice(0, start) + method + text.slice(end);
      } else {
        if (!text.includes(marker)) {
          throw new Error(
            `Unable to patch PHP FPM tester fixture: marker not found in ${fpmTester}`,
          );
        }
        next = text.replace(marker, method + marker);
      }
      if (!next.includes("TEST_FPM_CHECK_CONNECTION_ATTEMPTS")) {
        const from = `    ) {\n        $i = 0;\n        do {`;
        const to = `    ) {\n        $configuredAttempts = getenv('TEST_FPM_CHECK_CONNECTION_ATTEMPTS');\n        if ($configuredAttempts !== false && is_numeric($configuredAttempts)) {\n            $attempts = max($attempts, (int) $configuredAttempts);\n        }\n\n        $i = 0;\n        do {`;
        if (!next.includes(from)) {
          throw new Error(
            `Unable to patch PHP FPM tester fixture: checkConnection marker not found in ${fpmTester}`,
          );
        }
        next = next.replace(from, to);
      }
      if (!next.includes("$cmd .= ' --allow-to-run-as-root';")) {
        const from = `$cmd           = self::findExecutable() . " -n $configTestArg -y $configFile 2>&1";`;
        const to = `$cmd           = self::findExecutable() . " -n $configTestArg -y $configFile";\n        if (getenv('TEST_FPM_RUN_AS_ROOT')) {\n            $cmd .= ' --allow-to-run-as-root';\n        }\n        $cmd .= " 2>&1";`;
        if (!next.includes(from)) {
          throw new Error(
            `Unable to patch PHP FPM tester fixture: testConfig command marker not found in ${fpmTester}`,
          );
        }
        next = next.replace(from, to);
      }
      if (!next.includes("file_exists($extensionDir . '/' . $extension . '.so')")) {
        const from = `            foreach ($extensions as $extension) {\n                $cmd[] = '-dextension=' . $extension;\n            }`;
        const to = `            foreach ($extensions as $extension) {\n                if (file_exists($extensionDir . '/' . $extension . '.so')) {\n                    $cmd[] = '-dextension=' . $extension;\n                }\n            }`;
        if (!next.includes(from)) {
          throw new Error(
            `Unable to patch PHP FPM tester fixture: extension loading marker not found in ${fpmTester}`,
          );
        }
        next = next.replace(from, to);
      }
      if (next !== text) writeFileSync(fpmTester, next, "utf8");
    }
  }

  const fpmLogReader = join(sourceRoot, "sapi/fpm/tests/logreader.inc");
  if (existsSync(fpmLogReader)) {
    const text = readFileSync(fpmLogReader, "utf8");
    if (!text.includes("TEST_FPM_LOG_TIMEOUT_SECONDS")) {
      const from = `if (is_null($timeoutSeconds) && is_null($timeoutMicroseconds)) {\n            $timeoutSeconds      = 3;\n            $timeoutMicroseconds = 0;\n        }`;
      const to = `if (is_null($timeoutSeconds) && is_null($timeoutMicroseconds)) {\n            $configuredTimeout = getenv('TEST_FPM_LOG_TIMEOUT_SECONDS');\n            $timeoutSeconds = $configuredTimeout !== false && is_numeric($configuredTimeout)\n                ? max(3, (int) $configuredTimeout)\n                : 3;\n            $timeoutMicroseconds = 0;\n        }`;
      if (!text.includes(from)) {
        throw new Error(
          `Unable to patch PHP FPM logreader fixture: marker not found in ${fpmLogReader}`,
        );
      }
      writeFileSync(fpmLogReader, text.replace(from, to), "utf8");
    }
  }

  const fpmFcgi = join(sourceRoot, "sapi/fpm/tests/fcgi.inc");
  if (existsSync(fpmFcgi)) {
    const text = readFileSync(fpmFcgi, "utf8");
    if (!text.includes("TEST_FPM_READ_WRITE_TIMEOUT_MS")) {
      const from = `        $this->transport = $transport;\n    }`;
      const to = `        $this->transport = $transport;\n\n        $configuredTimeout = getenv('TEST_FPM_READ_WRITE_TIMEOUT_MS');\n        if ($configuredTimeout !== false && is_numeric($configuredTimeout)) {\n            $this->_readWriteTimeout = max($this->_readWriteTimeout, (int) $configuredTimeout);\n        }\n    }`;
      if (!text.includes(from)) {
        throw new Error(
          `Unable to patch PHP FPM FastCGI fixture: constructor marker not found in ${fpmFcgi}`,
        );
      }
      writeFileSync(fpmFcgi, text.replace(from, to), "utf8");
    }
  }

  const fpmIpv4Fallback = join(sourceRoot, "sapi/fpm/tests/socket-ipv4-fallback.phpt");
  if (existsSync(fpmIpv4Fallback)) {
    const text = readFileSync(fpmIpv4Fallback, "utf8");
    const from = "Address already in use \\(\\d+\\)";
    const to = "Address (?:already )?in use \\(\\d+\\)";
    if (text.includes(from) && !text.includes(to)) {
      // musl's strerror(EADDRINUSE) is "Address in use" while glibc's is
      // "Address already in use". Both describe the same POSIX errno, so make
      // this fixture regex libc-portable rather than changing Kandelo/libc
      // message strings to match one C library.
      writeFileSync(fpmIpv4Fallback, text.replace(from, to), "utf8");
    }
  }

  const mysqliFakeServer = join(sourceRoot, "ext/mysqli/tests/fake_server.inc");
  if (existsSync(mysqliFakeServer)) {
    const text = readFileSync(mysqliFakeServer, "utf8");
    if (!text.includes("MYSQLI_FAKE_SERVER_DRAIN_IDLE_MS")) {
      const from = `    public function read($bytes_len = 1024)
    {
        // wait 20ms to fill the buffer
        usleep(20000);
        $data = fread($this->conn, $bytes_len);
        if ($data) {
            fprintf(STDERR, "[*] Received: %s\\n", bin2hex($data));
        }
    }`;
      const to = `    public function read($bytes_len = 1024)
    {
        // wait 20ms to fill the buffer
        usleep(20000);
        $data = fread($this->conn, $bytes_len);

        if ($data && $bytes_len > 1024) {
            // Large reads in this fake MySQL server are used to drain the
            // connection tail after the client reacts to a crafted packet.
            // fread() on a POSIX stream may return as soon as any bytes are
            // available; it is not required to wait for later client writes to
            // coalesce into the same TCP segment. Native php-src runs usually
            // see the final COM_STMT_CLOSE and COM_QUIT together after the
            // fixed sleep above, but the browser host can schedule the guest
            // peer more slowly. Keep draining for a short idle window and print
            // one Received line so the fixture remains semantically identical
            // without relying on transport coalescing.
            $idleMs = getenv('MYSQLI_FAKE_SERVER_DRAIN_IDLE_MS');
            $idleMs = $idleMs !== false && is_numeric($idleMs) ? max(0, (int) $idleMs) : 250;
            $deadline = microtime(true) + ($idleMs / 1000);
            $wasBlocking = stream_get_meta_data($this->conn)['blocked'] ?? true;
            stream_set_blocking($this->conn, false);
            try {
                while (strlen($data) < $bytes_len && microtime(true) < $deadline) {
                    usleep(10000);
                    $chunk = fread($this->conn, $bytes_len - strlen($data));
                    if ($chunk !== false && $chunk !== '') {
                        $data .= $chunk;
                        $deadline = microtime(true) + ($idleMs / 1000);
                    }
                }
            } finally {
                stream_set_blocking($this->conn, $wasBlocking);
            }
        }

        if ($data) {
            fprintf(STDERR, "[*] Received: %s\\n", bin2hex($data));
        }
    }`;
      if (!text.includes(from)) {
        throw new Error(
          `Unable to patch PHP mysqli fake_server fixture: read() marker not found in ${mysqliFakeServer}`,
        );
      }
      writeFileSync(mysqliFakeServer, text.replace(from, to), "utf8");
    }
  }
}
