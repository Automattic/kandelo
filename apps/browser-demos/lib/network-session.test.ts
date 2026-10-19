import assert from "node:assert/strict";
import test from "node:test";

import type { RemoteSessionSnapshot } from "../../../host/src/networking/remote-segment-runtime.ts";
import { encodePeerSignal, type PeerConnection } from "../../../web-libs/kandelo-session/src/peer-connection.ts";
import * as realSignalling from "./peer-signalling.ts";
import {
  NetworkSessionController, SESSION_MEMBER_CAP, sessionInvitation, sessionLink,
  type SessionMachine, type SessionSignalling, type SessionTransport, type SharingTransport,
} from "./network-session.ts";
import type { PeerLink } from "./sharing-peer.ts";

const SERVER = "https://signal.test/piplet.php";
const until = async (check: () => boolean, what: string) => {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** The room API's semantics over an in-memory store, as piplet keeps them. */
function fakeSignalling() {
  const rooms = new Map<string, { key: string; name: string; joins: Map<string, { offer: string; answer: string | null; refused: string | null }> }>();
  const api: SessionSignalling = {
    ...realSignalling,
    async hostRoom(_server, room, key, name) {
      const existing = rooms.get(room);
      if (existing && existing.key !== key) throw new Error("forbidden");
      const entry = existing ?? { key, name, joins: new Map() };
      rooms.set(room, entry);
      const joins = [...entry.joins].filter(([, j]) => j.answer === null && j.refused === null).map(([join, j]) => ({ join, offer: j.offer }));
      return { room, name: entry.name, joins };
    },
    async answerRoomJoin(_server, room, _key, join, answer) { rooms.get(room)!.joins.get(join)!.answer = answer; },
    async refuseRoomJoin(_server, room, _key, join, reason) { rooms.get(room)!.joins.get(join)!.refused = reason; },
    async closeRoom(_server, room) { rooms.delete(room); },
    async readRoom(_server, room) {
      const entry = rooms.get(room);
      if (!entry) throw new realSignalling.RoomClosedError("no such room");
      return { room, name: entry.name };
    },
    async postRoomJoin(_server, room, join, offer) {
      const entry = rooms.get(room);
      if (!entry) throw new realSignalling.RoomClosedError("no such room");
      entry.joins.set(join, { offer, answer: null, refused: null });
    },
    async waitForRoomAnswer(_server, room, join, stillWanted) {
      while (stillWanted()) {
        const status = rooms.get(room)?.joins.get(join);
        if (!status) throw new Error("the room closed");
        if (status.refused !== null) throw new Error(`the hosting computer refused: ${status.refused}`);
        if (status.answer !== null) return status.answer;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return null;
    },
  };
  return { api, rooms };
}

function fakeLink(): PeerConnection & { closed: boolean } {
  const listeners = new Set<() => void>();
  const link = {
    channels: new Map(), messages: new Map(), maxMessageSize: 65536, closed: false,
    onClose(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    onFailure() { return () => {}; },
    close() { if (link.closed) return; link.closed = true; for (const listener of listeners) listener(); },
  };
  return link as unknown as PeerConnection & { closed: boolean };
}

/** Offers and answers pair links through a shared table, like real WebRTC. */
function fakeTransport(pairs: Map<string, PeerConnection>): SessionTransport {
  let next = 0;
  return {
    async createInvite() {
      const invite = `offer-${next++}`;
      return {
        invite,
        async acceptAnswer(answer) { assert.equal(answer, `answer-for-${invite}`); return fakeLink(); },
        cancel() {},
      };
    },
    async answerInvite(code) {
      const link = fakeLink();
      pairs.set(code, link);
      return { answer: `answer-for-${code}`, connected: Promise.resolve(link), cancel() {} };
    },
    bridge(link) {
      const peer = { port: {} as MessagePort, maxPayload: 1200, maxControlBytes: 65536 };
      return { peer, close() { link.close(); } };
    },
  };
}

function fakeMachine(): SessionMachine & { attached: number; joined: number; left: number; state: RemoteSessionSnapshot["state"]; lastDisconnect: string | null } {
  const machine = {
    attached: 0, joined: 0, left: 0, state: "offline" as RemoteSessionSnapshot["state"], lastDisconnect: null as string | null,
    async hostRemoteNetwork() { machine.state = "hosting"; return "10.89.0.1"; },
    async joinRemoteNetwork() { machine.joined++; machine.state = "joined"; return `10.89.0.${machine.joined + 1}`; },
    async attachRemotePeer() { machine.attached++; return machine.attached; },
    async leaveRemoteNetwork() { machine.left++; machine.state = "offline"; },
    async remoteNetworkSnapshot(): Promise<RemoteSessionSnapshot> {
      const members = machine.state === "offline" ? [] : Array.from({ length: machine.attached + 1 }, (_, i) => ({ id: i, address: `10.89.0.${i + 1}`, hostname: i ? `peer-${i}` : "host" }));
      return { state: machine.state, lastDisconnect: machine.lastDisconnect, members } as unknown as RemoteSessionSnapshot;
    },
  };
  return machine;
}

/** A sharing link the test can close from either end. */
function fakeSharingLink(): PeerLink & { closed: boolean } {
  const listeners = new Set<() => void>();
  const link = {
    handover: {}, mirror: {}, terminal: {}, replication: {}, closed: false,
    onClose(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { if (link.closed) return; link.closed = true; for (const listener of listeners) listener(); },
  };
  return link as unknown as PeerLink & { closed: boolean };
}

/**
 * Sharing offers are real connect codes declaring `sharing`, since that is
 * how the host tells them from network joins. Both ends of a pair share one
 * fake link, so closing it closes the pair.
 */
function fakeSharing(options: { failInvite?: string } = {}): SharingTransport & { links: Map<string, PeerLink & { closed: boolean }> } {
  const links = new Map<string, PeerLink & { closed: boolean }>();
  let next = 0;
  const code = (type: "offer" | "answer", sdp: string) =>
    encodePeerSignal({ type, sdp }, { purpose: "sharing", channels: [{ label: "foo" }] });
  return {
    links,
    async createInvite() {
      if (options.failInvite) throw new Error(options.failInvite);
      const sdp = `sharing-${next++}`;
      const link = fakeSharingLink();
      links.set(sdp, link);
      return { invite: code("offer", sdp), async acceptAnswer() { return link; }, cancel() {} };
    },
    async answerInvite(offer) {
      const sdp = JSON.parse(atob(offer.slice("kandelo1:".length))).sdp as string;
      return { answer: code("answer", sdp), connected: Promise.resolve(links.get(sdp)!), cancel() {} };
    },
  };
}

function controller(
  machine: SessionMachine | null, api: SessionSignalling, pairs = new Map<string, PeerConnection>(), sharing?: SharingTransport,
) {
  return new NetworkSessionController({
    machine: () => machine, server: () => SERVER, transport: fakeTransport(pairs), sharing,
    pageHref: () => "https://kandelo.test/app/?vfs=https://evil.test/x.vfs#boot", api,
    hostPollMs: 5, snapshotPollMs: 5,
  });
}

test("a shared link names the machine and the session, never scripts or other state", () => {
  const link = sessionLink("https://kandelo.test/app/?vfs=https://images.test/doom.vfs.zst&profile=doom&debug=1#k1=script", "abcdefghijklmnopqrstuvwxyz", "LAN party");
  assert.equal(link, "https://kandelo.test/app/?vfs=https%3A%2F%2Fimages.test%2Fdoom.vfs.zst&profile=doom&network=abcdefghijklmnopqrstuvwxyz&networkName=LAN+party");
  // A page that runs the default machine names none.
  assert.equal(sessionLink("https://kandelo.test/app/", "abcdefghijklmnopqrstuvwxyz", "LAN party"),
    "https://kandelo.test/app/?network=abcdefghijklmnopqrstuvwxyz&networkName=LAN+party");
  assert.deepEqual(sessionInvitation(link), { room: "abcdefghijklmnopqrstuvwxyz", name: "LAN party" });
  assert.equal(sessionInvitation("https://kandelo.test/app/?network=SHORT"), null);
  assert.equal(sessionInvitation("https://kandelo.test/app/?network=abcdefghijklmnopqrstuvwxyz&networkName=a%00b")?.name, "ab");
});

test("a host admits several joiners through one room", async () => {
  const { api, rooms } = fakeSignalling();
  const hostMachine = fakeMachine();
  const host = controller(hostMachine, api);
  await host.create("  LAN party  ");
  const state = host.getState();
  assert.equal(state.phase, "connected");
  assert.equal(state.name, "LAN party");
  const invitation = sessionInvitation(state.link!)!;
  assert.equal(invitation.name, "LAN party");
  assert.ok(rooms.has(invitation.room));

  const joiners = [fakeMachine(), fakeMachine(), fakeMachine()];
  const controllers = joiners.map((machine) => controller(machine, api));
  await Promise.all(controllers.map((joiner) => joiner.join(invitation.room, invitation.name)));
  for (const joiner of controllers) assert.equal(joiner.getState().phase, "connected", joiner.getState().error ?? "");
  await until(() => hostMachine.attached === 3, "the host to attach three joiners");
  await until(() => host.getState().snapshot?.members.length === 4, "the host snapshot");

  await host.leave();
  assert.equal(rooms.has(invitation.room), false, "leaving closes the room");
  assert.equal(hostMachine.left, 1);
  assert.equal(host.getState().phase, "offline");
  for (const joiner of controllers) await joiner.leave();
});

test("a joiner reports the session ending under it", async () => {
  const { api } = fakeSignalling();
  const host = controller(fakeMachine(), api);
  await host.create("Quake");
  const { room, name } = sessionInvitation(host.getState().link!)!;
  const joinerMachine = fakeMachine();
  const joiner = controller(joinerMachine, api);
  await joiner.join(room, name);
  joinerMachine.state = "offline";
  joinerMachine.lastDisconnect = "the hosting computer closed the session";
  await until(() => joiner.getState().phase === "error", "the joiner to notice");
  // It cannot tell the host leaving from the link failing, and says so; the
  // worker's own reason stays available as detail.
  assert.match(joiner.getState().error!, /The host left, or the link between you failed/);
  assert.equal(joiner.getState().errorDetail, "the hosting computer closed the session");
  assert.equal(joiner.getState().roomClosed, true, "the host's room closes with the session");
  await joiner.leave();
  assert.equal(joiner.getState().roomClosed, false);
  await host.leave();
});

test("a full session refuses the next computer truthfully", async () => {
  const { api } = fakeSignalling();
  const hostMachine = fakeMachine();
  hostMachine.attached = SESSION_MEMBER_CAP - 1;
  const host = controller(hostMachine, api);
  await host.create("Full");
  await until(() => host.getState().snapshot?.members.length === SESSION_MEMBER_CAP, "the full snapshot");
  const { room, name } = sessionInvitation(host.getState().link!)!;
  const joiner = controller(fakeMachine(), api);
  await joiner.join(room, name);
  assert.equal(joiner.getState().phase, "error");
  assert.match(joiner.getState().error!, /session is full/);
  assert.equal(joiner.getState().roomClosed, false, "a full room may have space later");
  await host.leave();
});

test("joining a room that does not exist fails without touching the machine", async () => {
  const { api } = fakeSignalling();
  const machine = fakeMachine();
  const joiner = controller(machine, api);
  await joiner.join("abcdefghijklmnopqrstuvwxyz", "Gone");
  assert.equal(joiner.getState().phase, "error");
  assert.match(joiner.getState().error!, /no such room/);
  assert.equal(joiner.getState().roomClosed, true, "a missing room's invitation is spent");
  assert.equal(machine.joined, 0);
});

test("no machine means no session", async () => {
  const { api } = fakeSignalling();
  const host = controller(null, api);
  await host.create("Nothing");
  assert.equal(host.getState().phase, "error");
  assert.match(host.getState().error!, /Start a computer/);
});

test("joining pairs a sharing link with the host, named as the network names each end", async () => {
  const { api } = fakeSignalling();
  const sharing = fakeSharing();
  const host = controller(fakeMachine(), api, new Map(), sharing);
  await host.create("Pair");
  const { room, name } = sessionInvitation(host.getState().link!)!;
  const joiner = controller(fakeMachine(), api, new Map(), sharing);
  await joiner.join(room, name);
  assert.equal(joiner.getState().phase, "connected", joiner.getState().error ?? "");
  assert.deepEqual(joiner.getState().partners.map((partner) => partner.name), ["host"]);
  await until(() => host.getState().partners.length === 1, "the host's partner");
  assert.equal(host.getState().partners[0]!.name, "peer-1");
  assert.equal(host.getState().partners[0]!.link, joiner.getState().partners[0]!.link);
  await joiner.leave();
  await until(() => host.getState().partners.length === 0, "the host to drop the partner that left");
  await host.leave();
});

test("a machine switch detaches the network and keeps the session and its partner", async () => {
  const { api } = fakeSignalling();
  const sharing = fakeSharing();
  const host = controller(fakeMachine(), api, new Map(), sharing);
  await host.create("Switch");
  const { room, name } = sessionInvitation(host.getState().link!)!;
  const joinerMachine = fakeMachine();
  const joiner = controller(joinerMachine, api, new Map(), sharing);
  await joiner.join(room, name);
  await until(() => host.getState().partners.length === 1, "the host's partner");

  await joiner.machineChanged();
  assert.equal(joiner.getState().phase, "connected");
  assert.equal(joiner.getState().networkAttached, false);
  assert.equal(joiner.getState().partners.length, 1);
  // The machine that replaced it reports no session of its own; with the
  // network detached, that is not the session ending.
  joinerMachine.state = "offline";
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(joiner.getState().phase, "connected");
  await joiner.leave();
  await host.leave();
});

test("a joiner whose host left and whose network is gone has no session left", async () => {
  const { api } = fakeSignalling();
  const sharing = fakeSharing();
  const host = controller(fakeMachine(), api, new Map(), sharing);
  await host.create("Gone");
  const { room, name } = sessionInvitation(host.getState().link!)!;
  const joiner = controller(fakeMachine(), api, new Map(), sharing);
  await joiner.join(room, name);
  await joiner.machineChanged();
  await host.leave();
  await until(() => joiner.getState().phase === "error", "the joiner to notice");
  assert.match(joiner.getState().error!, /The host left, or the link between you failed/);
  assert.equal(joiner.getState().roomClosed, true);
});

test("a closed sharing link leaves the session, and the joiner connects it again", async () => {
  const { api } = fakeSignalling();
  const sharing = fakeSharing();
  const host = controller(fakeMachine(), api, new Map(), sharing);
  await host.create("Again");
  const { room, name } = sessionInvitation(host.getState().link!)!;
  const joiner = controller(fakeMachine(), api, new Map(), sharing);
  await joiner.join(room, name);
  await joiner.machineChanged();
  await until(() => host.getState().partners.length === 1, "the host's partner");
  const first = host.getState().partners[0]!;
  host.disconnectPartner(first.id);
  await until(() => joiner.getState().partners.length === 0, "the joiner to lose its partner");
  // The room is still open, so only the sharing link went.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(joiner.getState().phase, "connected");

  await joiner.reconnectSharing();
  assert.equal(joiner.getState().partners.length, 1);
  await until(() => host.getState().partners.length === 1, "the host's new partner");
  const second = host.getState().partners[0]!;
  assert.notEqual(second.id, first.id, "a reconnect never reuses a join token");
  assert.equal(second.name, "peer-1");
  await joiner.leave();
  await host.leave();
});

test("a host with no partner leaves the session when its machine changes", async () => {
  const { api, rooms } = fakeSignalling();
  const host = controller(fakeMachine(), api, new Map(), fakeSharing());
  await host.create("Alone");
  const { room } = sessionInvitation(host.getState().link!)!;
  await host.machineChanged();
  await until(() => host.getState().phase === "offline", "the host to leave");
  assert.equal(rooms.has(room), false);
});

test("a sharing link that fails leaves the session connected and says why", async () => {
  const { api } = fakeSignalling();
  const host = controller(fakeMachine(), api, new Map(), fakeSharing());
  await host.create("No sharing");
  const { room, name } = sessionInvitation(host.getState().link!)!;
  const joiner = controller(fakeMachine(), api, new Map(), fakeSharing({ failInvite: "no route" }));
  await joiner.join(room, name);
  assert.equal(joiner.getState().phase, "connected");
  assert.equal(joiner.getState().partners.length, 0);
  assert.equal(joiner.getState().sharingError, "no route");
  await joiner.leave();
  await host.leave();
});
