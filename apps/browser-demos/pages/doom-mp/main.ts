/**
 * Multiplayer DOOM over WebRTC — page entry point.
 *
 * Two browsers exchange SDP manually (same flow as pages/webrtc/), open a
 * pair of RTCDataChannels (a JSON "probe" for RTT, a binary "doom" for game
 * UDP), then boot fbDOOM with role-dependent CLI flags. The `doom` channel
 * is handed to a RelayChannel which bridges to the kernel's UDP socket via
 * `kernel.injectDatagram` / `kernel.onHostSendDgram`.
 *
 * See `docs/plans/2026-05-19-multiplayer-doom-webrtc-design.md` for the
 * full architecture; this file is §5 (relay backend) + §7 (user flow)
 * stitched into a single page.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import { attachCanvas } from "../../../../host/src/framebuffer/canvas-renderer";
import { RelayChannel } from "../../lib/relay-network-backend";
import fbdoomWasmUrl from "@binaries/programs/wasm32/fbdoom.wasm?url";
import kernelWasmUrl from "@kernel-wasm?url";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/**
 * Channel parameters. Both peers MUST construct both channels with the
 * same `negotiated:true` + `id` so the SCTP streams line up without an
 * `ondatachannel` handshake.
 *
 *   probe: reliable + ordered (default) — JSON RTT pings. Loss-tolerant
 *          but we want monotonic timestamps; default-reliable keeps the
 *          numbers honest.
 *   doom:  unordered + maxRetransmits:0 — matches SOCK_DGRAM / UDP. fbDOOM
 *          retransmits at the application layer, so SCTP shouldn't.
 */
const PROBE_CHANNEL_ID = 0;
const DOOM_CHANNEL_ID = 1;

type Role = "host" | "join";
type State =
  | "idle"
  | "awaiting-answer"
  | "connecting"
  | "connected"
  | "running"
  | "exited"
  | "failed";

const WAD_VFS_PATH = "/usr/local/games/doom/doom1.wad";

// DOOM shareware IWAD — id Software, freely redistributable. See
// pages/doom/main.ts for the rationale on this mirror + cache shape.
const SHAREWARE_WAD_URL =
  "https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad";
const SHAREWARE_WAD_SHA256 =
  "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771";
const WAD_CACHE_NAME = "fbdoom-wad";

let pc: RTCPeerConnection | null = null;
let probeChan: RTCDataChannel | null = null;
let doomChan: RTCDataChannel | null = null;
let relay: RelayChannel | null = null;
let state: State = "idle";
let pingTimer: number | null = null;
let lastRtt: number | null = null;
let candidatePair: { local: string; remote: string } | null = null;

/**
 * Per-game-session resources allocated by startDoom() — kernel worker,
 * AudioContext + its polling timer, and the keyboard/mouse listeners
 * attached to the canvas. All of them outlive a Reset unless we tear
 * them down explicitly; without this struct, each Reset+Start cycle
 * stacks another kernel worker + AudioContext + listener fanout, and
 * the page becomes unusable after a few iterations.
 */
interface GameSession {
  cleanup: () => Promise<void>;
}
let gameSession: GameSession | null = null;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const els = {
  localSdp:     $<HTMLTextAreaElement>("local-sdp"),
  remoteSdp:    $<HTMLTextAreaElement>("remote-sdp"),
  copyLocal:    $<HTMLButtonElement>("copy-local"),
  createOffer:  $<HTMLButtonElement>("create-offer"),
  acceptOffer:  $<HTMLButtonElement>("accept-offer"),
  acceptAnswer: $<HTMLButtonElement>("accept-answer"),
  reset:        $<HTMLButtonElement>("reset"),
  startDoom:    $<HTMLButtonElement>("start-doom"),
  status:       $<HTMLPreElement>("status"),
  canvas:       $<HTMLCanvasElement>("fb"),
};

function currentRole(): Role {
  const r = document.querySelector<HTMLInputElement>(
    'input[name="role"]:checked',
  );
  return (r?.value as Role) ?? "host";
}

function setRoleEditable(editable: boolean): void {
  for (const r of document.querySelectorAll<HTMLInputElement>(
    'input[name="role"]',
  )) {
    r.disabled = !editable;
  }
}

