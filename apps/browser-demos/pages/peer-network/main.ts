import { BrowserKernel } from "@host/browser-kernel-host";
import { attachCanvas, attachLinuxMediumRawKeyboard } from "@host/framebuffer";
import type { RemoteSegmentInit, RemoteSegmentPeer } from "@host/networking/remote-segment-port";
import type { RemoteSegmentSnapshot } from "@host/networking/remote-segment";
import type { PeerConnection } from "../../../../web-libs/kandelo-session/src/peer-connection";
import { createNetworkInvite, answerNetworkInvite, attachNetworkBridge } from "../../lib/network-peer";
import { postSessionOffer, postSessionAnswer, readSession, validSessionName, SESSION_NAME_RULE, waitForSessionAnswer } from "../../lib/peer-signalling";
import { createBuildFsWithEtc, finalizeKernelOwnedImage } from "../../lib/kernel-owned-boot";
import kernelUrl from "@kernel-wasm?url";
import ncUrl from "@binaries/programs/wasm32/nc.wasm?url";
import doomUrl from "@binaries/programs/wasm32/fbdoom.wasm?url";
import quakeUrl from "@binaries/programs/wasm32/quake.wasm?url";
import unzipUrl from "@binaries/programs/wasm32/unzip.wasm?url";
import phpUrl from "@binaries/programs/wasm32/php.wasm?url";
import curlUrl from "@binaries/programs/wasm32/curl.wasm?url";
import lhaUrl from "@binaries/programs/wasm32/lha.wasm?url";

