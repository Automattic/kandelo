import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function teardown(): void {
  const id = process.env.KANDELO_PLAYWRIGHT_RUN_ID;
  if (id === undefined) return;
  execFileSync("python3", [
    fileURLToPath(new URL("../scripts/validation_artifacts.py", import.meta.url)),
    "finish", "--run-id", id, "--pid", String(process.pid),
  ], { stdio: "inherit" });
}
