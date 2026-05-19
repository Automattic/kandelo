// Manual-SDP WebRTC DataChannel demo — UI + handshake.
//
// Manual copy-paste signaling fundamentally requires non-trickle ICE:
// every candidate must be embedded in the SDP blob the user pastes,
// since there is no out-of-band channel to ship trickled candidates.
// `gatheringComplete` is what gives us that guarantee.
//
// Wire protocol on the DataChannel:
// - JSON envelopes `{"t":"ping"|"pong","ts":<ms>}` for the 1 Hz RTT probe.
// - Anything else is treated as raw chat text.

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

type State = "idle" | "awaiting-answer" | "connecting" | "connected" | "failed";

let pc: RTCPeerConnection | null = null;
let dc: RTCDataChannel | null = null;
let state: State = "idle";
let pingTimer: number | null = null;
let lastRtt: number | null = null;
let candidatePair: { local: string; remote: string } | null = null;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const els = {
  localSdp:    $<HTMLTextAreaElement>("local-sdp"),
  remoteSdp:   $<HTMLTextAreaElement>("remote-sdp"),
  copyLocal:   $<HTMLButtonElement>("copy-local"),
  createOffer: $<HTMLButtonElement>("create-offer"),
  acceptOffer: $<HTMLButtonElement>("accept-offer"),
  acceptAnswer:$<HTMLButtonElement>("accept-answer"),
  reset:       $<HTMLButtonElement>("reset"),
  status:      $<HTMLPreElement>("status"),
  log:         $<HTMLDivElement>("log"),
  sendForm:    $<HTMLFormElement>("send-form"),
  msg:         $<HTMLInputElement>("msg"),
};

const sendButton = els.sendForm.querySelector("button") as HTMLButtonElement;

function setState(next: State): void {
  state = next;
  // Button-enabled matrix (see plan §3 of design)
  els.createOffer.disabled  = !(state === "idle");
  els.acceptOffer.disabled  = !(state === "idle");
  els.acceptAnswer.disabled = !(state === "awaiting-answer");
  els.reset.disabled        =  (state === "idle");
  const canChat             =  (state === "connected");
  els.msg.disabled          = !canChat;
  sendButton.disabled       = !canChat;
  els.msg.placeholder       = canChat ? "Type a message…" : "Connect first…";
  if (canChat) els.msg.focus();
  renderStatus();
}

function renderStatus(): void {
  const lines: string[] = [`state:                ${state}`];
  if (pc) {
    lines.push(`connectionState:      ${pc.connectionState}`);
    lines.push(`iceConnectionState:   ${pc.iceConnectionState}`);
    lines.push(`iceGatheringState:    ${pc.iceGatheringState}`);
    if (candidatePair) {
      lines.push(`active candidate:     ${candidatePair.local} ↔ ${candidatePair.remote}`);
    }
    if (lastRtt !== null) {
      lines.push(`round-trip:           ${lastRtt} ms`);
    }
  }
  els.status.textContent = lines.join("\n");
}

