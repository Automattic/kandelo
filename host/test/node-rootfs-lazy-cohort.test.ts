import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

describe("Node native rootfs lazy cohort", () => {
  it("pins the complete native image cohort in one off-thread checkpoint on first use", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-native-cohort-"));
    const marker = join(directory, "calls");
    const wrapper = join(directory, "xtask");
    const hostTarget = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)![1];
    const checker = resolve("../target/program-index-checker", hostTarget, "release/xtask");
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(marker)}\nexec ${quote(checker)} "$@"\n`, { mode: 0o755 });
    const expected = ["dash", "bash"].map((name) => readFileSync(resolveBinary(`programs/wasm32/${name}.wasm`)));
    const fs = KandeloImageFs.create();
    for (const [index, name] of ["dash", "bash"].entries()) {
      const bytes = expected[index];
      fs.registerLazyFile(`/bin/${name}`, `binaries/programs/wasm32/${name}.wasm`, bytes.length, 0o755,
        createHash("sha256").update(bytes).digest("hex"));
    }
    // A latent bad asset must stay a per-URL error, never fail boot or another
    // cohort member. Duplicate URLs must not create duplicate checkpoints.
    fs.registerLazyFile("/bin/dash-alias", "binaries/programs/wasm32/dash.wasm", expected[0].length, 0o755);
    fs.registerLazyFile("/bin/unused", "binaries/programs/wasm32/no-such-cohort-program.wasm", 4, 0o755);
    const previous = process.env.WASM_POSIX_XTASK_BIN;
    process.env.WASM_POSIX_XTASK_BIN = wrapper;
    const host = new NodeKernelHost({ rootfsImage: await fs.saveImage() });
    try {
      await host.init();
      // Artifact admission may use the checker during boot. Count only the
      // lazy cohort phase, after the image has been validated by Rust.
      writeFileSync(marker, "");
      for (const [index, name] of ["dash", "bash"].entries()) {
        const bytes = await host.readFileFromVfs(`/bin/${name}`);
        expect(bytes).not.toBeNull();
        expect(Buffer.compare(bytes!, expected[index])).toBe(0);
      }
      const calls = readFileSync(marker, "utf8").split("\n").filter((line) => line.includes("program-index-context-ensure"));
      expect(calls).toHaveLength(1);
      await expect(host.readFileFromVfs("/bin/unused")).rejects.toThrow();
    } finally {
      await host.destroy();
      if (previous === undefined) delete process.env.WASM_POSIX_XTASK_BIN;
      else process.env.WASM_POSIX_XTASK_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  // The first lazy read resolves the whole image's cohort before any byte
  // moves; on a large image its program-index freshness check has outlasted
  // 30 s. Stand in for that with a checker that sleeps past every 30 s
  // budget, on a two-file image, and require both host-side read paths to
  // wait it out: a slow preparation is not a stalled transfer.
  it.each(["inspection", "exec"] as const)(
    "waits out a first-read resolution slower than 30 s for %s",
    async (kind) => {
      const directory = mkdtempSync(join(tmpdir(), "kandelo-slow-cohort-"));
      const slow = join(directory, "slow");
      const wrapper = join(directory, "xtask");
      const hostTarget = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)![1];
      const checker = resolve("../target/program-index-checker", hostTarget, "release/xtask");
      const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
      // Sleep only once the flag exists, so boot-time artifact admission is
      // not slowed; then run the real checker when it has been prepared.
      writeFileSync(wrapper, [
        "#!/bin/sh",
        `case "$*" in *program-index-context-ensure*) [ -e ${quote(slow)} ] && sleep 35 ;; esac`,
        existsSync(checker) ? `exec ${quote(checker)} "$@"` : "exit 0",
        "",
      ].join("\n"), { mode: 0o755 });
      const [dash, bash] = ["dash", "bash"].map((name) => readFileSync(resolveBinary(`programs/wasm32/${name}.wasm`)));
      const fs = KandeloImageFs.create();
      for (const [name, bytes] of [["dash", dash], ["bash", bash]] as const) {
        fs.registerLazyFile(`/bin/${name}`, `binaries/programs/wasm32/${name}.wasm`, bytes.length, 0o755,
          createHash("sha256").update(bytes).digest("hex"));
      }
      const previous = process.env.WASM_POSIX_XTASK_BIN;
      process.env.WASM_POSIX_XTASK_BIN = wrapper;
      let stdout = "";
      let stderr = "";
      const host = new NodeKernelHost({
        rootfsImage: await fs.saveImage(),
        onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
      });
      try {
        await host.init();
        writeFileSync(slow, "");
        const started = performance.now();
        if (kind === "inspection") {
          const bytes = await host.readFileFromVfs("/bin/bash");
          expect(bytes).not.toBeNull();
          expect(Buffer.compare(bytes!, bash)).toBe(0);
        } else {
          const status = await host.spawn(
            dash.buffer.slice(dash.byteOffset, dash.byteOffset + dash.byteLength) as ArrayBuffer,
            ["dash", "-c", "exec /bin/bash -c 'echo slow-exec-ok'"],
            { env: ["PATH=/bin"], stdin: new Uint8Array() },
          );
          expect(status, `stdout=${stdout}\nstderr=${stderr}`).toBe(0);
          expect(stdout).toContain("slow-exec-ok");
        }
        // The read really did wait out the slow resolution.
        expect(performance.now() - started).toBeGreaterThan(30_000);
      } finally {
        await host.destroy();
        if (previous === undefined) delete process.env.WASM_POSIX_XTASK_BIN;
        else process.env.WASM_POSIX_XTASK_BIN = previous;
        rmSync(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