function setState(next: State): void {
  state = next;
  els.createOffer.disabled  = !(state === "idle");
  els.acceptOffer.disabled  = !(state === "idle");
  els.acceptAnswer.disabled = !(state === "awaiting-answer");
  els.reset.disabled        =  (state === "idle");
  // Start DOOM enabled once both channels are open. The state machine
  // sets us to "connected" on connectionState=connected, but the channels
  // open slightly after that — see channel `open` listeners below.
  els.startDoom.disabled    = !(state === "connected" && channelsOpen());
  // The role drives spawn args + synthetic IP, so it must not change
  // mid-game. Lock it once handshaking starts.
  setRoleEditable(state === "idle");
  renderStatus();
}

function channelsOpen(): boolean {
  return probeChan?.readyState === "open" && doomChan?.readyState === "open";
}

function renderStatus(): void {
  const lines: string[] = [
    `state:                ${state}`,
    `role:                 ${currentRole()} (${
      currentRole() === "host" ? "10.99.0.1" : "10.99.0.2"
    })`,
  ];
  if (pc) {
    lines.push(`connectionState:      ${pc.connectionState}`);
    lines.push(`iceConnectionState:   ${pc.iceConnectionState}`);
    lines.push(`iceGatheringState:    ${pc.iceGatheringState}`);
    if (candidatePair) {
      lines.push(`active candidate:     ${candidatePair.local} ↔ ${candidatePair.remote}`);
    }
    if (probeChan) lines.push(`probe channel:        ${probeChan.readyState}`);
    if (doomChan)  lines.push(`doom channel:         ${doomChan.readyState}`);
    if (lastRtt !== null) {
      lines.push(`round-trip:           ${lastRtt} ms`);
    }
  }
  els.status.textContent = lines.join("\n");
}

function setupPC(): RTCPeerConnection {
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Both peers create both channels with `negotiated:true`. SCTP pairs
  // them by id without an `ondatachannel` event, so this works for
  // either offer or answer side without role-asymmetric code.
  probeChan = conn.createDataChannel("probe", {
    negotiated: true,
    id: PROBE_CHANNEL_ID,
  });
  doomChan = conn.createDataChannel("doom", {
    negotiated: true,
    id: DOOM_CHANNEL_ID,
    ordered: false,
    maxRetransmits: 0,
  });
  wireProbeChannel(probeChan);
  wireDoomChannel(doomChan);

  conn.addEventListener("connectionstatechange", () => {
    renderStatus();
    if (conn.connectionState === "connected") {
      setState("connected");
      void refreshCandidatePair();
      startPingPong();
    } else if (conn.connectionState === "failed") {
      stopPingPong();
      if (state !== "idle" && state !== "exited") {
        setState("failed");
      }
    }
  });
  conn.addEventListener("iceconnectionstatechange", renderStatus);
  conn.addEventListener("icegatheringstatechange", renderStatus);
  return conn;
}

function wireProbeChannel(channel: RTCDataChannel): void {
  channel.addEventListener("open", () => {
    // Re-evaluate Start DOOM enabled-ness.
    if (state === "connected") setState("connected");
    renderStatus();
  });
  channel.addEventListener("close", () => {
    stopPingPong();
    renderStatus();
  });
  channel.addEventListener("message", (ev: MessageEvent<string>) => {
    if (typeof ev.data !== "string") return;
    if (!ev.data.startsWith("{\"t\":")) return;
    try {
      const m = JSON.parse(ev.data) as { t: string; ts?: number };
      if (m.t === "ping" && typeof m.ts === "number") {
        channel.send(JSON.stringify({ t: "pong", ts: m.ts }));
      } else if (m.t === "pong" && typeof m.ts === "number") {
        lastRtt = Date.now() - m.ts;
        renderStatus();
      }
    } catch {
      // Ignore — probe channel only carries JSON, anything malformed
      // is a future protocol extension we don't understand yet.
    }
  });
}

function wireDoomChannel(channel: RTCDataChannel): void {
  channel.addEventListener("open", () => {
    if (state === "connected") setState("connected");
    renderStatus();
  });
  channel.addEventListener("close", renderStatus);
  // Inbound game messages are consumed by RelayChannel once it's
  // constructed; before then we just drop them on the floor (fbDOOM's
  // netcode self-heals via retry — see design §7 "bring-up race").
}

