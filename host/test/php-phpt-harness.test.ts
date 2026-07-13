import { describe, expect, it } from "vitest";
import {
  compareExpectation,
  probeLoadedExtensions,
  runPhpt,
  splitArgs,
  testScript,
  type PhpRunResult,
  type PhpRunner,
  type PhptTest,
} from "../../scripts/run-php-upstream-tests";

type ScriptKind = Parameters<PhpRunner["runScript"]>[0]["kind"];

function runResult(overrides: Partial<PhpRunResult> = {}): PhpRunResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    ...overrides,
  };
}

class ScriptedRunner implements PhpRunner {
  readonly calls: ScriptKind[] = [];
  readonly envByKind = new Map<ScriptKind, string[]>();
  readonly argvByKind = new Map<ScriptKind, string[]>();

  constructor(
    private readonly results: Partial<
      Record<ScriptKind, PhpRunResult | PhpRunResult[]>
    >,
  ) {}

  loadExtensionIniArgs(): string[] {
    return [];
  }

  async runScript(
    opts: Parameters<PhpRunner["runScript"]>[0],
  ): Promise<PhpRunResult> {
    this.calls.push(opts.kind);
    this.envByKind.set(opts.kind, opts.env);
    this.argvByKind.set(opts.kind, opts.argv);
    const configured = this.results[opts.kind];
    const result = Array.isArray(configured) ? configured.shift() : configured;
    if (!result) throw new Error(`unexpected ${opts.kind} invocation`);
    return result;
  }

  async close(): Promise<void> {}
}

function phpt(sections: Record<string, string>): PhptTest {
  return {
    path: "/php-src/tests/harness.phpt",
    rel: "tests/harness.phpt",
    sourceRoot: "/php-src",
    sections: {
      TEST: "harness semantics",
      FILE: "<?php echo 'ok'; ?>",
      EXPECT: "ok",
      ...sections,
    },
  };
}

