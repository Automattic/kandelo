import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");

it("evdev preserves device order, emits text and modifiers, and respects StopTextInput", async () => {
  const temp = mkdtempSync(join(tmpdir(), "kandelo-sdl-text-"));
  let output = "";
  const record = (_pid: number, bytes: Uint8Array) => { output += new TextDecoder().decode(bytes); };
  const host = new NodeKernelHost({ onStdout: record, onStderr: record });
  try {
    // Enter through the resolver, including its active cache policy and
    // receipt checks; never scan caches or assume a staged library prefix.
    const xtask = process.env.WASM_POSIX_XTASK_BIN;
    const command = xtask ?? "cargo";
    const hostTarget = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)![1];
    const prefix = xtask ? [] : ["run", "-p", "xtask", "--target", hostTarget, "--quiet", "--"];
    const paths = new Map<string, string>();
    for (const name of ["sdl2", "libwayland", "libxkbcommon", "libffi", "libdrm"]) {
      paths.set(name, execFileSync(command, [...prefix, "build-deps", "resolve", name, "--arch", "wasm32"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").at(-1)!);
    }
    const wasm = join(temp, "text-input.wasm");
    execFileSync(join(root, "sdk/bin/wasm32posix-cc"), [
      "-O2", `-I${paths.get("sdl2")}/include`, join(here, "text-input.c"),
      ...[...paths.values()].map(path => `-L${path}/lib`),
      "-lSDL2", "-lwayland-client", "-lwayland-egl", "-lwayland-cursor", "-lxkbcommon", "-lffi", "-lgbm", "-ldrm", "-lEGL", "-lGLESv2", "-lm", "-o", `${wasm}.linked`,
    ], { cwd: root, stdio: "inherit" });
    execFileSync("bash", [join(root, "scripts/run-wasm-fork-instrument.sh"), `${wasm}.linked`, "-o", wasm],
      { cwd: root, stdio: "inherit" });
    execFileSync(command, [...prefix, "stamp-abi-contract", wasm], { cwd: root, stdio: "inherit" });
    await host.init();
    let pid = 0;
    const exit = host.spawn(new Uint8Array(readFileSync(wasm)).buffer, ["sdl-text-input"], {
      onStarted: started => { pid = started; },
    });
    await expect.poll(() => output, { timeout: 30_000 }).toContain("READY:0");
    const key = (code: number, value: number) => host.injectInputEvent(0, 1, code, value);
    const tap = (code: number) => { key(code, 1); key(code, 0); };
    tap(2); tap(3); tap(30); // 12a
    key(42, 1); tap(30); tap(2); key(42, 0); // A!
    tap(58); tap(30); key(42, 1); tap(30); key(42, 0); tap(58); // Aa
    tap(69); tap(79); tap(83); // NumLock: keypad 1 and decimal
    key(2, 1); key(2, 2); key(2, 0); // repeat: 11
    for (const modifier of [29, 56, 125]) { key(modifier, 1); tap(30); key(modifier, 0); }
    tap(14); tap(111); // Backspace/Delete remain key events only.
    host.injectInputEvent(0, 0, 0, 0);
    host.appendStdinData(pid, new Uint8Array([120]));
    await expect.poll(() => output, { timeout: 30_000 }).toContain("READY:1");
    const text = [...output.matchAll(/^TEXT:0:(.*)$/gm)].map(match => match[1]).join("");
    expect(text, output).toBe("12aA!Aa1.11");
    expect(output).toContain("KEY:0:8");
    expect(output).toContain("KEY:0:127");
    tap(30);
    host.injectInputEvent(0, 0, 0, 0);
    host.appendStdinData(pid, new Uint8Array([120]));
    await expect.poll(() => output, { timeout: 30_000 }).toContain("READY:2");
    // Both devices have more than one 32-record batch pending before SDL
    // pumps. Enumeration order must not turn click-then-Tab into Tab-then-click.
    for (let round = 0; round < 12; round++) {
      host.injectInputEvent(1, 1, 272, 1);
      host.injectInputEvent(1, 1, 272, 0);
      host.injectInputEvent(1, 0, 0, 0);
      tap(15);
      host.injectInputEvent(0, 0, 0, 0);
      host.injectInputEvent(1, 1, 273, 1);
      host.injectInputEvent(1, 1, 273, 0);
      host.injectInputEvent(1, 0, 0, 0);
      tap(1);
      host.injectInputEvent(0, 0, 0, 0);
    }
    host.appendStdinData(pid, new Uint8Array([120]));
    await expect.poll(() => output, { timeout: 30_000 }).toContain("READY:3");
    host.injectInputEvent(1, 1, 272, 1);
    host.injectInputEvent(1, 0, 0, 0);
    host.appendStdinData(pid, new Uint8Array([120]));
    await expect.poll(() => output, { timeout: 30_000 }).toContain("READY:4");
    expect(output).toContain("BUTTONS:3:1");
    // A slow guest can lose a release to its bounded evdev ring. The
    // device's EVIOCGKEY state remains authoritative after SYN_DROPPED.
    host.injectInputEvent(1, 1, 272, 0);
    for (let i = 0; i < 1200; i++) {
      host.injectInputEvent(1, 3, 0, i % 1000);
      host.injectInputEvent(1, 0, 0, 0);
    }
    host.appendStdinData(pid, new Uint8Array([120]));
    await expect.poll(() => output, { timeout: 30_000 }).toContain("READY:5");
    host.injectInputEvent(1, 1, 272, 1);
    host.injectInputEvent(1, 1, 272, 0);
    host.injectInputEvent(1, 0, 0, 0);
    host.appendStdinData(pid, new Uint8Array([120]));
    expect(await exit, output).toBe(0);
    expect(output).toContain("DEVICE:0:3:199:0");
    expect(output).toContain("MOUSE:5:1:1");
    expect(output).toContain("MOUSE:5:1:0");
    expect(output, "SDL must recover the release after evdev overflow").toContain("BUTTONS:4:0");
    expect(output.split("\n").filter(line => /^(?:KEY|MOUSE):2:/.test(line)), output).toEqual(Array.from({ length: 12 }, () => [
      "MOUSE:2:1:1", "MOUSE:2:1:0", "KEY:2:9",
      "MOUSE:2:3:1", "MOUSE:2:3:0", "KEY:2:27",
    ]).flat());
    expect(output).toContain("KEY:1:97");
    expect(output).not.toContain("TEXT:1:");
  } finally {
    await host.destroy();
    rmSync(temp, { recursive: true, force: true });
  }
}, 180_000);