const DOOM_ASSET = { url: "https://cdn.jsdelivr.net/gh/gaborbata/vanilla-mocha-doom@15825a07a48806bcfb242a42afd5ee7cb3c9a3a4/wads/doom1.wad", sha256: "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771" };
const QUAKE_ASSET = { url: "https://cdn.jsdelivr.net/gh/Jason2Brownlee/QuakeOfficialArchive@30c29bd5907fd999b0bb8e52c941ef770b4d3ba8/bin/quake106.zip", sha256: "ec6c9d34b1ae0252ac0066045b6611a7919c2a0d78a3a66d9387a8f597553239" };
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const status = document.getElementById("status")!;
const output = document.getElementById("output")!;
const canvas = document.getElementById("screen") as HTMLCanvasElement;
const decoder = new TextDecoder();
let machine: BrowserKernel | undefined;
let attempt = 0;
let cancelPending: (() => void) | undefined;
let role: "host" | "joiner" | undefined;
let gamePid = 0;
let httpPid = 0;
let detachScreen: (() => void) | undefined;
let detachKeyboard: (() => void) | undefined;
const links = new Set<PeerConnection>();
const bridges = new Set<ReturnType<typeof attachNetworkBridge>>();
const processes = new Map<number, { stdout: string; stderr: string; terminal: string; exit: number | null }>();
const trackedSpawns = new Set<Promise<unknown>>();
let directoryTimer: ReturnType<typeof setInterval> | undefined;
let latest: RemoteSegmentSnapshot | undefined;
let refreshing = false;
function append(pid: number, kind: "stdout" | "stderr" | "terminal", data: Uint8Array) {
  const text = decoder.decode(data);
  const process = processes.get(pid) ?? { stdout: "", stderr: "", terminal: "", exit: null };
  process[kind] = (process[kind] + text).slice(-128 * 1024); processes.set(pid, process);
  output.textContent = (output.textContent + `[${pid} ${kind}] ${text}`).slice(-256 * 1024);
  output.scrollTop = output.scrollHeight;
}
function fail(error: unknown) { status.textContent = error instanceof Error ? error.message : String(error); }
async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url); if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  return response.arrayBuffer();
}
async function verifiedAsset(asset: { url: string; sha256: string }) {
  const bytes = await fetchBytes(asset.url);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hash !== asset.sha256) throw new Error("Shareware archive failed its integrity check");
  return new Uint8Array(bytes);
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
  for (const dir of ["/bin", "/root", "/games", "/games/id1", "/www"]) fs.mkdir(dir, 0o755);
  fs.createFileWithOwner("/bin/nc", 0o755, 0, 0, new Uint8Array(nc));
  const image = await finalizeKernelOwnedImage(fs);
  const next = new BrowserKernel({ remoteNetwork: config, kernelOwnedFs: true,
    onProcessStdout: (pid, bytes) => append(pid, "stdout", bytes),
    onProcessStderr: (pid, bytes) => append(pid, "stderr", bytes),
    onProcessEvent: (event) => {
      if (event.kind !== "exit") return;
      const process = processes.get(event.pid);
      if (process && event.exitStatus !== undefined) process.exit = event.exitStatus;
      if (event.pid === gamePid) status.textContent = `Guest game exited ${event.exitStatus ?? "with an unknown status"}`;
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
  detachScreen?.(); detachKeyboard?.(); detachScreen = detachKeyboard = undefined;
  for (const bridge of bridges) bridge.close(); bridges.clear(); links.clear();
  const old = machine; machine = undefined; role = undefined; gamePid = 0; httpPid = 0; latest = undefined;
  if (old) await old.destroy();
  document.getElementById("members")!.textContent = ""; status.textContent = "Disconnected";
}
function requireMachine(): BrowserKernel { if (!machine) throw new Error("Connect a computer first"); return machine; }
async function spawn(path: string, argv: string[], options: { stdin?: Uint8Array; pty?: boolean; cwd?: string } = {}) {
  const kernel = requireMachine();
  const child = await kernel.spawnFromVfs(path, argv, options);
  if (options.pty) kernel.onPtyOutput(child.pid, (bytes) => append(child.pid, "terminal", bytes));
  const process = processes.get(child.pid) ?? { stdout: "", stderr: "", terminal: "", exit: null }; processes.set(child.pid, process);
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
async function stopGame() { if (gamePid) await requireMachine().signalProcess(gamePid, 15); detachScreen?.(); detachKeyboard?.(); gamePid = 0; }
function screen(pid: number) {
  gamePid = pid; const kernel = requireMachine();
  detachScreen?.(); detachKeyboard?.();
  detachScreen = attachCanvas(canvas, kernel.framebuffers, pid, { getProcessMemory: (candidate) => kernel.getProcessMemory(candidate) });
  const keyboard = attachLinuxMediumRawKeyboard(canvas, { sendInput: (bytes) => kernel.ptyWrite(pid, bytes) }, { getEnabled: () => gamePid === pid && processes.get(pid)?.exit === null });
  detachKeyboard = () => keyboard.close(); canvas.focus();
}
async function startGame(game: "doom" | "quake", host: boolean) {
  if (gamePid && processes.get(gamePid)?.exit === null) throw new Error("Stop the running game first");
  const kernel = requireMachine();
  status.textContent = `Preparing ${game} shareware…`;
  if (game === "doom") {
    await Promise.all([install("/bin/fbdoom", doomUrl), verifiedAsset(DOOM_ASSET).then((bytes) => kernel.writeFileToVfs("/games/doom1.wad", bytes))]);
    const args = ["fbdoom", "-iwad", "/games/doom1.wad", "-nosound", "-warp", "1", "1", ...(host ? ["-server", "-privateserver", "-nodes", "2"] : ["-connect", input("destination").value || "host"])];
    const child = await spawn("/bin/fbdoom", args, { pty: true, cwd: "/games" }); screen(child.pid);
  } else {
    await Promise.all([install("/bin/quake", quakeUrl), install("/bin/unzip", unzipUrl), install("/bin/lha", lhaUrl), verifiedAsset(QUAKE_ASSET).then((bytes) => kernel.writeFileToVfs("/games/quake106.zip", bytes))]);
    const unzip = await spawn("/bin/unzip", ["unzip", "-o", "/games/quake106.zip", "resource.1", "-d", "/games"], { stdin: new Uint8Array() });
    if (await unzip.exit !== 0) throw new Error("Guest unzip failed");
    const lha = await spawn("/bin/lha", ["lha", "xf", "resource.1"], { cwd: "/games", stdin: new Uint8Array() });
    const extractionStatus = await lha.exit;
    if (extractionStatus !== 0) throw new Error(`Guest lha exited ${extractionStatus}`);
    const pak = await kernel.readFileFromVfs("/games/id1/pak0.pak");
    if (!pak?.length) throw new Error(`Guest lha failed to extract pak0.pak (exit ${extractionStatus})`);
    const args = ["quake", "-basedir", "/games", "-nosound", "+developer", "1", ...(host ? ["-listen", "2", "+map", "start"] : ["+connect", input("destination").value || "host"])];
    const child = await spawn("/bin/quake", args, { pty: true, cwd: "/games" }); screen(child.pid);
  }
  const exit = processes.get(gamePid)?.exit;
  status.textContent = exit === null ? `Running ${game} (guest process ${gamePid})` : `Guest game exited ${exit ?? "with an unknown status"}`;
}
for (const [id, action] of Object.entries({ host: () => connect("host"), join: () => connect("joiner"), disconnect, listen: () => listen(), send: () => send(), "doom-host": () => startGame("doom", true), "doom-join": () => startGame("doom", false), "quake-host": () => startGame("quake", true), "quake-join": () => startGame("quake", false), "http-start": () => startHttp(), "http-fetch": () => fetchHttp(), "http-stop": stopHttp, "stop-game": stopGame })) {
  document.getElementById(id)!.addEventListener("click", () => { void action().catch(fail); });
}
input("server").value = new URL(location.href).searchParams.get("signalling") ?? "";
window.addEventListener("pagehide", () => { void disconnect(); });
// Observability exposes actual worker state and guest output for browser tests.
Object.assign(window, { __peerNetwork: { snapshot: () => latest, processes: () => Object.fromEntries(processes), listen, send, startGame, startHttp, fetchHttp, stopHttp, disconnect,
  gamePid: () => gamePid, signal: (pid: number, value: number) => requireMachine().signalProcess(pid, value),
  screen: () => { const ctx = canvas.getContext("2d"); return ctx ? [...ctx.getImageData(0, 0, canvas.width, canvas.height).data].reduce((sum, byte, index) => sum + (index % 4 === 3 ? 0 : byte), 0) : 0; },
} });
