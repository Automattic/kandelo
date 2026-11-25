import { prepareDefaultRunExampleRootfs } from "../examples/run-example-rootfs";

try {
  prepareDefaultRunExampleRootfs();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