function logMsg(text: string, kind: "self" | "peer" | "system" | "error"): void {
  const line = document.createElement("div");
  line.className = `msg-${kind}`;
  const tag = kind === "self" ? "you" : kind === "peer" ? "peer" : kind === "error" ? "err" : "sys";
  line.textContent = `[${tag}] ${text}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function setupPC(): RTCPeerConnection {
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  conn.addEventListener("connectionstatechange", () => {
    renderStatus();
    if (conn.connectionState === "connected") {
      setState("connected");
      void refreshCandidatePair();
      startPingPong();
    } else if (conn.connectionState === "failed") {
      // "failed" is terminal — ICE has given up. "disconnected" is
      // transient and may recover, so we only surface it in the
      // status panel without changing state.
      stopPingPong();
      if (state !== "idle") {
        setState("failed");
        logMsg("connection failed (ICE could not pair any candidates — try across two different browsers, two profiles, or two machines on your LAN)", "error");
      }
    }
  });
  conn.addEventListener("iceconnectionstatechange", renderStatus);
  conn.addEventListener("icegatheringstatechange",  renderStatus);
  conn.addEventListener("datachannel", (ev) => {
    dc = ev.channel;
    wireDataChannel(dc);
  });
  return conn;
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

function wireDataChannel(channel: RTCDataChannel): void {
  channel.addEventListener("open", () => {
    logMsg("data channel open", "system");
  });
  channel.addEventListener("close", () => {
    logMsg("data channel closed", "system");
    stopPingPong();
  });
  channel.addEventListener("error", (ev) => {
    logMsg(`data channel error: ${(ev as RTCErrorEvent).error?.message ?? "unknown"}`, "error");
  });
  channel.addEventListener("message", (ev: MessageEvent<string>) => {
    handleIncoming(ev.data);
  });
}

function handleIncoming(data: string): void {
  // Try protocol envelope first; fall back to raw chat.
  if (data.startsWith("{\"t\":")) {
    try {
      const m = JSON.parse(data) as { t: string; ts?: number };
      if (m.t === "ping" && typeof m.ts === "number") {
        dc?.send(JSON.stringify({ t: "pong", ts: m.ts }));
        return;
      }
      if (m.t === "pong" && typeof m.ts === "number") {
        lastRtt = Date.now() - m.ts;
        renderStatus();
        return;
      }
    } catch { /* fall through to chat */ }
  }
  logMsg(data, "peer");
}

function startPingPong(): void {
  stopPingPong();
  pingTimer = window.setInterval(() => {
    if (dc?.readyState === "open") {
      dc.send(JSON.stringify({ t: "ping", ts: Date.now() }));
    }
  }, 1000);
}

function stopPingPong(): void {
  if (pingTimer !== null) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

type CandidateStats = { candidateType?: string };

async function refreshCandidatePair(): Promise<void> {
  if (!pc) return;
  // RTCStatsReport is a Map<string, any> at runtime; the lib.dom type
  // omits Map's read accessors, hence the cast.
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
  dc = pc.createDataChannel("kandelo");
  wireDataChannel(dc);
  setState("awaiting-answer");
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gatheringComplete(pc);
    els.localSdp.value = JSON.stringify(pc.localDescription);
    logMsg("offer ready — copy Local SDP and send it to the other peer", "system");
  } catch (e) {
    logMsg(`createOffer failed: ${(e as Error).message}`, "error");
    setState("failed");
  }
}

async function doAcceptOffer(): Promise<void> {
  const remote = els.remoteSdp.value.trim();
  if (!remote) { logMsg("paste the remote SDP first", "error"); return; }
  let parsed: RTCSessionDescriptionInit;
  try { parsed = JSON.parse(remote); }
  catch (e) { logMsg(`remote SDP is not valid JSON: ${(e as Error).message}`, "error"); return; }
  resetSession();
  pc = setupPC();
  setState("connecting");
  try {
    await pc.setRemoteDescription(parsed);
    await pc.setLocalDescription(await pc.createAnswer());
    await gatheringComplete(pc);
    els.localSdp.value = JSON.stringify(pc.localDescription);
    logMsg("answer ready — copy Local SDP and send it back", "system");
  } catch (e) {
    logMsg(`acceptOffer failed: ${(e as Error).message}`, "error");
    setState("failed");
  }
}

async function doAcceptAnswer(): Promise<void> {
  if (!pc) { logMsg("no offer to accept answer for", "error"); return; }
  const remote = els.remoteSdp.value.trim();
  if (!remote) { logMsg("paste the remote SDP first", "error"); return; }
  let parsed: RTCSessionDescriptionInit;
  try { parsed = JSON.parse(remote); }
  catch (e) { logMsg(`remote SDP is not valid JSON: ${(e as Error).message}`, "error"); return; }
  setState("connecting");
  try {
    await pc.setRemoteDescription(parsed);
  } catch (e) {
    logMsg(`acceptAnswer failed: ${(e as Error).message}`, "error");
    setState("failed");
  }
}

function resetSession(): void {
  stopPingPong();
  dc?.close();
  pc?.close();
  dc = null;
  pc = null;
  candidatePair = null;
  lastRtt = null;
}

function doReset(): void {
  resetSession();
  els.localSdp.value = "";
  els.remoteSdp.value = "";
  els.log.replaceChildren();
  setState("idle");
  logMsg("reset — ready for a new handshake", "system");
}

async function doCopyLocal(): Promise<void> {
  if (!els.localSdp.value) return;
  await navigator.clipboard.writeText(els.localSdp.value);
  logMsg("local SDP copied to clipboard", "system");
}

function doSend(ev: SubmitEvent): void {
  ev.preventDefault();
  const text = els.msg.value;
  if (!text || dc?.readyState !== "open") return;
  dc.send(text);
  logMsg(text, "self");
  els.msg.value = "";
}

els.createOffer.addEventListener("click",   doCreateOffer);
els.acceptOffer.addEventListener("click",   doAcceptOffer);
els.acceptAnswer.addEventListener("click",  doAcceptAnswer);
els.reset.addEventListener("click",         doReset);
els.copyLocal.addEventListener("click",     doCopyLocal);
els.sendForm.addEventListener("submit",     doSend);

setState("idle");

// Keep the dev-console driver around for ad-hoc debugging.
(window as unknown as { rtc: unknown }).rtc = {
  createOffer: doCreateOffer,
  acceptOffer: doAcceptOffer,
  acceptAnswer: doAcceptAnswer,
  reset: doReset,
  get pc() { return pc; },
  get dc() { return dc; },
  get state() { return state; },
};
