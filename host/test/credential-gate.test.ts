import { afterEach, describe, expect, it } from "vitest";
import {
  CREDENTIAL_GATE_CHANNEL,
  CredentialGateResponder,
  credentialTokenHash,
  type CredentialGateMessage,
} from "../src/credential-gate";
import { CredentialGrants } from "../src/credential-grants";

// The kernel worker's half of the browser app's service-worker credential
// gate. The service worker half is proven in real browsers by
// apps/browser-demos/test/credential-gate.spec.ts.

class FakeChannel {
  readonly posted: CredentialGateMessage[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  postMessage(message: CredentialGateMessage): void {
    this.posted.push(message);
  }
  close(): void {
    this.closed = true;
  }
  deliver(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

function fakeKernel() {
  const table = new Map<number, number>();
  return {
    table,
    setCredentialGrant(pid: number, grant: number): boolean {
      table.set(pid, grant);
      return true;
    },
    getCredentialGrant(pid: number): number | null {
      return table.get(pid) ?? null;
    },
  };
}

const ORIGIN = "https://kandelo.test";
const REPLY_URL = `${ORIGIN}/__kandelo_credential_grant_reply`;
const DESTINATION = "https://chatgpt.com";

function setup() {
  const kernel = fakeKernel();
  const channel = new FakeChannel();
  const replies: Array<{ url: string; body: unknown }> = [];
  let responder!: CredentialGateResponder;
  const grants = new CredentialGrants(kernel, {
    onGrantEnded: (grant) => responder.grantEnded(grant.token),
  });
  responder = new CredentialGateResponder({
    grants,
    verify: async (token, origin) => grants.verify(token, origin),
    origin: ORIGIN,
    channel,
    fetch: async (url, init) => {
      replies.push({ url, body: JSON.parse(String(init.body)) });
    },
  });
  return { kernel, channel, replies, grants, responder };
}

async function settled(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

let active: ReturnType<typeof setup> | null = null;
afterEach(() => {
  active?.responder.close();
  active = null;
});

describe("CredentialGateResponder", () => {
  it("hashes tokens as SHA-256, base64url without padding", async () => {
    // printf %s token | openssl dgst -sha256 -binary | basenc --base64url
    expect(await credentialTokenHash("token")).toBe(
      "PEaenWxYddN6Q_NT1PiOYfz4EsZu7jRXRlpAsNpBU-A",
    );
  });

  it("answers a verification for a token it holds, through a same-origin reply fetch", async () => {
    active = setup();
    const grant = active.grants.issue(7, [DESTINATION])!;
    active.channel.deliver({
      type: "credential-grant-verify",
      id: "request-1",
      tokenHash: await credentialTokenHash(grant.token),
      origin: DESTINATION,
      replyUrl: REPLY_URL,
    });
    await settled();
    expect(active.replies).toEqual([{
      url: REPLY_URL,
      body: { type: "credential-grant-verified", id: "request-1", valid: true },
    }]);
  });

  it("answers invalid for an origin the grant does not name, or a grant the kernel ended", async () => {
    active = setup();
    const grant = active.grants.issue(7, [DESTINATION])!;
    const tokenHash = await credentialTokenHash(grant.token);
    active.channel.deliver({
      type: "credential-grant-verify", id: "other-origin", tokenHash,
      origin: "https://example.com", replyUrl: REPLY_URL,
    });
    await settled();
    // The kernel cleared the grant (exec) without the host noticing yet.
    active.kernel.table.set(7, 0);
    active.channel.deliver({
      type: "credential-grant-verify", id: "ended", tokenHash,
      origin: DESTINATION, replyUrl: REPLY_URL,
    });
    await settled();
    expect(active.replies.map(({ body }) => body)).toEqual([
      { type: "credential-grant-verified", id: "other-origin", valid: false },
      { type: "credential-grant-verified", id: "ended", valid: false },
    ]);
  });

  it("stays silent about tokens it does not hold and malformed or cross-origin asks", async () => {
    active = setup();
    const grant = active.grants.issue(7, [DESTINATION])!;
    const tokenHash = await credentialTokenHash(grant.token);
    for (const data of [
      { type: "credential-grant-verify", id: "unknown", tokenHash: await credentialTokenHash("other"),
        origin: DESTINATION, replyUrl: REPLY_URL },
      { type: "credential-grant-verify", id: "elsewhere", tokenHash, origin: DESTINATION,
        replyUrl: "https://attacker.example/reply" },
      { type: "credential-grant-verify", id: 5, tokenHash, origin: DESTINATION, replyUrl: REPLY_URL },
      { type: "credential-grant-verify", id: "no-origin", tokenHash, replyUrl: REPLY_URL },
      "credential-grant-verify",
      null,
    ]) {
      active.channel.deliver(data);
    }
    await settled();
    expect(active.replies).toEqual([]);
  });

  it("announces a verified grant's end by hash, never by token", async () => {
    active = setup();
    const grant = active.grants.issue(7, [DESTINATION])!;
    const tokenHash = await credentialTokenHash(grant.token);
    active.channel.deliver({
      type: "credential-grant-verify", id: "request-1", tokenHash,
      origin: DESTINATION, replyUrl: REPLY_URL,
    });
    await settled();
    active.grants.revoke(7);
    expect(active.channel.posted).toEqual([
      { type: "credential-grant-ended", tokenHash },
    ]);
    expect(JSON.stringify(active.channel.posted)).not.toContain(grant.token);
    // Exit (forget) and teardown (clear) end grants too.
    const second = active.grants.issue(8, [DESTINATION])!;
    const third = active.grants.issue(9, [DESTINATION])!;
    for (const [id, token] of [["second", second.token], ["third", third.token]]) {
      active.channel.deliver({
        type: "credential-grant-verify", id, tokenHash: await credentialTokenHash(token),
        origin: DESTINATION, replyUrl: REPLY_URL,
      });
    }
    await settled();
    active.grants.forget(8);
    active.grants.clear();
    expect(active.channel.posted.slice(1)).toEqual([
      { type: "credential-grant-ended", tokenHash: await credentialTokenHash(second.token) },
      { type: "credential-grant-ended", tokenHash: await credentialTokenHash(third.token) },
    ]);
  });

  it("closes its channel", () => {
    active = setup();
    active.responder.close();
    expect(active.channel.closed).toBe(true);
  });

  it("uses the channel name the service worker listens on", () => {
    expect(CREDENTIAL_GATE_CHANNEL).toBe("kandelo-credential-grants");
  });
});
