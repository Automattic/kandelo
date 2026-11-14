import {defineConfig} from "vitest/config";
import base from "./vitest.config.ts";

// These cases create bounded synthetic memories and their own Wasm bytes.
// They do not replace the full host, browser-memory or persistent-program gate.
export default defineConfig({...base,test:{...base.test,globalSetup:[],include:[
  "test/process-memory-backing.test.ts",
  "test/process-memory-accounting.test.ts",
  "test/common-memory-page-ownership.test.ts",
  "test/ts05-clock-extension-contract.test.ts",
  "test/fast-clock-control.test.ts",
  "test/node-syscall-trace-retirement.test.ts",
  "test/vfs-image-helpers.test.ts",
]}});
