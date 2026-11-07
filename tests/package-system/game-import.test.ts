import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

// These are native userland tests of bounded ZIP extraction and dispatch.
// The shell-image integration tests separately exercise the guest interpreter,
// installed engines, exchange lifecycle and terminal requests on Kandelo.
it("validates ZIP import bounds, content classification and runtime choices", () => {
  execFileSync("python3", [fileURLToPath(new URL("./game-import_test.py", import.meta.url))], {
    stdio: "pipe",
    timeout: 30_000,
  });
});