function startPingPong(): void {
  stopPingPong();
  pingTimer = window.setInterval(() => {
    if (probeChan?.readyState === "open") {
      probeChan.send(JSON.stringify({ t: "ping", ts: Date.now() }));
    }
  }, 1000);
}

function stopPingPong(): void {
  if (pingTimer !== null) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function gatheringComplete(conn: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (conn.iceGatheringState === "complete") {
      resolve();
      return;
    }
    const check = () => {
      if (conn.iceGatheringState === "complete") {
        conn.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    conn.addEventListener("icegatheringstatechange", check);
  });
}

type CandidateStats = { candidateType?: string };

async function refreshCandidatePair(): Promise<void> {
  if (!pc) return;
  const stats = (await pc.getStats()) as unknown as Map<string, RTCStats>;
  let pair: RTCIceCandidatePairStats | null = null;
  for (const s of stats.values()) {
    if (s.type !== "candidate-pair") continue;
    const cp = s as RTCIceCandidatePairStats;
    if (cp.state !== "succeeded") continue;
    if (cp.nominated) { pair = cp; break; }
    pair ??= cp;
  }
  if (!pair) return;
  const local  = stats.get(pair.localCandidateId)  as CandidateStats | undefined;
  const remote = stats.get(pair.remoteCandidateId) as CandidateStats | undefined;
  if (!local || !remote) return;
  candidatePair = {
    local:  local.candidateType  ?? "unknown",
    remote: remote.candidateType ?? "unknown",
  };
  renderStatus();
}

async function doCreateOffer(): Promise<void> {
  resetSession();
  pc = setupPC();
  setState("awaiting-answer");
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gatheringComplete(pc);
    els.localSdp.value = JSON.stringify(pc.localDescription);
  } catch (e) {
    console.error("createOffer failed:", e);
    setState("failed");
  }
}

async function doAcceptOffer(): Promise<void> {
  const remote = els.remoteSdp.value.trim();
  if (!remote) return;
  let parsed: RTCSessionDescriptionInit;
  try {
    parsed = JSON.parse(remote);
  } catch (e) {
    console.error("remote SDP not valid JSON:", e);
    return;
  }
  resetSession();
  pc = setupPC();
  setState("connecting");
  try {
    await pc.setRemoteDescription(parsed);
    await pc.setLocalDescription(await pc.createAnswer());
    await gatheringComplete(pc);
    els.localSdp.value = JSON.stringify(pc.localDescription);
  } catch (e) {
    console.error("acceptOffer failed:", e);
    setState("failed");
  }
}

async function doAcceptAnswer(): Promise<void> {
  if (!pc) return;
  const remote = els.remoteSdp.value.trim();
  if (!remote) return;
  let parsed: RTCSessionDescriptionInit;
  try {
    parsed = JSON.parse(remote);
  } catch (e) {
    console.error("remote SDP not valid JSON:", e);
    return;
  }
  setState("connecting");
  try {
    await pc.setRemoteDescription(parsed);
  } catch (e) {
    console.error("acceptAnswer failed:", e);
    setState("failed");
  }
}

function resetSession(): void {
  stopPingPong();
  relay?.close();
  relay = null;
  doomChan?.close();
  probeChan?.close();
  pc?.close();
  doomChan = null;
  probeChan = null;
  pc = null;
  candidatePair = null;
  lastRtt = null;
  // Tear down a running/exited/failed game session — kernel worker,
  // AudioContext, canvas listeners. Idle/awaiting/connecting/connected
  // never allocated a session in the first place, so there's nothing
  // to clean up. Fire-and-forget: the user clicked Reset and we don't
  // want to await async teardown before they can start a new offer.
  if (gameSession) {
    const session = gameSession;
    gameSession = null;
    void session.cleanup();
  }
}

function doReset(): void {
  resetSession();
  els.localSdp.value = "";
  els.remoteSdp.value = "";
  setState("idle");
}

async function doCopyLocal(): Promise<void> {
  if (!els.localSdp.value) return;
  await navigator.clipboard.writeText(els.localSdp.value);
}

// ---------------------------------------------------------------------
// Game boot — pid + WAD + fbdoom spawn, lifted from pages/doom/main.ts.
// The only doom-mp specifics are (a) the RelayChannel constructed over
// the open doomChan, and (b) the role-dependent fbDOOM CLI flags.
// ---------------------------------------------------------------------

