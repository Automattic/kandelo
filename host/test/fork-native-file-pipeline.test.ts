import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNativeFileFixtures } from "./fork-native-file-fixtures";

it("admits native file artifacts and replays through the production coordinator", () => {
  const tool = process.env.WASM_POSIX_FORK_INSTRUMENT ?? fileURLToPath(new URL(
    "../../tools/bin/wasm-fork-instrument",
    import.meta.url,
  ));
  expect(runNativeFileFixtures(tool)).toEqual({
    structuralContracts: 12,
    productionCoordinatorParentReplay: "passed",
  });
}, 120_000);
