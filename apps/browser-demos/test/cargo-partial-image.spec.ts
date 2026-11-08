import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect } from "@playwright/test";
import { cargoProjectFiles, cargoProjectBinaryFiles, cargoProjectOutput } from "../../../host/test/fixtures/cargo-project";
import { test } from "./support/persistent-page";
import { runTerminalCommand } from "./support/terminal-command";

const imageKind = process.env.KANDELO_RUST_SHELL_IMAGE ?? "partial";
if (imageKind !== "partial" && imageKind !== "canonical") throw new Error("KANDELO_RUST_SHELL_IMAGE must be partial or canonical");
const manifestPath = resolve(import.meta.dirname, "../../../local-binaries/partial/partial.json");
const manifest: { selection: string[] } | null = imageKind === "partial" && existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
const tools = ["cargo", "rustc", "kandelo-rustc", "kandelo-sdk-browser-bundle", "wasm-fork-instrument"];
const available = imageKind === "canonical" || tools.every(name => manifest?.selection.includes(name));
if (!available && process.env.KANDELO_REQUIRE_GUEST_CARGO === "1") {
  throw new Error("Build the partial Rust shell before running Cargo UI acceptance");
}

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

test(`the ${imageKind} Rust shell builds a Cargo workspace through its login terminal`, async ({ page }) => {
  test.skip(!available, "requires the partial Rust shell");
  test.setTimeout(900_000);
  await page.goto(imageKind === "canonical" ? "/?profile=shell" : "/?vfs=%2F%40kandelo-partial%2Fimage.vfs.zst&profile=shell");
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(), { timeout: 120_000 })
    .toMatch(/maker@[^:\s]+:[^\r\n]*\$ ?/);

  // Write as maker through the real shell, with the image's installed tools
  // and login environment. This exercises the app's image and lazy assets.
  const seed = ["set -eu", "mkdir -p /home/maker/rust-demo", "cd /home/maker/rust-demo"];
  for (const [path, source] of Object.entries(cargoProjectFiles)) {
    seed.push(`mkdir -p ${quote(dirname(path))}`, `printf '%s' ${quote(source)} > ${quote(path)}`);
  }
  for (const [path, bytes] of Object.entries(cargoProjectBinaryFiles)) {
    seed.push(`mkdir -p ${quote(dirname(path))}`,
      `printf '%s' ${quote(Buffer.from(bytes).toString("base64"))} | base64 -d > ${quote(path)}`);
  }
  await runTerminalCommand(page, seed.join("\n"));
  await runTerminalCommand(page, "cargo new --vcs none /home/maker/hello");
  await runTerminalCommand(page, "set -eu\ncargo --version\nrustc --version\nrustdoc --version\ncargo fmt --version\ncargo clippy --version");
  const inProject = (command: string) => `cd /home/maker/rust-demo && ${command}`;
  await runTerminalCommand(page, inProject("cargo fmt --all"), undefined, 600_000);
  await runTerminalCommand(page, inProject("cargo fmt --all -- --check"));
  await runTerminalCommand(page, inProject("cargo clippy --offline -j1 --workspace -- -D warnings"), undefined, 600_000);
  await runTerminalCommand(page, inProject("cargo doc --offline --no-deps -j1 -p message && test -s target/doc/message/index.html"), undefined, 600_000);
  await runTerminalCommand(page, inProject("cargo check --offline -j1"), undefined, 600_000);
  await runTerminalCommand(page, inProject("cargo run --offline -j1 -p cargo-hello"),
    cargoProjectOutput.trim(), 600_000);
  const cached = await runTerminalCommand(page, inProject("cargo build --offline -j1"));
  expect(cached.output).not.toContain("Compiling");
  await runTerminalCommand(page, inProject("./target/debug/cargo-hello.wasm"), cargoProjectOutput.trim());
  const tested = await runTerminalCommand(page,
    inProject("cargo test --offline -j1 -p message --lib -- --test-threads=1"),
    "test result: ok. 4 passed; 0 failed; 2 ignored", 600_000);
  expect(tested.output).toMatch(/expected_panic.*ok/);
  await runTerminalCommand(page,
    inProject("cargo test --offline -j1 -p cargo-hello --bin cargo-hello -- --test-threads=1"),
    "build_script_generated_source_is_available ... ok", 600_000);
  await runTerminalCommand(page,
    inProject("cargo test --offline -j1 -p cargo-hello --test child -- --test-threads=1"),
    "compiled_binary_runs_as_a_child ... ok", 600_000);
});
