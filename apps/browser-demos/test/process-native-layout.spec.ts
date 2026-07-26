import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFetchedWasmProgram } from "./run-fetched-wasm-program";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programs = [
  {
    name: "process layouts wasm32",
    path: resolve(
      __dirname,
      "../../../examples/process_native_layout_test.wasm",
    ),
    argv0: "process-native-layout-test",
    markers: ["PROCESS NATIVE LAYOUTS PASSED"],
  },
  {
    name: "process layouts memory64",
    path: resolve(
      __dirname,
      "../../../examples/process_native_layout_test.wasm64.wasm",
    ),
    argv0: "process-native-layout-test",
    markers: ["PROCESS NATIVE LAYOUTS PASSED"],
  },
  {
    name: "timerfd/signalfd wasm32",
    path: resolve(
      __dirname,
      "../../../examples/timerfd_signalfd_scratch_test.wasm",
    ),
    argv0: "timerfd-signalfd-scratch-test",
    markers: [
      "timerfd scratch guards: PASS",
      "signalfd scratch mask: PASS",
      "ALL TESTS PASSED",
    ],
  },
  {
    name: "timerfd/signalfd memory64",
    path: resolve(
      __dirname,
      "../../../examples/timerfd_signalfd_scratch_test.wasm64.wasm",
    ),
    argv0: "timerfd-signalfd-scratch-test",
    markers: [
      "timerfd scratch guards: PASS",
      "signalfd scratch mask: PASS",
      "ALL TESTS PASSED",
    ],
  },
  {
    name: "System V IPC wasm32",
    path: resolve(__dirname, "../../../examples/sysv_ipc_test.wasm"),
    argv0: "sysv-ipc-test",
    markers: [
      "msgctl IPC_SET: mode=0600 qbytes=4096",
      "msgq: PASS",
      "semctl post-RMID IPC_STAT: EINVAL",
      "semctl post-RMID GETALL: EINVAL",
      "semctl post-RMID SETALL: EINVAL",
      "semctl post-RMID GETVAL: EINVAL",
      "sem: PASS",
      "shmctl IPC_SET: mode=0600 segsz=4096",
      "shm: PASS",
      "ALL TESTS PASSED",
    ],
  },
  {
    name: "System V IPC memory64",
    path: resolve(__dirname, "../../../examples/sysv_ipc_test.wasm64.wasm"),
    argv0: "sysv-ipc-test",
    markers: [
      "msgctl IPC_SET: mode=0600 qbytes=4096",
      "msgq: PASS",
      "semctl post-RMID IPC_STAT: EINVAL",
      "semctl post-RMID GETALL: EINVAL",
      "semctl post-RMID SETALL: EINVAL",
      "semctl post-RMID GETVAL: EINVAL",
      "sem: PASS",
      "shmctl IPC_SET: mode=0600 segsz=4096",
      "shm: PASS",
      "ALL TESTS PASSED",
    ],
  },
] as const;

for (const program of programs) {
  test(
    `caller-native scratch layouts match in Chromium (${program.name})`,
    async ({ page, baseURL, browserName }) => {
      test.skip(
        browserName !== "chromium",
        "the aggregate browser gate uses Chromium",
      );
      expect(baseURL).toBeTruthy();

      const runtimeErrors: string[] = [];
      page.on("pageerror", (error) => {
        runtimeErrors.push(`pageerror: ${error.message}`);
      });
      page.on("console", (message) => {
        if (message.type() === "error") {
          runtimeErrors.push(`console: ${message.text()}`);
        }
      });
      page.on("requestfailed", (request) => {
        runtimeErrors.push(
          `requestfailed: ${request.url()} ${
            request.failure()?.errorText ?? "failed"
          }`,
        );
      });

      // WHY: these ABI fixtures are self-contained. The minimal runner avoids
      // importing unrelated packages without weakening checks for any artifact
      // the test actually requests.
      await page.goto(
        new URL("/pages/test-runner/?minimal=1", baseURL).href,
      );
      await page.waitForFunction(
        () => (window as any).__testRunnerReady === true,
      );

      const programUrl = new URL(`/@fs/${program.path}`, baseURL).href;
      const result = await page.evaluate(
        runFetchedWasmProgram,
        {
          programUrl,
          argv: [program.argv0],
          timeoutMs: 30_000,
        },
      );

      expect(result.exitCode, result.stderr).toBe(0);
      for (const marker of program.markers) {
        expect(result.stdout).toContain(marker);
      }
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
      expect(runtimeErrors).toEqual([]);
    },
  );
}
