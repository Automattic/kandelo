import * as React from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../pages/kandelo/app/App";
import { KernelHostProvider } from "../../pages/kandelo/kernel-host/react";
import { LiveKernelHost, type KernelLike } from "../../../../web-libs/kandelo-session/src/kernel-host";
import { initializeTheme } from "../../pages/kandelo/app/theme";
import "../../pages/kandelo/tokens.css";
import "../../pages/kandelo/styles.css";

// Deterministic filesystem boundary for UI/save/cancellation tests. The guest
// spec separately exercises the live kernel's real file reads.
const data: Record<string, Uint8Array> = {
  "/home/hello.txt": new TextEncoder().encode("Hello from Kandelo\n"),
  "/home/.config": new Uint8Array([0, 255, 10, 128]),
  "/home/new.txt": new TextEncoder().encode("New file\n"),
};
const directory = (name: string) => ({ name, mode: 0o40755, uid: 1000, gid: 1000, size: 0 });
const calls: string[] = [];
let failure = false;
let pause: (() => void) | null = null;
let paused = false;
const kernel = {
  readDirFromVfs: async (path: string) => {
    calls.push(path);
    if (path === "/") return [directory("home"), directory("proc"), directory("dev"), directory("sys")];
    if (path === "/home") return [
      ...Object.entries(data).map(([name, bytes]) => ({ name: name.split("/").at(-1)!, mode: 0o100644, size: bytes.length, uid: 1000, gid: 1000 })),
      directory("empty"),
      { name: "link", mode: 0o120777, size: 4, uid: 1000, gid: 1000, target: "../home" },
      { name: "pipe", mode: 0o10600, size: 0, uid: 1000, gid: 1000 },
    ];
    if (path === "/home/empty") return [];
    throw new Error(`Unexpected directory read: ${path}`);
  },
  readFileRangeFromVfs: async (path: string, offset: number, length: number) => {
    calls.push(`${path}:${offset}:${length}`);
    if (paused) await new Promise<void>(resolve => { pause = resolve; });
    if (failure) throw new Error(`Cannot read ${path}`);
    return data[path]?.slice(offset, offset + length) ?? null;
  },
} as unknown as KernelLike;
const host = new LiveKernelHost({ status: "running", kernel });
let referenceFailure = false;
let referenceClosed = 0;
host.referenceFiles = { open: async () => {
  if (referenceFailure) throw new Error("The reference image has changed. Choose All files.");
  return {
    readDir: async (path: string) => {
      if (path === "/") return [directory("home")];
      if (path === "/home") return [
        { name: "hello.txt", mode: 0o100644, size: data["/home/hello.txt"].length, uid: 1000, gid: 1000 },
        { name: ".config", mode: 0o100644, size: 4, uid: 1000, gid: 1000 },
        directory("empty"),
        { name: "link", mode: 0o120777, size: 3, uid: 1000, gid: 1000, target: "old" },
        { name: "deleted.txt", mode: 0o100644, size: 1, uid: 1000, gid: 1000 },
      ];
      if (path === "/home/empty") return [];
      throw new Error(`Unexpected reference read: ${path}`);
    },
    readRange: async (path: string, offset: number, length: number) => (path === "/home/.config" ? new Uint8Array([1, 2, 3, 4]) : data[path])?.slice(offset, offset + length) ?? null,
    dispose: async () => { referenceClosed++; },
  };
} };
host.setDescriptor({ ...host.getBootDescriptor(), title: "Export demo" });
initializeTheme();
createRoot(document.getElementById("root")!).render(<KernelHostProvider host={host}><App /></KernelHostProvider>);
Object.assign(window, { __exportTest: {
  calls,
  fail: () => { failure = true; },
  pause: () => { paused = true; },
  resume: () => { paused = false; pause?.(); pause = null; },
  replace: () => host.attachKernel(kernel),
  failReference: () => { referenceFailure = true; },
  referenceClosed: () => referenceClosed,
  legacy: () => { host.referenceFiles = undefined; },
} });
