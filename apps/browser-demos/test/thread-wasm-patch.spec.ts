import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerMainPath = resolve(
  __dirname,
  "../../../host/src/worker-main.ts",
);

function uleb(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function name(value: string): number[] {
  const bytes = new TextEncoder().encode(value);
  return [...uleb(bytes.byteLength), ...bytes];
}

function section(id: number, contents: number[]): number[] {
  return [id, ...uleb(contents.length), ...contents];
}

function spoofedConstructorFixture(): number[] {
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  bytes.push(...section(1, [
    0x02,
    0x60, 0x00, 0x00,
    0x60, 0x00, 0x01, 0x7f,
  ]));
  bytes.push(...section(3, [0x03, 0x00, 0x00, 0x01]));
  bytes.push(...section(7, [
    0x01,
    ...name("invoke_spoof"),
    0x00, 0x02,
  ]));
  bytes.push(...section(8, [0x00]));
  bytes.push(...section(10, [
    0x03,
    0x02, 0x00, 0x0b,
    0x03, 0x00, 0x00, 0x0b,
    0x06, 0x00, 0x10, 0x01, 0x41, 0x12, 0x0b,
  ]));
  const functionNameMap = [
    0x01,
    0x01,
    ...name("__wasm_call_ctors"),
  ];
  bytes.push(...section(0, [
    ...name("name"),
    0x01,
    ...uleb(functionNameMap.length),
    ...functionNameMap,
  ]));
  return bytes;
}

test("thread patching ignores spoofed debug names in every browser", async ({
  page,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  await page.goto(new URL("/trap-signal-test.html", baseURL!).href);

  const result = await page.evaluate(async ({ workerUrl, fixture }) => {
    const { patchWasmForThread } = await import(
      /* @vite-ignore */ workerUrl
    );
    const source = new Uint8Array(fixture).buffer;
    const patched = patchWasmForThread(source);
    const valid = WebAssembly.validate(patched);
    const module = await WebAssembly.compile(patched);
    const instance = await WebAssembly.instantiate(module);
    let trapped = false;
    try {
      (instance.exports.invoke_spoof as () => number)();
    } catch (error) {
      trapped = error instanceof WebAssembly.RuntimeError;
    }
    return { valid, trapped };
  }, {
    workerUrl: new URL(`/@fs/${workerMainPath}`, baseURL!).href,
    fixture: spoofedConstructorFixture(),
  });

  expect(result).toEqual({ valid: true, trapped: true });
});
