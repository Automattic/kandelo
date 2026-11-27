/**
 * Real C guests rewritten by wasm-memory-instrument fork with `forkMemory`
 * set to "copy" and to "share" on each browser host. The device programs bind
 * a host view to guest pages before the fork.
 *
 * Each program also runs in its plain form with the rewrite-at-exec mark.
 * In "copy" mode the mark has no effect. In "share" mode the host makes the
 * rewritten form. With a share threshold above every address space, each
 * fork child gets a private Memory and runs the plain form.
 *
 * `sideModuleCompiles` is the count of side module compiles in the `dlopen`
 * program, which has a fork child and a fork grandchild. A fork child takes
 * the compiled module of its parent, so only the first process compiles. A
 * plain fork child of a rewritten parent instantiates another form, so it
 * compiles one time more.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "../playwright-test";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

interface Program {
  name: string;
  linkArgs: string[];
  stdout: string[];
  forkInstrumentArgs?: string[];
  /** Guest path of the side module, passed as `argv[1]`. */
  libraryPath?: string;
}

const glue = fileURLToPath(new URL("../../../libc/glue", import.meta.url));
const fixtureSource = (name: string): URL =>
  new URL(`../../../host/test/fixtures/fork-share-${name}.c`, import.meta.url);

const programs: Program[] = [
  {
    name: "private-pages",
    linkArgs: [],
    stdout: [
      "child inherited=1 grandchild=43 kept=1",
      "parent forked=1 child=42 kept=1",
    ],
  },
  { name: "moved", linkArgs: [], stdout: ["first=41 second=42 kept=1"] },
  { name: "dumb-buffer", linkArgs: [], stdout: ["parent child=42 failed=0"] },
  { name: "framebuffer", linkArgs: [], stdout: ["parent child=42 failed=0"] },
  {
    name: "gl",
    linkArgs: ["-lgbm", "-ldrm", "-lEGL", "-lGLESv2"],
    stdout: ["parent child=42 failed=0"],
  },
  {
    name: "dlopen",
    // The library resolves libc symbols against the exports of the program.
    linkArgs: ["-ldl", "-Wl,--export-all"],
    // The program loads a plugin that forks, which the default
    // traced-entries contract refuses.
    forkInstrumentArgs: ["--side-modules", "assume-all-entries-fork-returning"],
    libraryPath: "/usr/local/lib/fork-share-dlopen-library.so",
    stdout: [
      "child inherited=1 grandchild=43 kept=1",
      "parent initial=1 forked=1 child=42 kept=1",
    ],
  },
];

const modes = [
  { name: "forkMemory copy", form: "rewritten", forkMemory: "copy", sideModuleCompiles: 1 },
  { name: "forkMemory share", form: "rewritten", forkMemory: "share", sideModuleCompiles: 1 },
  { name: "the mark and forkMemory copy", form: "marked", forkMemory: "copy", sideModuleCompiles: 1 },
  {
    name: "a rewrite at exec and shared fork children",
    form: "marked",
    forkMemory: "share",
    sideModuleCompiles: 1,
  },
  {
    name: "a rewrite at exec and plain fork children",
    form: "marked",
    forkMemory: "share",
    forkShareMinimumBytes: 2 ** 32,
    sideModuleCompiles: 2,
  },
] as const;

test.use({ serviceWorkers: "block" });
const fixtures = new Map<string, ReturnType<typeof compileSdkFixture>>();
test.beforeAll(() => {
  for (const { name, linkArgs, forkInstrumentArgs } of programs) {
    for (const [form, memoryInstrument] of [["rewritten", true], ["marked", "at-exec"]] as const) {
      fixtures.set(`${name} ${form}`, compileSdkFixture(
        fixtureSource(name),
        linkArgs,
        { forkInstrument: true, forkInstrumentArgs, memoryInstrument },
      ));
    }
  }
  // The host rewrites a side module when a process with page tables loads
  // it, so the library is not memory-instrumented here.
  fixtures.set("dlopen-library", compileSdkFixture(
    fixtureSource("dlopen-library"),
    ["-shared", "-fPIC", `-I${glue}`],
    { forkInstrument: true, forkInstrumentArgs: ["--entry", "env.fork"] },
  ));
});
test.afterAll(() => { for (const fixture of fixtures.values()) fixture.cleanup(); });

for (const { name, stdout, libraryPath } of programs) {
  for (const { form, forkMemory, ...mode } of modes) {
    test(`fork-share-${name} passes with ${mode.name}`, async ({ page, baseURL }) => {
      test.setTimeout(60_000);
      const image = KandeloImageFs.create();
      image.mkdir("/bin", 0o755);
      image.writeFile("/bin/probe", readFileSync(fixtures.get(`${name} ${form}`)!.programPath), 0o755);
      if (libraryPath) {
        image.ensureDirRecursive(libraryPath);
        image.writeFile(libraryPath, readFileSync(fixtures.get("dlopen-library")!.programPath), 0o755);
      }
      const imageBytes = await image.saveImage();
      await page.route("**/__fork_share_kernel", route => route.fulfill({
        body: readFileSync(resolveBinary("kernel.wasm")),
      }));
      await page.route("**/__fork_share_image", route => route.fulfill({ body: Buffer.from(imageBytes) }));
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
      const result = await page.evaluate(async ({ moduleUrl, forkMemory, forkShareMinimumBytes, argv }) => {
        const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
        const state = { stdout: "", stderr: "" };
        const kernel = new BrowserKernel({
          kernelOwnedFs: true,
          forkMemory,
          forkShareMinimumBytes,
          onStdout: (data: Uint8Array) => { state.stdout += new TextDecoder().decode(data); },
          onStderr: (data: Uint8Array) => { state.stderr += new TextDecoder().decode(data); },
        });
        try {
          await kernel.initFromImage({
            kernelWasm: await (await fetch("/__fork_share_kernel")).arrayBuffer(),
            vfsImage: new Uint8Array(await (await fetch("/__fork_share_image")).arrayBuffer()),
          });
          const child = await kernel.spawnFromVfs("/bin/probe", argv);
          const exitCode = await child.exit;
          const { sideModuleCompiles } = await kernel.getWasmModuleCacheStats();
          return { ...state, exitCode, sideModuleCompiles };
        } finally {
          await kernel.destroy();
        }
      }, {
        moduleUrl: new URL(`/@fs${modulePath}`, baseURL).href,
        forkMemory,
        forkShareMinimumBytes: "forkShareMinimumBytes" in mode ? mode.forkShareMinimumBytes : undefined,
        argv: ["probe", ...(libraryPath ? [libraryPath] : [])],
      });
      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(stdout);
      expect(result.stderr).toBe("");
      expect(result.sideModuleCompiles).toBe(libraryPath ? mode.sideModuleCompiles : 0);
      expect(errors).toEqual([]);
    });
  }
}
