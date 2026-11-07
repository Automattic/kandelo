import { BrowserKernel } from "@host/browser-kernel-host";
import type { RemoteSegmentInit, RemoteSegmentPeer } from "@host/networking/remote-segment-port";
import type { RemoteSegmentSnapshot } from "@host/networking/remote-segment";
import type { PeerConnection } from "../../../../web-libs/kandelo-session/src/peer-connection";
import { createNetworkInvite, answerNetworkInvite, attachNetworkBridge } from "../../lib/network-peer";
import { postSessionOffer, postSessionAnswer, readSession, validSessionName, SESSION_NAME_RULE, waitForSessionAnswer } from "../../lib/peer-signalling";
import { createBuildFsWithEtc, finalizeKernelOwnedImage } from "../../lib/kernel-owned-boot";
import kernelUrl from "@kernel-wasm?url";
import ncUrl from "@binaries/programs/wasm32/netcat/nc.wasm?url";
import phpUrl from "@binaries/programs/wasm32/php/php.wasm?url";
import curlUrl from "@binaries/programs/wasm32/curl.wasm?url";

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const status = document.getElementById("status")!;
const output = document.getElementById("output")!;
const decoder = new TextDecoder();
let machine: BrowserKernel | undefined;
let attempt = 0;
let cancelPending: (() => void) | undefined;
let role: "host" | "joiner" | undefined;
let httpPid = 0;
const links = new Set<PeerConnection>();
const bridges = new Set<ReturnType<typeof attachNetworkBridge>>();
const processes = new Map<number, { stdout: string; stderr: string; exit: number | null }>();
const trackedSpawns = new Set<Promise<unknown>>();
let directoryTimer: ReturnType<typeof setInterval> | undefined;
let latest: RemoteSegmentSnapshot | undefined;
let refreshing = false;
function append(pid: number, kind: "stdout" | "stderr", data: Uint8Array) {
  const text = decoder.decode(data);
  const process = processes.get(pid) ?? { stdout: "", stderr: "", exit: null };
  process[kind] = (process[kind] + text).slice(-128 * 1024); processes.set(pid, process);
  output.textContent = (output.textContent + `[${pid} ${kind}] ${text}`).slice(-256 * 1024);
  output.scrollTop = output.scrollHeight;
}
function fail(error: unknown) { status.textContent = error instanceof Error ? error.message : String(error); }
async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url); if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  return response.arrayBuffer();
}
async function updateDirectory() {
  if (!machine || refreshing) return;
  refreshing = true;
  const current = machine;
  try {
    const snapshot = await current.remoteNetworkSnapshot();
    if (machine !== current) return;
    latest = snapshot;
    document.getElementById("members")!.textContent = `This computer: ${latest.address}\n` + latest.members.map((member) => `${member.hostname}: ${member.address}`).join("\n");
  } finally { refreshing = false; }
}
async function boot(config: RemoteSegmentInit) {
  const currentAttempt = attempt;
  const [kernelWasm, nc] = await Promise.all([fetchBytes(kernelUrl), fetchBytes(ncUrl)]);
  const fs = await createBuildFsWithEtc(128 * 1024 * 1024);
  for (const dir of ["/bin", "/root", "/www"]) fs.mkdir(dir, 0o755);
  fs.createFileWithOwner("/bin/nc", 0o755, 0, 0, new Uint8Array(nc));
  const image = await finalizeKernelOwnedImage(fs);
  const next = new BrowserKernel({ remoteNetwork: config, kernelOwnedFs: true,
    onProcessStdout: (pid, bytes) => append(pid, "stdout", bytes),
    onProcessStderr: (pid, bytes) => append(pid, "stderr", bytes),
    onProcessEvent: (event) => {
      if (event.kind !== "exit") return;
      const process = processes.get(event.pid);
      if (process && event.exitStatus !== undefined) process.exit = event.exitStatus;
    },
  });
  try { await next.initFromOwnedImage({ kernelWasm, vfsImage: image.slice().buffer }); }
  catch (error) { await next.destroy(); throw error; }
  if (currentAttempt !== attempt) { await next.destroy(); throw new Error("Connection attempt cancelled"); }
  machine = next;
  processes.clear(); output.textContent = "";
  await updateDirectory();
  directoryTimer = setInterval(() => { void updateDirectory().catch(fail); }, 250);
}
async function connectLink(link: PeerConnection, peerRole: "host" | "joiner") {
  let bridge: ReturnType<typeof attachNetworkBridge>;
  try { bridge = attachNetworkBridge(link); } catch (error) { link.close(); throw error; }
  links.add(link); bridges.add(bridge);
  link.onFailure(fail);
  link.onClose(() => { links.delete(link); bridges.delete(bridge); status.textContent = links.size ? "A peer disconnected" : "Peer disconnected"; });
  try {
    if (peerRole === "host") await machine!.attachRemotePeer(bridge.peer);
    else await boot({ role: "joiner", peer: bridge.peer });
  } catch (error) { bridge.close(); throw error; }
  await updateDirectory();
  status.textContent = `Connected as ${latest!.address}`;
}
async function connect(peerRole: "host" | "joiner") {
  const server = input("server").value, name = input("session").value;
  if (!validSessionName(name)) throw new Error(SESSION_NAME_RULE);
  const url = new URL(server); if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an HTTP or HTTPS signalling server");
  // A host may invite another member without replacing its machine.
  if (machine && (role !== "host" || peerRole !== "host")) await disconnect();
  const current = ++attempt; cancelPending?.(); cancelPending = undefined;
  role = peerRole;
  try {
    if (peerRole === "host") {
      if (!machine) { status.textContent = "Booting host…"; await boot({ role: "host" }); }
      const invite = await createNetworkInvite(); cancelPending = invite.cancel;
      await postSessionOffer(server, name, invite.invite);
      status.textContent = `Hosting "${name}" — waiting for a peer`;
      const answer = await waitForSessionAnswer(server, name, () => current === attempt);
      if (!answer || current !== attempt) { invite.cancel(); return; }
      const link = await invite.acceptAnswer(answer); cancelPending = undefined;
      if (current !== attempt) { link.close(); return; }
      await connectLink(link, peerRole);
    } else {
      status.textContent = `Joining "${name}"…`;
      const session = await readSession(server, name);
      const answer = await answerNetworkInvite(session.offer); cancelPending = answer.cancel;
      await postSessionAnswer(server, name, answer.answer);
      const link = await answer.connected; cancelPending = undefined;
      if (current !== attempt) { link.close(); return; }
      await connectLink(link, peerRole);
    }
  } catch (error) {
    if (current === attempt) { cancelPending?.(); cancelPending = undefined; }
    throw error;
  }
}
async function disconnect() {
  ++attempt; cancelPending?.(); cancelPending = undefined;
  clearInterval(directoryTimer); directoryTimer = undefined;
  for (const bridge of bridges) bridge.close(); bridges.clear(); links.clear();
  const old = machine; machine = undefined; role = undefined; httpPid = 0; latest = undefined;
  if (old) await old.destroy();
  document.getElementById("members")!.textContent = ""; status.textContent = "Disconnected";
}
function requireMachine(): BrowserKernel { if (!machine) throw new Error("Connect a computer first"); return machine; }
async function spawn(path: string, argv: string[], options: { stdin?: Uint8Array } = {}) {
  const kernel = requireMachine();
  const child = await kernel.spawnFromVfs(path, argv, options);
  const process = processes.get(child.pid) ?? { stdout: "", stderr: "", exit: null }; processes.set(child.pid, process);
  const completion = child.exit.then((exit) => { process.exit = exit; output.textContent += `\n[${child.pid}] exited ${exit}\n`; return exit; });
  trackedSpawns.add(completion); void completion.finally(() => trackedSpawns.delete(completion)).catch(fail);
  return { pid: child.pid, exit: completion };
}
function portValue() { const port = Number(input("port").value); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be between 1 and 65535"); return port; }
async function listen(port = portValue()) { return spawn("/bin/nc", ["nc", "-n", "-c", "-u", "-l", "-p", String(port), "-w", "3"], { stdin: new Uint8Array() }); }
async function send(destination = input("destination").value, port = portValue(), message = input("message").value) {
  // Guest getaddrinfo resolves names through the worker-owned network directory.
  const child = await spawn("/bin/nc", ["nc", "-u", "-c", "-w", "3", destination, String(port)], { stdin: new TextEncoder().encode(message + "\n") });
  return child.exit;
}
async function install(path: string, url: string) { await requireMachine().writeFileToVfs(path, new Uint8Array(await fetchBytes(url)), 0o755); }
async function startHttp(port = Number(input("http-port").value)) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be between 1 and 65535");
  if (httpPid && processes.get(httpPid)?.exit === null) throw new Error("Stop the running HTTP server first");
  await install("/bin/php", phpUrl);
  await requireMachine().writeFileToVfs("/www/index.php", new TextEncoder().encode('<?php header("Content-Type: text/plain"); echo "HTTP from Kandelo; client=" . $_SERVER["REMOTE_ADDR"] . "\\n";'));
  const child = await spawn("/bin/php", ["php", "-n", "-S", `0.0.0.0:${port}`, "-t", "/www"], {stdin:new Uint8Array()});
  httpPid = child.pid; return child.pid;
}
async function fetchHttp(url = input("http-url").value) {
  await install("/bin/curl", curlUrl);
  const child = await spawn("/bin/curl", ["curl", "-fsS", "--max-time", "15", url], {stdin:new Uint8Array()});
  return {pid:child.pid,exit:await child.exit};
}
async function stopHttp() { if (httpPid && processes.get(httpPid)?.exit === null) await requireMachine().signalProcess(httpPid,15); httpPid=0; }
for (const [id, action] of Object.entries({ host: () => connect("host"), join: () => connect("joiner"), disconnect, listen: () => listen(), send: () => send(), "http-start": () => startHttp(), "http-fetch": () => fetchHttp(), "http-stop": stopHttp })) {
  document.getElementById(id)!.addEventListener("click", () => { void action().catch(fail); });
}
input("server").value = new URL(location.href).searchParams.get("signalling") ?? "";
window.addEventListener("pagehide", () => { void disconnect(); });
// Observability exposes actual worker state and guest output for browser tests.
Object.assign(window, { __peerNetwork: { snapshot: () => latest, processes: () => Object.fromEntries(processes), listen, send, startHttp, fetchHttp, stopHttp, disconnect,
  signal: (pid: number, value: number) => requireMachine().signalProcess(pid, value),
} });
