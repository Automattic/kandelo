#!/usr/bin/env -S npx tsx
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { createRustDebugSession } from "./lib/rust-debug-session";
import { NodeWorkerDebugger } from "./lib/node-worker-debugger";

const args = process.argv.slice(2);
const usage = "scripts/dev-shell.sh npx tsx scripts/debug-rust.ts PROGRAM.wasm --break FILE:LINE [--commands next,where,continue] [--image IMAGE.vfs] [--kernel KERNEL.wasm] [-- ARGS...]";
const program = args.shift();
if (!program || program === "--help") { console.log(usage); process.exit(program ? 0 : 2); }
let breakpoint: string | undefined, commands: string[] | undefined, image: string | undefined, kernel: string | undefined;
let guestArgs: string[] = [];
while (args.length) {
  const option = args.shift()!;
  if (option === "--") { guestArgs = args.splice(0); break; }
  const value = args.shift();
  if (!value) throw new Error(`${option} needs a value\n${usage}`);
  if (option === "--break") breakpoint = value;
  else if (option === "--commands") commands = value.split(",");
  else if (option === "--image") image = value;
  else if (option === "--kernel") kernel = value;
  else throw new Error(`unknown option ${option}\n${usage}`);
}
if (commands?.some(command => !["next", "n", "where", "bt", "continue", "c", "quit", "q"].includes(command))) throw new Error("unknown scripted debugger command");
if (!breakpoint) throw new Error(`--break FILE:LINE is required\n${usage}`);
if (statSync(program).size > 256 * 1024 ** 2) throw new Error("debug module exceeds 256 MiB");
const bytes = new Uint8Array(readFileSync(program));
let quitting = false;
let cancel!: (error: Error) => void;
const cancelled = new Promise<never>((_resolve, reject) => { cancel = reject; });
void cancelled.catch(() => {});
const stop = () => { quitting = true; cancel(new Error("debug session cancelled")); };
const debug = createRustDebugSession(bytes, breakpoint, commands, stop);
const transport = new NodeWorkerDebugger(debug.callbacks);
const log = (text: string) => process.stderr.write(text + "\n");
const host = new NodeKernelHost({
  rootfsImage: image ? undefined : "default",
  rootfsImageFile: image ? resolve(image) : undefined,
  onStdout: (_pid, data) => { process.stdout.write(data); },
  onStderr: (_pid, data) => { process.stderr.write(data); },
});
const interrupt = stop;
process.once("SIGINT", interrupt);
try {
  await transport.start();
  await Promise.race([host.init(kernel ? new Uint8Array(readFileSync(kernel)).buffer : undefined), transport.failure, cancelled]);
  log(`debugging ${debug.expected}; ${debug.locations.length} source breakpoint location(s)`);
  const exit = await Promise.race([host.spawn(bytes.buffer, [program, ...guestArgs], {
    env: ["PATH=/usr/bin:/bin", "HOME=/home/maker", `RUST_BACKTRACE=${process.env.RUST_BACKTRACE ?? "1"}`], stdin: new Uint8Array(),
  }), transport.failure, cancelled]);
  if (!debug.wasHit && !quitting) throw new Error("program exited without hitting the requested source breakpoint");
  log(`guest exited ${exit}`); process.exitCode = exit;
} catch (error) {
  if (quitting) process.exitCode = 130;
  else throw error;
} finally {
  try { await transport.close(); }
  finally { debug.close(); process.off("SIGINT", interrupt); await host.destroy(); }
}
