import { expect, test } from "@playwright/test";
import { libeventCases, libeventModes, libeventProgramRelPath } from "../../../host/test/support/libevent-programs";
import { runFetchedWasmProgram } from "./run-fetched-wasm-program";
import { devServerAssetUrl } from "./support/dev-server-assets";

for (const arch of ["wasm32", "wasm64"] as const) {
  for (const mode of libeventModes) {
    test(`${arch} libevent ${mode.name} upstream edges and peer close`, async ({ page }) => {
      test.setTimeout(120_000);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto("/pages/test-runner/?minimal=1");
      await page.waitForFunction(() => (window as any).__testRunnerReady === true);
      const probe = await page.evaluate(runFetchedWasmProgram, {
        programUrl: await devServerAssetUrl(page, `@binaries/${libeventProgramRelPath(arch, "backend")}`),
        argv: ["libevent-backend"], timeoutMs: 30_000, seedEtc: false, env: mode.env,
      });
      expect(probe.exitCode, `${probe.stdout}\n${probe.stderr}`).toBe(0);
      expect(probe.stdout).toContain(`LIBEVENT_BACKEND=${mode.name} features=11 version=2.1.12-stable`);
      expect(probe.stderr).toBe("");
      expect(probe.hostDiagnostics).toEqual([]);

      const result = await page.evaluate(runFetchedWasmProgram, {
        programUrl: await devServerAssetUrl(page, `@binaries/${libeventProgramRelPath(arch, "regress")}`),
        argv: ["libevent-regress", ...libeventCases], timeoutMs: 60_000,
        seedEtc: false, env: mode.env,
      });
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("12 tests ok.  (0 skipped)");
      for (const name of libeventCases) expect(result.stdout).toContain(`${name}:`);
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}
