import { expect, test } from "vitest";
import { assertPersistentImageBootMetadata } from "../../apps/browser-demos/pages/kandelo/kernel-host/persistent-image-checkpoint";
import { KANDELO_DEMO_CONFIG_PATH, MAX_KANDELO_DEMO_CONFIG_BYTES, parseKandeloDemoConfig } from "../../web-libs/kandelo-session/src/demo-config";
import { EXPERIMENTAL_TERMINAL_SESSION_PATH, MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES, parseExperimentalTerminalSession } from "../../web-libs/kandelo-session/src/experimental-terminal-session";
import { MAX_DINIT_SERVICE_FILE_BYTES } from "../../web-libs/kandelo-session/src/dinit-boot-targets";

function fixture(oversized?: string, missing?: string) {
  const imageConfig = parseKandeloDemoConfig(JSON.stringify({ version: 1, defaultProfile: "probe",
    profiles: { probe: { init: { target: "boot" } } } }))!;
  const terminalSession = parseExperimentalTerminalSession(JSON.stringify({
    kind: "kandelo-experimental-terminal-session", version: 1,
    initial: { path: "/bin/true", argv: ["true"], uid: 0, gid: 0 },
  }));
  const files = new Map([
    [KANDELO_DEMO_CONFIG_PATH, JSON.stringify(imageConfig)],
    [EXPERIMENTAL_TERMINAL_SESSION_PATH, JSON.stringify(terminalSession)],
    ["/etc/dinit.d/boot", "depends-on = database\n"],
    ["/etc/dinit.d/database", "type = process\ncommand = /bin/true\n"],
  ]);
  const reads: { path: string; offset: number; length: number }[] = [];
  const kernel = {
    async readFileFromVfs(): Promise<never> { throw new Error("Whole metadata reads are forbidden"); },
    async readFileRangeFromVfs(path: string, offset: number, length: number) {
      reads.push({ path, offset, length });
      if (path === missing) return null;
      if (path === oversized) return new Uint8Array(length).fill(32);
      const text = files.get(path);
      return text === undefined ? null : new TextEncoder().encode(text).slice(offset, offset + length);
    },
  };
  return { kernel, reads, files, composition: { imageConfig, profileId: "probe", terminalSession,
    requiredServices: ["boot", "database"] } };
}

test("persistent boot validation reads only bounded metadata ranges", async () => {
  const subject = fixture();
  await assertPersistentImageBootMetadata(subject.kernel, subject.composition);
  expect(subject.reads).toEqual([
    { path: KANDELO_DEMO_CONFIG_PATH, offset: 0, length: MAX_KANDELO_DEMO_CONFIG_BYTES + 1 },
    { path: EXPERIMENTAL_TERMINAL_SESSION_PATH, offset: 0, length: MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES + 1 },
    { path: "/etc/dinit.d/boot", offset: 0, length: MAX_DINIT_SERVICE_FILE_BYTES + 1 },
    { path: "/etc/dinit.d/database", offset: 0, length: MAX_DINIT_SERVICE_FILE_BYTES + 1 },
  ]);
});

test("persistent boot validation accepts files exactly at each metadata limit", async () => {
  const subject = fixture();
  for (const [path, limit] of [[KANDELO_DEMO_CONFIG_PATH, MAX_KANDELO_DEMO_CONFIG_BYTES],
    [EXPERIMENTAL_TERMINAL_SESSION_PATH, MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES],
    ["/etc/dinit.d/boot", MAX_DINIT_SERVICE_FILE_BYTES]] as const) {
    subject.files.set(path, subject.files.get(path)!.padEnd(limit, " "));
  }
  await assertPersistentImageBootMetadata(subject.kernel, subject.composition);
});

for (const path of [KANDELO_DEMO_CONFIG_PATH, EXPERIMENTAL_TERMINAL_SESSION_PATH, "/etc/dinit.d/boot"]) {
  test(`persistent boot validation refuses oversized ${path} before decoding`, async () => {
    const subject = fixture(path);
    await expect(assertPersistentImageBootMetadata(subject.kernel, subject.composition)).rejects.toThrow(
      path === KANDELO_DEMO_CONFIG_PATH ? "boot configuration changed" :
        path === EXPERIMENTAL_TERMINAL_SESSION_PATH ? "terminal session changed" : "exceeds");
    expect(subject.reads.at(-1)?.path).toBe(path);
  });

  test(`persistent boot validation preserves missing-file refusal for ${path}`, async () => {
    const subject = fixture(undefined, path);
    await expect(assertPersistentImageBootMetadata(subject.kernel, subject.composition)).rejects.toThrow();
    expect(subject.reads.at(-1)?.path).toBe(path);
  });
}

test("persistent boot validation still rejects changed configuration, session and service closure", async () => {
  for (const path of [KANDELO_DEMO_CONFIG_PATH, EXPERIMENTAL_TERMINAL_SESSION_PATH, "/etc/dinit.d/boot"]) {
    const subject = fixture();
    subject.files.set(path, path === "/etc/dinit.d/boot" ? "type = process\n" : "{}");
    await expect(assertPersistentImageBootMetadata(subject.kernel, subject.composition)).rejects.toThrow();
  }
});
