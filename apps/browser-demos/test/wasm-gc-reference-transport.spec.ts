import { expect, test } from "@playwright/test";
import {
  FORK_ANYREF_TRANSIT_IMPORT,
  forkAnyrefTransitProviderBytes,
} from "../../../host/src/fork-anyref-transit";

// WHY: the dev shell's WABT release cannot parse typed Wasm GC references.
// This is the Rust `wat` crate's deterministic encoding of the adjacent
// fixtures/static-root-gc.wat source.
const FIXTURE_WASM_HEX = [
  "0061736d01000000010e035f017f0060000060016300017f03030201020405016e",
  "010101060a016400004129fb00000b07240307636174616c6f6701000768617276",
  "65737400000c6d6174636865735f726f6f7400010a120208004100230026000b07",
  "0020002300d30b0023046e616d65040701000470616972050a010007636174616c",
  "6f670707010004726f6f74",
].join("");

function fixtureBytes(): number[] {
  return Array.from(Buffer.from(FIXTURE_WASM_HEX, "hex"));
}

test("browser preserves GC identity through weak harvest and anyref transit", async ({
  page,
  baseURL,
}) => {
  const bytes = fixtureBytes();
  const providerBytes = Array.from(forkAnyrefTransitProviderBytes());
  await page.goto(new URL("/trap-signal-test.html", baseURL!).href);
  const result = await page.evaluate(async ({
    moduleBytes,
    transitProviderBytes,
    transitExport,
  }) => {
    const module = await WebAssembly.compile(new Uint8Array(moduleBytes));
    const transitProviderModule = await WebAssembly.compile(
      new Uint8Array(transitProviderBytes),
    );
    const parent = await WebAssembly.instantiate(module);
    const child = await WebAssembly.instantiate(module);
    const transitProvider = await WebAssembly.instantiate(transitProviderModule);
    const parentExports = parent.exports as {
      catalog: WebAssembly.Table;
      harvest: () => void;
      matches_root: (value: unknown) => number;
    };
    const childExports = child.exports as typeof parentExports;
    const transit = transitProvider.exports[transitExport] as WebAssembly.Table;
    const clearTransit = transitProvider.exports[
      `${transitExport}_clear`
    ] as () => void;

    parentExports.harvest();
    childExports.harvest();
    const parentRoot = parentExports.catalog.get(0);
    const childRoot = childExports.catalog.get(0);
    const repeatedReadIsIdentical =
      childExports.catalog.get(0) === childRoot;
    const freshInstancesDiffer = parentRoot !== childRoot;

    // The host creates the ABI transit table from an audited provider module
    // for this exact WebKit compatibility boundary.
    transit.set(0, childRoot);
    transit.grow(2);
    transit.set(1, parentRoot);
    transit.set(2, childRoot);
    const transported = transit.get(0);
    const jsTransitIsIdentical = transported === childRoot;
    const wasmTransitIsIdentical =
      childExports.matches_root(transported) === 1;

    parentExports.catalog.set(0, null);
    childExports.catalog.set(0, null);
    clearTransit();
    return {
      repeatedReadIsIdentical,
      freshInstancesDiffer,
      jsTransitIsIdentical,
      wasmTransitIsIdentical,
      harvestCleared:
        parentExports.catalog.get(0) === null
        && childExports.catalog.get(0) === null
        && Array.from(
          { length: transit.length },
          (_, index) => transit.get(index),
        ).every((value) => value === null),
    };
  }, {
    moduleBytes: bytes,
    transitProviderBytes: providerBytes,
    transitExport: FORK_ANYREF_TRANSIT_IMPORT,
  });

  expect(result).toEqual({
    repeatedReadIsIdentical: true,
    freshInstancesDiffer: true,
    jsTransitIsIdentical: true,
    wasmTransitIsIdentical: true,
    harvestCleared: true,
  });
});
