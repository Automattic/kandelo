import assert from "node:assert/strict";
import test from "node:test";

import type { RemoteSessionSnapshot } from "../../../host/src/networking/remote-segment-runtime.ts";
import type { PeerConnection } from "../../../web-libs/kandelo-session/src/peer-connection.ts";
import * as realSignalling from "./peer-signalling.ts";
import {
  NetworkSessionController, SESSION_MEMBER_CAP, sessionInvitation, sessionLink,
  type SessionMachine, type SessionSignalling, type SessionTransport,
} from "./network-session.ts";

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
      if (!entry) throw new Error("no such room");
      return { room, name: entry.name };
    },
    async postRoomJoin(_server, room, join, offer) {
      const entry = rooms.get(room);
      if (!entry) throw new Error("no such room");
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

function controller(machine: SessionMachine | null, api: SessionSignalling, pairs = new Map<string, PeerConnection>()) {
  return new NetworkSessionController({
    machine: () => machine, server: () => SERVER, transport: fakeTransport(pairs),
    pageHref: () => "https://kandelo.test/app/?vfs=https://evil.test/x.vfs#boot", api,
    hostPollMs: 5, snapshotPollMs: 5,
  });
}

test("a shared link names only the room and session, never the page's boot recipe", () => {
  const link = sessionLink("https://kandelo.test/app/?vfs=https://evil.test/x.vfs#boot", "abcdefghijklmnopqrstuvwxyz", "LAN party");
  assert.equal(link, "https://kandelo.test/app/?network=abcdefghijklmnopqrstuvwxyz&networkName=LAN+party");
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
  assert.match(joiner.getState().error!, /hosting computer closed/);
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
  await host.leave();
});

test("joining a room that does not exist fails without touching the machine", async () => {
  const { api } = fakeSignalling();
  const machine = fakeMachine();
  const joiner = controller(machine, api);
  await joiner.join("abcdefghijklmnopqrstuvwxyz", "Gone");
  assert.equal(joiner.getState().phase, "error");
  assert.match(joiner.getState().error!, /no such room/);
  assert.equal(machine.joined, 0);
});

test("no machine means no session", async () => {
  const { api } = fakeSignalling();
  const host = controller(null, api);
  await host.create("Nothing");
  assert.equal(host.getState().phase, "error");
  assert.match(host.getState().error!, /Start a computer/);
});
