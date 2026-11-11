import base from "../libuv-browser/playwright.config";
import { fileURLToPath } from "node:url";

export default {
  ...base,
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "types.spec.ts",
};
