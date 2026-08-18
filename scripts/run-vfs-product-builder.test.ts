import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  runVfsProductBuilder,
  runVfsProductBuilderCli,
  type VfsProductBuilderDependencies,
  type VfsProductBuilderOptions,
} from "./run-vfs-product-builder";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("runs the manifest builder with no credentials and one short private socket temp", async () => {
  await withFixture(async ({ options, calls }) => {
    const credentials = {
      GITHUB_TOKEN: "github-secret",
      GH_TOKEN: "gh-secret",
      HOMEBREW_GITHUB_API_TOKEN: "brew-secret",
      NPM_TOKEN: "npm-secret",
      NODE_AUTH_TOKEN: "node-secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      CARGO_REGISTRY_TOKEN: "cargo-secret",
    };
    const previous = Object.fromEntries(
      Object.keys(credentials).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, credentials);
    try {
      await runVfsProductBuilder(options, successfulDependencies(options, calls));
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    assert.deepEqual(calls.events, ["validate-inputs", "launch", "compare-report"]);
    assert.equal(calls.builderPath, join(repositoryRoot, "scripts/run-vfs-product-builder.ts"));
    assert.deepEqual(calls.args, [
      "--vfs-product-manifest",
      options.manifestPath,
      "--vfs-product-inputs",
      options.inputsPath,
      "--vfs-product-report",
      options.reportPath,
      "--vfs-product-output",
      options.outputPath,
    ]);
    assert.equal(calls.cwd, options.workDir);
    for (const key of Object.keys(credentials)) {
      assert.equal(calls.env?.[key], undefined, `${key} reached builder`);
    }
    assert.equal(calls.env?.HOME, join(options.workDir, "home"));
    assert.equal(calls.tempExistedDuringLaunch, true);
    assert.ok(calls.env?.TMPDIR);
    assert.ok(
      Buffer.byteLength(calls.env.TMPDIR) <= 80,
      `builder socket temp path is too long: ${calls.env.TMPDIR}`,
    );
    assert.equal(existsSync(calls.env.TMPDIR), false);
    assert.equal(calls.env?.CI, "true");
  });
});

test("production CLI maps one exact argv scope into the protected runner", async () => {
  await withFixture(async ({ options, calls }) => {
    await runVfsProductBuilderCli([
      "--inputs",
      options.inputsPath,
      "--manifest",
      options.manifestPath,
      "--output",
      options.outputPath,
      "--report",
      options.reportPath,
      "--work-dir",
      options.workDir,
    ], successfulDependencies(options, calls));
    assert.deepEqual(calls.events, [
      "validate-inputs",
      "launch",
      "compare-report",
    ]);
  });
});

test("rejects preexisting and symlinked outputs before launching", async () => {
  await withFixture(async ({ options, calls }) => {
    writeFileSync(options.outputPath, "existing");
    await assert.rejects(
      runVfsProductBuilder(options, successfulDependencies(options, calls)),
      /output.*already exists/i,
    );
    assert.deepEqual(calls.events, []);
  });

  if (process.platform !== "win32") {
    await withFixture(async ({ options, calls, directory }) => {
      const target = join(directory, "outside.vfs");
      writeFileSync(target, "outside");
      symlinkSync(target, options.outputPath);
      await assert.rejects(
        runVfsProductBuilder(options, successfulDependencies(options, calls)),
        /output.*already exists|symbolic link/i,
      );
      assert.deepEqual(calls.events, []);
    });
  }
});

test("fails closed on a nonzero builder, missing report, or rejected report", async () => {
  await withFixture(async ({ options, calls }) => {
    const dependencies = successfulDependencies(options, calls);
    dependencies.launch = async () => {
      calls.events.push("launch");
      return { exitCode: 9 };
    };
    await assert.rejects(
      runVfsProductBuilder(options, dependencies),
      /exited with status 9/,
    );
    assert.deepEqual(calls.events, ["validate-inputs", "launch"]);
  });

  await withFixture(async ({ options, calls }) => {
    const dependencies = successfulDependencies(options, calls);
    dependencies.launch = async () => {
      calls.events.push("launch");
      writeFileSync(options.outputPath, "output");
      return { exitCode: 0 };
    };
    await assert.rejects(
      runVfsProductBuilder(options, dependencies),
      /builder report.*regular nonsymlink file/i,
    );
    assert.deepEqual(calls.events, ["validate-inputs", "launch"]);
  });

  await withFixture(async ({ options, calls }) => {
    const dependencies = successfulDependencies(options, calls);
    dependencies.compareReport = async () => {
      calls.events.push("compare-report");
      throw new Error("Rust validator rejected report");
    };
    await assert.rejects(
      runVfsProductBuilder(options, dependencies),
      /Rust validator rejected report/,
    );
    assert.deepEqual(calls.events, ["validate-inputs", "launch", "compare-report"]);
  });
});

test("rejects work-directory escape, a nonempty work directory, and a symlinked work directory", async () => {
  await withFixture(async ({ options, calls }) => {
    const escaped = { ...options, outputPath: join(options.workDir, "../escape.vfs") };
    await assert.rejects(
      runVfsProductBuilder(escaped, successfulDependencies(escaped, calls)),
      /output.*inside.*work directory/i,
    );
  });

  await withFixture(async ({ options, calls }) => {
    writeFileSync(join(options.workDir, "ambient-cache"), "cache");
    await assert.rejects(
      runVfsProductBuilder(options, successfulDependencies(options, calls)),
      /work directory.*empty/i,
    );
  });

  if (process.platform !== "win32") {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-vfs-runner-link-"));
    try {
      const actual = join(directory, "actual");
      const linked = join(directory, "linked");
      mkdirSync(actual);
      symlinkSync(actual, linked, "dir");
      const options = fixtureOptions(directory, linked);
      writeFixtureInputs(options);
      await assert.rejects(
        runVfsProductBuilder(options, successfulDependencies(options, emptyCalls())),
        /work directory.*nonsymlink/i,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

interface Calls {
  events: string[];
  builderPath?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  tempExistedDuringLaunch?: boolean;
}

function emptyCalls(): Calls {
  return { events: [] };
}

function successfulDependencies(
  options: VfsProductBuilderOptions,
  calls: Calls,
): VfsProductBuilderDependencies {
  return {
    validateInputs: async (inputsPath) => {
      calls.events.push("validate-inputs");
      assert.equal(inputsPath, options.inputsPath);
    },
    launch: async (builderPath, args, env, cwd) => {
      calls.events.push("launch");
      calls.builderPath = builderPath;
      calls.args = args;
      calls.env = env;
      calls.cwd = cwd;
      calls.tempExistedDuringLaunch = existsSync(env.TMPDIR);
      writeFileSync(options.outputPath, "output");
      writeFileSync(options.reportPath, "report");
      return { exitCode: 0 };
    },
    compareReport: async (inputsPath, reportPath) => {
      calls.events.push("compare-report");
      assert.equal(inputsPath, options.inputsPath);
      assert.equal(reportPath, options.reportPath);
    },
  };
}

async function withFixture(
  run: (fixture: {
    directory: string;
    options: VfsProductBuilderOptions;
    calls: Calls;
  }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-vfs-runner-"));
  const workDir = join(directory, "work");
  mkdirSync(workDir);
  const options = fixtureOptions(directory, workDir);
  writeFixtureInputs(options);
  const calls = emptyCalls();
  try {
    await run({ directory, options, calls });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function fixtureOptions(
  directory: string,
  workDir: string,
): VfsProductBuilderOptions {
  return {
    manifestPath: join(directory, "mini-product.toml"),
    inputsPath: join(directory, "resolved-inputs.json"),
    reportPath: join(workDir, "builder-report.json"),
    outputPath: join(workDir, "mini-shell.vfs"),
    workDir,
  };
}

function writeFixtureInputs(options: VfsProductBuilderOptions): void {
  writeFileSync(
    options.manifestPath,
    'schema = 1\nid = "mini-shell"\narchitecture = "wasm32"\noutput = "mini-shell.vfs"\nbuilder = "scripts/run-vfs-product-builder.ts"\n',
  );
  writeFileSync(options.inputsPath, '{}\n');
}
