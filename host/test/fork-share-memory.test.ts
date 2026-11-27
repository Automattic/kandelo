/**
 * Runs programs rewritten by wasm-memory-instrument with `forkMemory` set to
 * "copy" and to "share". In "share" mode a fork child keeps its parent's
 * Memory and gets its own page tables, so each program checks that a write
 * on one side of a fork never shows on the other side.
 *
 * Each program also runs in its plain form with the rewrite-at-exec mark.
 * In "copy" mode the mark has no effect. In "share" mode the host makes the
 * rewritten form. With a share threshold above every address space, each
 * fork child gets a private Memory and runs the plain form.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { compileSdkFixture } from "./support/compile-sdk-fixture";

type Fixture = ReturnType<typeof compileSdkFixture>;

interface Program {
  name: string;
  stdout: string[];
  linkArgs?: string[];
  forkInstrumentArgs?: string[];
  /** Guest path of the program itself, passed as `argv[1]`. */
  ownPath?: string;
  /** Guest path of the side module, passed as `argv[1]`. */
  libraryPath?: string;
}

const glue = fileURLToPath(new URL("../../libc/glue", import.meta.url));
const fixtureSource = (name: string): URL =>
  new URL(`./fixtures/fork-share-${name}.c`, import.meta.url);

const modes = [
  { name: "forkMemory copy", form: "rewritten", forkMemory: "copy" },
  { name: "forkMemory share", form: "rewritten", forkMemory: "share" },
  { name: "the mark and forkMemory copy", form: "marked", forkMemory: "copy" },
  { name: "a rewrite at exec and shared fork children", form: "marked", forkMemory: "share" },
  {
    name: "a rewrite at exec and plain fork children",
    form: "marked",
    forkMemory: "share",
    forkShareMinimumBytes: 2 ** 32,
  },
] as const;

const programs: Program[] = [
  {
    name: "private-pages",
    stdout: [
      "child inherited=1 grandchild=43 kept=1",
      "parent forked=1 child=42 kept=1",
    ],
  },
  { name: "moved", stdout: ["first=41 second=42 kept=1"] },
  {
    name: "growth",
    stdout: ["zero=1 kept=1 heap=3 map=5 size=145800000"],
  },
  {
    name: "syscalls",
    stdout: ["child failed=0", "parent forked=1 child=42 failed=0"],
  },
  { name: "exec", stdout: ["parent first=41 second=43"] },
  {
    name: "exec-parent",
    stdout: ["stage2 child=1 status=3 fresh=1 next=6"],
    ownPath: "/usr/local/bin/fork-share-exec-parent",
  },
  {
    name: "shared-mapping",
    stdout: ["parent child=42 failed=0 head=1,2 tail=3"],
  },
  {
    name: "shared-mapping-generations",
    stdout: ["parent child=42 failed=0"],
  },
  {
    name: "exit",
    stdout: [
      "blocked signaled=1 sig=9",
      "blocked fork-after=1",
      "running signaled=1 sig=9",
      "running fork-after=1",
      "orphan middle=5 byte=k kept=1",
      "orphan fork-after=1",
      "loop reaped=40",
    ],
  },
  {
    name: "threads",
    stdout: [
      "child inherited=1 started=1 grandchild=43 kept=1",
      "parent created=1 filled=1 forked=1 joined=1 child=42 kept=1",
    ],
  },
  {
    name: "thread-copies",
    stdout: [
      "child before=1 wrote=1 after=1 got=1 errno=0",
      "parent wrote=1 answered=1 kept=1 again=1 child=42",
    ],
  },
  {
    name: "running-thread",
    stdout: [
      "child stable=1 nonzero=1",
      "parent created=1 forked=1 advanced=1 joined=1 child=42 kept=1",
    ],
  },
  {
    name: "running-threads",
    stdout: [
      "writers good=12 torn=0",
      "reader good=12 torn=0",
      "after good=12 torn=0",
      "parent advanced=3 torn=0",
    ],
  },
  {
    name: "dlopen",
    stdout: [
      "child inherited=1 grandchild=43 kept=1",
      "parent initial=1 forked=1 child=42 kept=1",
    ],
    // The library resolves libc symbols against the exports of the program.
    linkArgs: ["-ldl", "-Wl,--export-all"],
    // The program loads a plugin that forks, which the default
    // traced-entries contract refuses.
    forkInstrumentArgs: ["--side-modules", "assume-all-entries-fork-returning"],
    libraryPath: "/usr/local/lib/fork-share-dlopen-library.so",
  },
  { name: "reuse", stdout: ["reaped=64 bounded=1"] },
  { name: "dumb-buffer", stdout: ["parent child=42 failed=0"] },
  { name: "framebuffer", stdout: ["parent child=42 failed=0"] },
];

describe.each(programs)("fork-share-$name", (program) => {
  let fixtures: { rewritten: Fixture; marked: Fixture } | undefined;
  let library: Fixture | undefined;

  beforeAll(() => {
    const compile = (memoryInstrument: true | "at-exec"): Fixture => compileSdkFixture(
      fixtureSource(program.name),
      program.linkArgs,
      {
        forkInstrument: true,
        forkInstrumentArgs: program.forkInstrumentArgs,
        memoryInstrument,
      },
    );
    const rewritten = compile(true);
    try {
      fixtures = { rewritten, marked: compile("at-exec") };
    } catch (error) { rewritten.cleanup(); throw error; }
    if (!program.libraryPath) return;
    // The host rewrites a side module when a process with page tables loads
    // it, so the library is not memory-instrumented here.
    library = compileSdkFixture(
      fixtureSource("dlopen-library"),
      ["-shared", "-fPIC", `-I${glue}`],
      { forkInstrument: true, forkInstrumentArgs: ["--entry", "env.fork"] },
    );
  }, 120_000);

  afterAll(() => {
    fixtures?.rewritten.cleanup();
    fixtures?.marked.cleanup();
    library?.cleanup();
  });

  it.each(modes)("passes with $name", async ({ form, forkMemory, ...mode }) => {
    const fixture = fixtures![form];
    const execPrograms = new Map<string, string>();
    if (program.ownPath) execPrograms.set(program.ownPath, fixture.programPath);
    if (program.libraryPath) execPrograms.set(program.libraryPath, library!.programPath);
    const guestPath = program.ownPath ?? program.libraryPath;

    const result = await runCentralizedProgram({
      programPath: fixture.programPath,
      argv: [`fork-share-${program.name}`, ...(guestPath ? [guestPath] : [])],
      forkMemory,
      forkShareMinimumBytes: "forkShareMinimumBytes" in mode ? mode.forkShareMinimumBytes : undefined,
      execPrograms,
      timeout: 60_000,
    });

    expect(result.exitCode, `stderr=${result.stderr}\nstdout=${result.stdout}`).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(program.stdout);
  }, 70_000);
});