describe("PHP PHPT verdict semantics", () => {
  it("matches Kandelo EXPECTF placeholders with PHP's POSIX rules", () => {
    const separator = phpt({ EXPECTF: "a%eb" });
    delete separator.sections.EXPECT;
    expect(compareExpectation(separator, "a/b").ok).toBe(true);
    expect(compareExpectation(separator, "a\\b").ok).toBe(false);

    const float = phpt({ EXPECTF: "%f" });
    delete float.sections.EXPECT;
    expect(compareExpectation(float, "1.0").ok).toBe(true);
    expect(compareExpectation(float, "1.").ok).toBe(false);
  });

  it("translates PCRE generic newlines inside EXPECTF raw regex", () => {
    const test = phpt({ EXPECTF: "%rfoo\\R?bar%r" });
    delete test.sections.EXPECT;

    expect(compareExpectation(test, "foo\r\nbar").ok).toBe(true);
    expect(compareExpectation(test, "fooRbar").ok).toBe(false);
  });

  it("preserves quoted empty ARGS and FILEEOF byte boundaries", () => {
    expect(splitArgs(`one "" '' three\\ four`)).toEqual([
      "one",
      "",
      "",
      "three four",
    ]);
    const eof = phpt({ FILEEOF: "payload\r\n\n" });
    delete eof.sections.FILE;
    expect(testScript(eof)).toBe("payload");
  });

  it("derives extension inventory from the guest PHP binary", async () => {
    const runner = new ScriptedRunner({
      file: runResult({
        output:
          "startup noise\n__KANDELO_PHP_EXTENSIONS__[\"Core\",\"date\",\"Zend OPcache\"]__KANDELO_PHP_EXTENSIONS_END__",
      }),
    });

    const loaded = await probeLoadedExtensions(
      runner,
      "/php-src",
      new Set(["opcache"]),
      1000,
    );

    expect([...loaded].sort()).toEqual(["core", "date", "opcache"]);
  });

  it("anchors EXPECTREGEX against the complete output", async () => {
    const runner = new ScriptedRunner({
      file: runResult({ stdout: "prefix wanted suffix" }),
    });
    const test = phpt({ EXPECTREGEX: "wanted" });
    delete test.sections.EXPECT;

    const result = await runPhpt(test, runner, new Set(), 1000);

    expect(result.status).toBe("fail");
  });

  it("normalizes CRLF without erasing standalone carriage returns", () => {
    expect(compareExpectation(phpt({}), "ok\r\n").ok).toBe(true);
    expect(compareExpectation(phpt({ EXPECT: "left\rright" }), "left\nright").ok)
      .toBe(false);
  });

  it("matches run-tests.php's section-specific request environment", async () => {
    const runner = new ScriptedRunner({
      skipif: runResult(),
      file: runResult({ stdout: "ok" }),
      clean: runResult(),
    });

    const result = await runPhpt(
      phpt({ SKIPIF: "<?php ?>", CLEAN: "<?php ?>" }),
      runner,
      new Set(),
      1000,
    );

    expect(result.status).toBe("pass");
    const fileEnv = runner.envByKind.get("file") ?? [];
    expect(fileEnv).toContain("REDIRECT_STATUS=1");
    expect(fileEnv).toContain("REQUEST_METHOD=GET");
    expect(fileEnv).toContain("PATH_TRANSLATED=/php-src/tests/harness.php");
    expect(fileEnv).toContain("SCRIPT_FILENAME=/php-src/tests/harness.php");
    for (const kind of ["skipif", "clean"] as const) {
      const env = runner.envByKind.get(kind) ?? [];
      expect(env.some((entry) => entry.startsWith("REQUEST_METHOD="))).toBe(false);
      expect(env.some((entry) => entry.startsWith("SCRIPT_FILENAME="))).toBe(false);
      expect(env.some((entry) => entry.startsWith("PATH_TRANSLATED="))).toBe(false);
    }
  });

  it("matches run-tests.php precedence for --ENV-- request variables", async () => {
    const runner = new ScriptedRunner({
      skipif: runResult(),
      file: runResult({ stdout: "ok" }),
      clean: runResult(),
    });
    const env = [
      "REDIRECT_STATUS=from-env",
      "QUERY_STRING=from-env",
      "PATH_TRANSLATED=/env/path.php",
      "SCRIPT_FILENAME=/env/script.php",
      "REQUEST_METHOD=POST",
      "CONTENT_TYPE=text/plain",
      "CONTENT_LENGTH=4",
      "HTTP_COOKIE=from-env",
      "TZ=UTC",
    ].join("\n");

    const result = await runPhpt(
      phpt({ ENV: env, SKIPIF: "<?php ?>", CLEAN: "<?php ?>" }),
      runner,
      new Set(),
      1000,
    );

    expect(result.status).toBe("pass");
    const skipEnv = runner.envByKind.get("skipif") ?? [];
    expect(skipEnv).toEqual(expect.arrayContaining([
      "REDIRECT_STATUS=from-env",
      "CONTENT_TYPE=text/plain",
      "CONTENT_LENGTH=4",
      "HTTP_COOKIE=from-env",
      "TZ=UTC",
    ]));
    for (const name of [
      "QUERY_STRING",
      "PATH_TRANSLATED",
      "SCRIPT_FILENAME",
      "REQUEST_METHOD",
    ]) {
      expect(skipEnv.some((entry) => entry.startsWith(`${name}=`))).toBe(false);
    }

    const fileEnv = runner.envByKind.get("file") ?? [];
    expect(fileEnv).toEqual(expect.arrayContaining([
      "REDIRECT_STATUS=1",
      "QUERY_STRING=from-env",
      "PATH_TRANSLATED=/env/path.php",
      "SCRIPT_FILENAME=/env/script.php",
      "REQUEST_METHOD=GET",
      "TZ=UTC",
    ]));
    expect(fileEnv.some((entry) => entry.startsWith("CONTENT_TYPE="))).toBe(false);
    expect(fileEnv.some((entry) => entry.startsWith("CONTENT_LENGTH="))).toBe(false);
    expect(fileEnv.some((entry) => entry.startsWith("HTTP_COOKIE="))).toBe(false);

    const cleanEnv = runner.envByKind.get("clean") ?? [];
    expect(cleanEnv).toEqual(expect.arrayContaining([
      "REDIRECT_STATUS=1",
      "TZ=UTC",
    ]));
    for (const name of [
      "QUERY_STRING",
      "PATH_TRANSLATED",
      "SCRIPT_FILENAME",
      "REQUEST_METHOD",
      "CONTENT_TYPE",
      "CONTENT_LENGTH",
      "HTTP_COOKIE",
    ]) {
      expect(cleanEnv.some((entry) => entry.startsWith(`${name}=`))).toBe(false);
    }
  });

  it("pins the complete run-tests.php baseline INI", async () => {
    const runner = new ScriptedRunner({ file: runResult({ stdout: "ok" }) });

    const result = await runPhpt(phpt({}), runner, new Set(), 1000);

    expect(result.status).toBe("pass");
    const argv = runner.argvByKind.get("file") ?? [];
    expect(argv).toContain("zend.exception_string_param_max_len=15");
    expect(argv).toContain("short_open_tag=0");
  });

  it.each([
    [
      { CAPTURE_STDIO: "STDOUT" },
      "partial CAPTURE_STDIO requires per-descriptor inheritance",
    ],
    [
      { EXTENSIONS: "opcache" },
      "opcache SHM mode requires unsupported cross-process MAP_SHARED",
    ],
  ] as Array<[Record<string, string>, string]>)(
    "reports an explicit platform boundary for %j",
    async (sections, reason) => {
    const runner = new ScriptedRunner({});

    const result = await runPhpt(phpt(sections), runner, new Set(), 1000);

    expect(result.status).toBe("unsupported");
    expect(result.reason).toContain(reason);
      expect(runner.calls).toEqual([]);
    },
  );

  it("allows manually loaded opcache when CLI caching stays disabled", async () => {
    const runner = new ScriptedRunner({
      file: runResult({ stdout: "ok" }),
    });
    const result = await runPhpt(
      phpt({
        FILE: `<?php
$cmd = [PHP_BINARY, '-dzend_extension=opcache.so'];
?>`,
      }),
      runner,
      new Set(["opcache"]),
      1000,
    );

    expect(result.status).toBe("pass");
    expect(runner.calls).toEqual(["file"]);
  });

  it("classifies manually activated opcache SHM mode as unsupported", async () => {
    const runner = new ScriptedRunner({});
    const result = await runPhpt(
      phpt({
        FILE: `<?php
$cmd = [PHP_BINARY, '-dzend_extension=opcache.so', '-dopcache.enable_cli=1'];
proc_open($cmd, [], $pipes);
?>`,
      }),
      runner,
      new Set(["opcache"]),
      1000,
    );

    expect(result.status).toBe("unsupported");
    expect(result.reason).toContain(
      "opcache SHM mode requires unsupported cross-process MAP_SHARED",
    );
    expect(runner.calls).toEqual([]);
  });

  it("allows manually loaded opcache in explicit file-cache-only mode", async () => {
    const runner = new ScriptedRunner({
      file: runResult({ stdout: "ok" }),
    });
    const result = await runPhpt(
      phpt({
        FILE: `<?php
$cmd = [
  PHP_BINARY,
  '-dzend_extension=opcache.so',
  '-dopcache.enable_cli=1',
  '-dopcache.file_cache_only=1',
  '-dopcache.file_cache=/tmp/opcache',
];
?>`,
      }),
      runner,
      new Set(["opcache"]),
      1000,
    );

    expect(result.status).toBe("pass");
    expect(runner.calls).toEqual(["file"]);
  });

  it("reports PHPDBG unsupported even when the standard phpdbg variable is set", async () => {
    const previous = process.env.TEST_PHPDBG_EXECUTABLE;
    process.env.TEST_PHPDBG_EXECUTABLE = "/usr/local/bin/phpdbg";
    try {
      const runner = new ScriptedRunner({});
      const result = await runPhpt(
        phpt({ PHPDBG: "run\nquit" }),
        runner,
        new Set(),
        1000,
      );

      expect(result.status).toBe("unsupported");
      expect(result.reason).toContain("phpdbg SAPI");
      expect(runner.calls).toEqual([]);
    } finally {
      if (previous === undefined) {
        delete process.env.TEST_PHPDBG_EXECUTABLE;
      } else {
        process.env.TEST_PHPDBG_EXECUTABLE = previous;
      }
    }
  });

  it("runs FILE after SKIPIF synthesizes XFAIL", async () => {
    const runner = new ScriptedRunner({
      skipif: runResult({ stdout: "xfail known upstream defect" }),
      file: runResult({ stdout: "wrong" }),
    });

    const result = await runPhpt(
      phpt({ SKIPIF: "<?php echo 'xfail known upstream defect'; ?>" }),
      runner,
      new Set(),
      1000,
    );

    expect(runner.calls).toEqual(["skipif", "file"]);
    expect(result.status).toBe("xfail");
    expect(result.reason).toBe("known upstream defect");
  });

  it("borks non-directive SKIPIF output without running FILE", async () => {
    const runner = new ScriptedRunner({
      skipif: runResult({ stdout: "unexpected diagnostic" }),
    });

    const result = await runPhpt(
      phpt({ SKIPIF: "<?php echo 'unexpected diagnostic'; ?>" }),
      runner,
      new Set(),
      1000,
    );

    expect(runner.calls).toEqual(["skipif"]);
    expect(result.status).toBe("bork");
    expect(result.reason).toBe("invalid output from SKIPIF");
  });

  it("uses stdout for SKIPIF verdicts and keeps stderr diagnostic-only", async () => {
    const runner = new ScriptedRunner({
      skipif: runResult({
        stdout: "skip lsof(8) not available",
        stderr: "sh: lsof: not found",
        output: "sh: lsof: not found\nskip lsof(8) not available",
      }),
    });

    const result = await runPhpt(
      phpt({ SKIPIF: "<?php echo 'skip lsof(8) not available'; ?>" }),
      runner,
      new Set(),
      1000,
    );

    expect(runner.calls).toEqual(["skipif"]);
    expect(result.status).toBe("skip");
    expect(result.reason).toBe("skip lsof(8) not available");
  });

  it("honors a stdout nocache directive despite interleaved stderr", async () => {
    const runner = new ScriptedRunner({
      skipif: runResult({
        stdout: "nocache",
        stderr: "diagnostic",
        output: "diagnostic\nnocache",
      }),
      file: runResult({ stdout: "ok" }),
    });

    const result = await runPhpt(
      phpt({ SKIPIF: "<?php echo 'nocache'; ?>" }),
      runner,
      new Set(),
      1000,
    );

    expect(runner.calls).toEqual(["skipif", "file"]);
    expect(result.status).toBe("pass");
  });

  it.each(["info context", "flaky timing", "xleak known leak"])(
    "accepts the upstream SKIPIF directive %s",
    async (directive) => {
      const runner = new ScriptedRunner({
        skipif: runResult({ stdout: directive }),
        file: runResult({ stdout: "ok" }),
      });

      const result = await runPhpt(
        phpt({ SKIPIF: `<?php echo ${JSON.stringify(directive)}; ?>` }),
        runner,
        new Set(),
        1000,
      );

      expect(runner.calls).toEqual(["skipif", "file"]);
      expect(result.status).toBe("pass");
    },
  );

  it("reports WARN after a SKIPIF warning even when FILE matches", async () => {
    const runner = new ScriptedRunner({
      skipif: runResult({ stdout: "warn constrained environment" }),
      file: runResult({ stdout: "ok" }),
    });

    const result = await runPhpt(
      phpt({ SKIPIF: "<?php echo 'warn constrained environment'; ?>" }),
      runner,
      new Set(),
      1000,
    );

    expect(runner.calls).toEqual(["skipif", "file"]);
    expect(result.status).toBe("warn");
    expect(result.reason).toContain("constrained environment");
  });

  it("reports FAIL with warning context when warned SKIPIF precedes a mismatch", async () => {
    const runner = new ScriptedRunner({
      skipif: runResult({ stdout: "warn constrained environment" }),
      file: runResult({ stdout: "wrong" }),
    });

    const result = await runPhpt(
      phpt({ SKIPIF: "<?php echo 'warn constrained environment'; ?>" }),
      runner,
      new Set(),
      1000,
    );

    expect(result.status).toBe("fail");
    expect(result.reason).toContain("constrained environment");
    expect(result.detail).toBeDefined();
  });

  it("retries a flaky PHPT once and reports a retry-pass as WARN", async () => {
    const runner = new ScriptedRunner({
      file: [
        runResult({ stdout: "transient mismatch" }),
        runResult({ stdout: "ok" }),
      ],
    });

    const result = await runPhpt(
      phpt({ FLAKY: "intermittent timing" }),
      runner,
      new Set(),
      1000,
    );

    expect(runner.calls).toEqual(["file", "file"]);
    expect(result.status).toBe("warn");
    expect(result.reason).toBe("test passed on retry attempt");
  });

  it("does not retry flaky infrastructure errors", async () => {
    const runner = new ScriptedRunner({
      file: runResult({ exitCode: -1, error: "worker crashed" }),
    });

    const result = await runPhpt(
      phpt({ FLAKY: "intermittent timing" }),
      runner,
      new Set(),
      1000,
    );

    expect(runner.calls).toEqual(["file"]);
    expect(result.status).toBe("fail");
  });

  it("borks output from CLEAN when the test otherwise passes", async () => {
    const runner = new ScriptedRunner({
      file: runResult({ stdout: "ok" }),
      clean: runResult({ stdout: "unexpected cleanup output" }),
    });

    const result = await runPhpt(
      phpt({ CLEAN: "<?php echo 'unexpected cleanup output'; ?>" }),
      runner,
      new Set(),
      1000,
    );

    expect(runner.calls).toEqual(["file", "clean"]);
    expect(result.status).toBe("bork");
    expect(result.detail).toContain("invalid output from CLEAN");
  });

  it.each([
    ["TIMEOUT", "time"],
    ["worker crashed", "fail"],
  ] as const)(
    "does not hide FILE infrastructure error %s behind XFAIL",
    async (error, expectedStatus) => {
      const runner = new ScriptedRunner({
        file: runResult({ exitCode: -1, error }),
      });

      const result = await runPhpt(
        phpt({ XFAIL: "known output mismatch" }),
        runner,
        new Set(),
        1000,
      );

      expect(result.status).toBe(expectedStatus);
    },
  );
});