async function loadSharewareWad(
  setStatus: (text: string) => void,
): Promise<Uint8Array> {
  const cache = await caches.open(WAD_CACHE_NAME);
  const cached = await cache.match(SHAREWARE_WAD_URL);
  if (cached) {
    setStatus("Loading cached DOOM shareware IWAD…");
    const buf = await cached.arrayBuffer();
    return new Uint8Array(buf);
  }

  const fetchUrl = import.meta.env.DEV
    ? `/cors-proxy?url=${encodeURIComponent(SHAREWARE_WAD_URL)}`
    : SHAREWARE_WAD_URL;

  setStatus("Downloading DOOM shareware IWAD (~4 MB)…");
  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching doom1.wad`);
  }
  const buf = await response.arrayBuffer();
  const bytes = new Uint8Array(buf);

  setStatus("Verifying DOOM shareware IWAD…");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (hex !== SHAREWARE_WAD_SHA256) {
    throw new Error(
      `doom1.wad sha256 mismatch — expected ${SHAREWARE_WAD_SHA256}, got ${hex}`,
    );
  }

  await cache.put(
    SHAREWARE_WAD_URL,
    new Response(bytes, {
      headers: {
        "Content-Type": "application/x-doom",
        "Content-Length": String(bytes.byteLength),
      },
    }),
  );
  return bytes;
}

/** Browser KeyboardEvent.code → Linux keycode (see pages/doom/main.ts). */
const SCANCODE: Record<string, number> = {
  Escape: 1,
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyE: 18, KeyR: 19, KeyT: 20,
  KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyF: 33, KeyG: 34,
  KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39,
  Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48,
  KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53,
  ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57,
  CapsLock: 58, F1: 59, F2: 60, F3: 61, F4: 62, F5: 63,
  F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  ControlRight: 97, AltRight: 100,
  ArrowUp:    103, KeyW: 103,
  ArrowDown:  108, KeyS: 108,
  ArrowLeft:  105, KeyA: 105,
  ArrowRight: 106, KeyD: 106,
};

async function startDoom(): Promise<void> {
  if (state !== "connected" || !doomChan || doomChan.readyState !== "open") {
    return;
  }
  els.startDoom.disabled = true;
  setState("running");

  const role = currentRole();
  // Synthetic /24 — design §2 / §5.1. Host is .1, joiner is .2.
  const peerAddr: [number, number, number, number] =
    role === "host" ? [10, 99, 0, 2] : [10, 99, 0, 1];

  const kernel = new BrowserKernel({
    onStdout: (data) => {
      console.log("[doom-mp stdout]", new TextDecoder().decode(data));
    },
    onStderr: (data) => {
      console.warn("[doom-mp stderr]", new TextDecoder().decode(data));
    },
  });

  const kernelBytes = await fetch(kernelWasmUrl).then((r) => r.arrayBuffer());
  await kernel.init(kernelBytes);

  let wadBytes: Uint8Array;
  try {
    wadBytes = await loadSharewareWad((text) => {
      // Surface boot progress in the status panel without clobbering the
      // role/RTT lines — append a transient "boot:" line.
      els.status.textContent += `\nboot:                 ${text}`;
    });
  } catch (err) {
    console.error("WAD fetch failed:", err);
    setState("failed");
    return;
  }
  const wadBlobUrl = URL.createObjectURL(
    new Blob([wadBytes], { type: "application/x-doom" }),
  );
  kernel.registerLazyFiles([
    {
      path: WAD_VFS_PATH,
      url: wadBlobUrl,
      size: wadBytes.byteLength,
      mode: 0o444,
    },
  ]);
  await kernel.ensureMaterialized(WAD_VFS_PATH);
  URL.revokeObjectURL(wadBlobUrl);

  const fbdoomBytes = await fetch(fbdoomWasmUrl).then((r) => r.arrayBuffer());

  // RelayChannel must be wired BEFORE the spawn returns control to
  // fbDOOM's syscall path — otherwise the first inbound datagram from
  // the peer races ahead of `setTargetPid`. We construct the relay,
  // then capture nextPid (the pid the spawn will receive), set it on
  // the relay, then spawn. injectDatagram before bind() is harmless:
  // the kernel-wasm finds no matching socket and the packet is dropped,
  // and fbDOOM's NET_CL_Run retry-loops past that.
  relay = new RelayChannel({
    kernel,
    channel: doomChan,
    peerAddr,
  });
  const pid = kernel.nextPid;
  relay.setTargetPid(pid);

  // CLI flags (design §6):
  //   -server / -connect select role. -privateserver is HOST-ONLY: it
  //   triggers the server-startup branch in d_loop.c (same as -server)
  //   AND gates out NET_SV_RegisterWithMaster's master.chocolate-doom.org
  //   lookup. Passing it on the joiner would route the joiner into the
  //   server branch too, making it connect to its own in-process loopback
  //   instead of dialing 10.99.0.1.
  //   -deathmatch + -warp 1 1 drops both players into E1M1 deathmatch.
  const args: string[] = role === "host"
    ? [
        "fbdoom", "-iwad", WAD_VFS_PATH,
        "-server", "-privateserver",
        "-deathmatch", "-warp", "1", "1",
      ]
    : [
        "fbdoom", "-iwad", WAD_VFS_PATH,
        "-connect", "10.99.0.1",
        "-deathmatch", "-warp", "1", "1",
      ];

  const exitPromise = kernel.spawn(fbdoomBytes, args, {
    env: ["HOME=/home", "TERM=linux"],
    cwd: "/home",
  });

  attachCanvas(els.canvas, kernel.framebuffers, pid, {
    getProcessMemory: (p) => kernel.getProcessMemory(p),
  });

  // Audio — identical to pages/doom/. Multiplayer audio is local-only
  // (design §1 non-goals: "No audio over the channel").
  const audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") void audioCtx.resume();
  let audioCursor = audioCtx.currentTime;
  let audioSampleRate = 44100;
  let audioChannels = 2;
  let audioStopped = false;

  const AUDIO_POLL_MS = 50;
  const AUDIO_DRAIN_BYTES = 32 * 1024;
  const audioTimer = window.setInterval(async () => {
    if (audioStopped || audioCtx.state !== "running") return;
    let drain;
    try {
      drain = await kernel.drainAudio(AUDIO_DRAIN_BYTES);
    } catch {
      return;
    }
    const { bytes, sampleRate, channels } = drain;
    if (bytes.byteLength === 0) return;
    if (sampleRate > 0) audioSampleRate = sampleRate;
    if (channels > 0) audioChannels = channels;

    const bytesPerFrame = 2 * audioChannels;
    const frames = Math.floor(bytes.byteLength / bytesPerFrame);
    if (frames === 0) return;
    const buffer = audioCtx.createBuffer(audioChannels, frames, audioSampleRate);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let ch = 0; ch < audioChannels; ch++) {
      const dst = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) {
        const sample = view.getInt16((i * audioChannels + ch) * 2, true);
        dst[i] = sample / 32768;
      }
    }

    const now = audioCtx.currentTime;
    const lookahead = 0.04;
    const maxLookahead = 0.15;
    if (audioCursor < now + lookahead) {
      audioCursor = now + lookahead;
    } else if (audioCursor > now + maxLookahead) {
      audioCursor = now + lookahead;
      return;
    }
    const node = audioCtx.createBufferSource();
    node.buffer = buffer;
    node.connect(audioCtx.destination);
    node.start(audioCursor);
    audioCursor += frames / audioSampleRate;
  }, AUDIO_POLL_MS);

  // Keyboard + mouse — identical to pages/doom/. Listener references
  // are hoisted so resetSession() can detach them; without this the
  // canvas keeps fanning out keystrokes to a now-dead kernel after
  // each Reset+Start cycle.
  els.canvas.focus();
  const heldKeys = new Set<string>();
  let mouseButtons = 0;
  const sendScancode = (code: number, pressed: boolean) => {
    const byte = pressed ? code & 0x7f : code | 0x80;
    kernel.appendStdinData(pid, new Uint8Array([byte]));
  };
  const buttonBit = (b: number) => (b === 0 ? 1 : b === 2 ? 2 : b === 1 ? 4 : 0);
  const onKeyDown = (e: KeyboardEvent) => {
    const code = SCANCODE[e.code];
    if (code === undefined) return;
    e.preventDefault();
    if (heldKeys.has(e.code)) return;
    heldKeys.add(e.code);
    sendScancode(code, true);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const code = SCANCODE[e.code];
    if (code === undefined) return;
    e.preventDefault();
    heldKeys.delete(e.code);
    sendScancode(code, false);
  };
  const onBlur = () => {
    for (const k of heldKeys) {
      const code = SCANCODE[k];
      if (code !== undefined) sendScancode(code, false);
    }
    heldKeys.clear();
    if (mouseButtons !== 0) {
      mouseButtons = 0;
      kernel.injectMouseEvent(0, 0, 0);
    }
  };
  const onClick = () => {
    els.canvas.focus();
    if (document.pointerLockElement !== els.canvas) {
      els.canvas.requestPointerLock();
    }
  };
  const onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== els.canvas) return;
    const dx = e.movementX | 0;
    const dy = -(e.movementY | 0);
    if (dx === 0 && dy === 0) return;
    kernel.injectMouseEvent(dx, dy, mouseButtons);
  };
  const onMouseDown = (e: MouseEvent) => {
    if (document.pointerLockElement !== els.canvas) return;
    const bit = buttonBit(e.button);
    if (bit === 0) return;
    e.preventDefault();
    mouseButtons |= bit;
    kernel.injectMouseEvent(0, 0, mouseButtons);
  };
  const onMouseUp = (e: MouseEvent) => {
    const bit = buttonBit(e.button);
    if (bit === 0) return;
    e.preventDefault();
    mouseButtons &= ~bit;
    kernel.injectMouseEvent(0, 0, mouseButtons);
  };
  const onContextMenu = (e: Event) => e.preventDefault();
  els.canvas.addEventListener("keydown", onKeyDown);
  els.canvas.addEventListener("keyup", onKeyUp);
  els.canvas.addEventListener("blur", onBlur);
  els.canvas.addEventListener("click", onClick);
  els.canvas.addEventListener("mousemove", onMouseMove);
  els.canvas.addEventListener("mousedown", onMouseDown);
  els.canvas.addEventListener("mouseup", onMouseUp);
  els.canvas.addEventListener("contextmenu", onContextMenu);

  const detachCanvasListeners = (): void => {
    els.canvas.removeEventListener("keydown", onKeyDown);
    els.canvas.removeEventListener("keyup", onKeyUp);
    els.canvas.removeEventListener("blur", onBlur);
    els.canvas.removeEventListener("click", onClick);
    els.canvas.removeEventListener("mousemove", onMouseMove);
    els.canvas.removeEventListener("mousedown", onMouseDown);
    els.canvas.removeEventListener("mouseup", onMouseUp);
    els.canvas.removeEventListener("contextmenu", onContextMenu);
  };

  const stopAudio = (): void => {
    if (audioStopped) return;
    audioStopped = true;
    window.clearInterval(audioTimer);
    void audioCtx.close().catch(() => {});
  };

  // Register this session so resetSession() can tear it down. The
  // teardown order matters: stop audio first (kills the polling timer
  // before the kernel goes away), then detach listeners (no more
  // appendStdinData / injectMouseEvent calls), then destroy the
  // kernel (terminates the worker thread).
  gameSession = {
    cleanup: async () => {
      stopAudio();
      detachCanvasListeners();
      try {
        await kernel.destroy();
      } catch (err) {
        console.warn("[doom-mp] kernel destroy failed:", err);
      }
    },
  };

  exitPromise
    .then((status) => {
      console.log(`[doom-mp] fbdoom exited with status ${status}`);
      setState("exited");
    })
    .catch((err) => {
      console.error("[doom-mp] fbdoom error:", err);
      setState("failed");
    })
    .finally(stopAudio);
}

els.createOffer.addEventListener("click",  doCreateOffer);
els.acceptOffer.addEventListener("click",  doAcceptOffer);
els.acceptAnswer.addEventListener("click", doAcceptAnswer);
els.reset.addEventListener("click",        doReset);
els.copyLocal.addEventListener("click",    doCopyLocal);
els.startDoom.addEventListener("click",    () => { void startDoom(); });

for (const r of document.querySelectorAll<HTMLInputElement>(
  'input[name="role"]',
)) {
  r.addEventListener("change", renderStatus);
}

setState("idle");
