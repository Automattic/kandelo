import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const moduleUrl = "/@fs" + fileURLToPath(new URL(
  "../../../web-libs/kandelo-session/src/peer-connection.ts", import.meta.url,
));

test("generic peer connections separate purposes and carry unordered raw datagrams", async ({ browser, baseURL, browserName }) => {
  test.skip(browserName !== "chromium", "this two-context loopback ICE proof uses Chromium's local-IP test flag");
  const contexts = await Promise.all([
    browser.newContext({ permissions: ["microphone"] }),
    browser.newContext({ permissions: ["microphone"] }),
  ]);
  try {
    const pages = await Promise.all(contexts.map(async (context) => {
      await context.route("**/__peer_connection_test", (route) => route.fulfill({
        contentType: "text/html", body: "<!doctype html><title>Generic peer connection test</title>",
      }));
      const page = await context.newPage();
      await page.goto(`${baseURL}/__peer_connection_test`);
      return page;
    }));
    const [host, guest] = pages;
    const code = await host.evaluate(async (url) => {
      const peer = await import(url);
      const declaration = { purpose: "network", iceServers: [], channels: [
        { label: "udp", options: { ordered: false, maxRetransmits: 0 } },
      ] };
      const invite = await peer.createPeerConnectionInvite(declaration);
      Object.assign(window, { peer, declaration, invite, received: [] });
      return invite.invite;
    }, moduleUrl);
    const response = await guest.evaluate(async ({ url, code }) => {
      const peer = await import(url);
      const declaration = { purpose: "network", iceServers: [], channels: [
        { label: "udp", options: { ordered: false, maxRetransmits: 0 } },
      ] };
      let refused = "";
      try { await peer.answerPeerConnectionInvite(code, { ...declaration, purpose: "migration" }); }
      catch (error) { refused = (error as Error).message; }
      const answer = await peer.answerPeerConnectionInvite(code, declaration);
      Object.assign(window, { answer, received: [] });
      const ready = answer.connected.then((link: any) => {
        Object.assign(window, { link });
        link.channels.get("udp").addEventListener("message", (event: MessageEvent) => {
          (window as any).received.push(Array.from(new Uint8Array(event.data)));
        });
      });
      Object.assign(window, { ready });
      return { answer: answer.answer, refused };
    }, { url: moduleUrl, code });
    expect(response.refused).toContain("for network, expected migration");
    await host.evaluate(async (answer) => {
      const link = await (window as any).invite.acceptAnswer(answer);
      Object.assign(window, { link });
      link.channels.get("udp").addEventListener("message", (event: MessageEvent) => {
        (window as any).received.push(Array.from(new Uint8Array(event.data)));
      });
    }, response.answer);
    await guest.evaluate(() => (window as any).ready);
    for (const page of pages) {
      expect(await page.evaluate(() => {
        const link = (window as any).link;
        const channel = link.channels.get("udp");
        return { ordered: channel.ordered, maxRetransmits: channel.maxRetransmits, chunked: link.messages.size };
      })).toEqual({ ordered: false, maxRetransmits: 0, chunked: 0 });
    }
    await host.evaluate(() => (window as any).link.channels.get("udp").send(new Uint8Array([1, 2, 3])));
    await expect.poll(() => guest.evaluate(() => (window as any).received)).toEqual([[1, 2, 3]]);
    await guest.evaluate(() => (window as any).link.channels.get("udp").send(new Uint8Array([4, 5, 6])));
    await expect.poll(() => host.evaluate(() => (window as any).received)).toEqual([[4, 5, 6]]);
    await guest.evaluate(() => {
      (window as any).link.onClose(() => { (window as any).peerClosed = true; });
    });
    await host.evaluate(() => {
      (window as any).link.onClose(() => { (window as any).peerClosed = true; });
      (window as any).link.close();
    });
    expect(await host.evaluate(() => (window as any).peerClosed)).toBe(true);
    await expect.poll(() => guest.evaluate(() => (window as any).peerClosed), { timeout: 30_000 }).toBe(true);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
