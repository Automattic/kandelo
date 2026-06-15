import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bootstrapPath = join(__dirname, "../bootstrap.js");

function loadFunction<T extends Function>(startMarker: string, endMarker: string, exportName: string): T {
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  const start = bootstrap.indexOf(startMarker);
  const end = bootstrap.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error(`could not locate ${exportName} in node-compat bootstrap`);
  }
  return vm.runInNewContext(`${bootstrap.slice(start, end)}\n${exportName};`, {
    Array,
    RegExp,
    Set,
    String,
  }) as T;
}

function resolvePath(cwd: string, value: string): string {
  if (value.startsWith("/")) return value;
  const parts = `${cwd}/${value}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

function loadCliHarness() {
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  const start = bootstrap.indexOf("const _originalDotenvEnvKeys");
  const end = bootstrap.indexOf("const _cliState", start);
  if (start === -1 || end === -1) {
    throw new Error("could not locate node CLI parser block");
  }

  const env: Record<string, string> = {};
  const files = new Map([
    [
      "/cwd/node-options.env",
      [
        "NODE_OPTIONS=\"--experimental-permission --allow-fs-read=*\"",
        "NODE_NO_WARNINGS=1",
      ].join("\n"),
    ],
    [
      "/cwd/valid.env",
      [
        "BASIC=basic",
        "AFTER_LINE=after_line",
      ].join("\n"),
    ],
  ]);
  const permissionState = { enabled: false, fsRead: [] as string[], fsWrite: [] as string[] };

  return vm.runInNewContext(
    `${bootstrap.slice(start, end)}\n({ _parseNodeCli, env: process.env, permissionState: _permissionState });`,
    {
      Array,
      Object,
      RegExp,
      Set,
      String,
      console,
      path: {
        isAbsolute: (value: string) => value.startsWith("/"),
        resolve: (...values: string[]) => resolvePath("/cwd", values.join("/")),
      },
      process: {
        cwd: () => "/cwd",
        env,
        execPath: "/usr/bin/node",
      },
      std: {
        getenv: (key: string) => env[key] ?? null,
        loadFile: (filename: string) => files.get(filename) ?? null,
        exit: (code: number) => {
          throw new Error(`std.exit(${code})`);
        },
      },
      _cliOptionValues: Object.create(null),
      _permissionState: permissionState,
      _setPermissionAllowList(kind: string, value: string) {
        permissionState.enabled = true;
        const list = String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
        if (kind === "fs.read") permissionState.fsRead = list;
        if (kind === "fs.write") permissionState.fsWrite = list;
      },
    },
  ) as {
    _parseNodeCli(argv: string[]): {
      argv: string[];
      execArgv: string[];
      evalSource: string | null;
      error: null | { status: number; message: string };
    };
    env: Record<string, string>;
    permissionState: { enabled: boolean; fsRead: string[]; fsWrite: string[] };
  };
}

describe("node-compat dotenv and NODE_OPTIONS parsing", () => {
  it("matches Node dotenv quoting, comments, exports, and multiline values", () => {
    const parseDotenvSource = loadFunction<(source: string) => Array<[string, string]>>(
      "function _findDotenvAssignment",
      "function _loadDotenvFile",
      "_parseDotenvSource",
    );

    const entries = new Map(parseDotenvSource(`
BASIC=basic
EMPTY=
SINGLE='single # kept'
DOUBLE="double\\nline # kept"
BACKTICK=\`backtick "and ' kept"\`
INLINE=inline value # removed
HASH=before#removed
    SPACED_KEY = parsed
export EXAMPLE = ignore export
MULTI="THIS
IS
MULTILINE"
BAD_QUOTE="
AFTER_BAD=still parsed
`));

    expect(entries.get("BASIC")).toBe("basic");
    expect(entries.get("EMPTY")).toBe("");
    expect(entries.get("SINGLE")).toBe("single # kept");
    expect(entries.get("DOUBLE")).toBe("double\nline # kept");
    expect(entries.get("BACKTICK")).toBe("backtick \"and ' kept\"");
    expect(entries.get("INLINE")).toBe("inline value");
    expect(entries.get("HASH")).toBe("before");
    expect(entries.get("SPACED_KEY")).toBe("parsed");
    expect(entries.get("EXAMPLE")).toBe("ignore export");
    expect(entries.get("MULTI")).toBe("THIS\nIS\nMULTILINE");
    expect(entries.get("BAD_QUOTE")).toBe("\"");
    expect(entries.get("AFTER_BAD")).toBe("still parsed");
  });

  it("splits NODE_OPTIONS with shell-style quotes", () => {
    const splitNodeOptions = loadFunction<(value: string) => string[]>(
      "function _splitNodeOptions",
      "const _NODE_OPTIONS_DISALLOWED",
      "_splitNodeOptions",
    );

    expect(splitNodeOptions("--experimental-permission --allow-fs-read=*")).toEqual([
      "--experimental-permission",
      "--allow-fs-read=*",
    ]);
    expect(splitNodeOptions("--require './space dir/register.js' --title=\"hello world\"")).toEqual([
      "--require",
      "./space dir/register.js",
      "--title=hello world",
    ]);
  });

  it("loads CLI env files before parsing NODE_OPTIONS", () => {
    const harness = loadCliHarness();
    const state = harness._parseNodeCli([
      "node",
      "--env-file",
      "node-options.env",
      "--eval",
      "process.permission.has('fs.read')",
    ]);

    expect(state.error).toBeNull();
    expect(state.argv).toEqual(["/usr/bin/node"]);
    expect(state.execArgv).toEqual([
      "--env-file",
      "node-options.env",
      "--eval",
      "process.permission.has('fs.read')",
    ]);
    expect(state.evalSource).toBe("process.permission.has('fs.read')");
    expect(harness.env.NODE_NO_WARNINGS).toBe("1");
    expect(harness.permissionState).toEqual({
      enabled: true,
      fsRead: ["*"],
      fsWrite: [],
    });
  });

  it("does not override lazily discovered OS environment variables", () => {
    const harness = loadCliHarness();
    harness.env.BASIC = "existing";

    const state = harness._parseNodeCli([
      "node",
      "--env-file",
      "valid.env",
      "--eval",
      "process.env.BASIC",
    ]);

    expect(state.error).toBeNull();
    expect(harness.env.BASIC).toBe("existing");
    expect(harness.env.AFTER_LINE).toBe("after_line");
  });
});
