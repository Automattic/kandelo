/** Run the same native guest probes as the Node process gate. */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { nativeForkProcessCases } from "../../../host/test/fixtures/native-fork-process-cases";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";

type BrowserCase = (typeof nativeForkProcessCases)[number] & {
  label?: string;
  linkArgs?: string[];
};
const enomem = nativeForkProcessCases.find(
  fixture => fixture.source === "p_11_fork_continuation_enomem",
)!;
const cases: BrowserCase[] = [
  ...nativeForkProcessCases,
  {
    ...enomem,
    label: "p_11 wide-frame allocation recovery",
    linkArgs: ["-DP11_WIDE_FRAME", "-DP11_RECURSION_DEPTH=256"],
  },
];

let image: number[];
test.beforeAll(async () => {
  // Compose on Node; only independent image bytes reach the browser page.
  const builder = KandeloImageFs.create(new Uint8Array(readFileSync(new URL(
    "../../../local-binaries/kandelo_image_module32.wasm", import.meta.url,
  ))));
  image = Array.from(await builder.saveImage());
});

test("engine validates Memory64", async ({
  page, baseURL,
}) => {
  await page.goto(new URL("/trap-signal-test.html", baseURL!).href);
  // (module (memory i64 0)): isolate the proposal from instrumentation.
  const supported = await page.evaluate(() => WebAssembly.validate(new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 0,
  ])));
  expect(supported).toBe(true);
});

for (const arch of ["wasm32", "wasm64"] as const) {
  for (const fixture of cases) {
    test(`${arch} native ${fixture.label ?? fixture.source}`, async ({
      page, baseURL, browserName,
    }) => {
      const program = compileSdkFixture(
        new URL(`../../../programs/${fixture.source}.c`, import.meta.url),
        fixture.linkArgs ?? [],
        { forkInstrument: true, arch },
      );
      try {
        await page.goto(new URL("/trap-signal-test.html", baseURL!).href);
        const modulePath = fileURLToPath(new URL(
          "../../../host/src/browser-kernel-host.ts", import.meta.url,
        ));
        const result = await page.evaluate(async ({
          moduleUrl, image, bytes, name, maxMemoryPages,
        }) => {
          const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
          const decoder = new TextDecoder();
          let stdout = "";
          let stderr = "";
          const diagnostics: string[] = [];
          const kernel = new BrowserKernel({
            maxWorkers: 4,
            ...(maxMemoryPages === undefined ? {} : { maxMemoryPages }),
            onStdout: (data: Uint8Array) => { stdout += decoder.decode(data); },
            onStderr: (data: Uint8Array) => { stderr += decoder.decode(data); },
            onHostDiagnostic: (diagnostic: { message: string }) => {
              diagnostics.push(diagnostic.message);
            },
          });
          let initialized = false;
          try {
            await kernel.initFromImage({ vfsImage: new Uint8Array(image) });
            initialized = true;
            const exitCode = await kernel.spawn(new Uint8Array(bytes).buffer, [name]);
            return { exitCode, stdout, stderr, diagnostics };
          } finally {
            if (initialized) await kernel.destroy();
          }
        }, {
          moduleUrl: new URL(`/@fs/${modulePath}`, baseURL!).href,
          image,
          bytes: Array.from(readFileSync(program.programPath)),
          name: fixture.source,
          maxMemoryPages: fixture.maxPages,
        });
        const diagnostic = JSON.stringify(result);
        if (
          browserName === "webkit"
          && fixture.source === enomem.source
          && !fixture.label
        ) {
          test.info().annotations.push({
            type: "engine-boundary",
            description: "WebKit exhausts its native stack at 4,096 source calls. "
              + "The wide-frame cases check allocation recovery.",
          });
          await test.step("checks the 4,096-call WebKit stack boundary", async () => {
            expect(result.exitCode, diagnostic).toBe(139);
            for (const marker of enomem.markers.slice(0, 3)) {
              expect(result.stdout, diagnostic).toContain(marker);
            }
            expect(result.stdout, diagnostic).not.toMatch(/^CONTINUATION_ENOMEM: ok$/m);
            expect(result.stderr, diagnostic).toBe("");
            expect(result.diagnostics, diagnostic).toHaveLength(1);
            expect(result.diagnostics[0]).toContain("Maximum call stack size exceeded");
          });
          return;
        }
        expect(result.exitCode, diagnostic).toBe(0);
        for (const marker of fixture.markers) {
          expect(result.stdout, diagnostic).toContain(marker);
        }
        expect(result.stdout, diagnostic).not.toContain("FAIL:");
        expect(result.stderr, diagnostic).toBe("");
        expect(result.diagnostics).toEqual([]);
      } finally {
        program.cleanup();
      }
    });
  }
}
