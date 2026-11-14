/**
 * basuctl calls org.freedesktop.Notifications.Notify with the typed
 * arguments Omarchy's omarchy-notification-send passes to busctl: the
 * susssasa{sv}i signature, a byte urgency hint and a string hint. mako owns
 * the name on a dbus-daemon session bus under wlcompositor, replies with
 * the assigned id, lists it with the decoded urgency through makoctl, and
 * maps it as a layer-shell surface.
 *
 * Requires the normal basuctl, mako, dbus, wayland-demo and dash package
 * artifacts. A missing artifact is a provisioning failure, not passing or
 * skipped coverage.
 */
import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { resolveBinary } from "../../../../host/src/binary-resolver";
import { makeHostScratchTempRoot } from "../../../../host/test/centralized-test-helper";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const INCONSOLATA = join(REPO_ROOT, "third_party/Inconsolata-Regular.ttf");

const basuctl = resolveBinary("programs/basuctl.wasm");
const compositor = resolveBinary("programs/wayland-demo/wlcompositor.wasm");
const dash = resolveBinary("programs/dash.wasm");
const daemon = resolveBinary("programs/dbus/dbus-daemon.wasm");
const mako = resolveBinary("programs/mako/mako.wasm");
const makoctl = resolveBinary("programs/mako/makoctl.wasm");

const BUS_SOCKET = `/tmp/dbus-basuctl-${process.pid}.socket`;

const SESSION_CONF = `<busconfig>
  <type>session</type>
  <listen>unix:path=${BUS_SOCKET}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>`;

const NOTIFY = [
  basuctl, "--user", "--", "call",
  "org.freedesktop.Notifications", "/org/freedesktop/Notifications",
  "org.freedesktop.Notifications", "Notify", "'susssasa{sv}i'",
  "omarchy-action", "0", "''", "foo", "'-bar'",
  "0",
  "2", "urgency", "y", "2", "omarchy-glyph", "s", "baz",
  "-1",
].join(" ");

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function waitFor(ref: { value: string }, needle: string, timeoutMs: number, context: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ref.value.includes(needle)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for "${needle}".\n${context()}`);
}

describe("basuctl — busctl calls on the Kandelo session bus", () => {
  it(
    "sends Omarchy's typed Notify call, and mako lists and maps the notification",
    async () => {
      const root = makeHostScratchTempRoot("kandelo-basuctl-");
      const fontDir = join(root, "fonts");
      mkdirSync(fontDir);
      copyFileSync(INCONSOLATA, join(fontDir, "Inconsolata-Regular.ttf"));
      const fontConfig = join(root, "fonts.conf");
      writeFileSync(fontConfig, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <alias>
    <family>monospace</family>
    <prefer><family>Inconsolata</family></prefer>
  </alias>
</fontconfig>
`);
      const toastSeen = join(root, "toast-seen");

      const script = [
        `printf '%s\\n' '${SESSION_CONF}' > /tmp/basuctl-session.conf`,
        `${daemon} --config-file=/tmp/basuctl-session.conf --nofork &`,
        `daemon_pid=$!`,
        `i=0`,
        `while [ ! -S ${BUS_SOCKET} ] && [ $i -lt 20000 ]; do i=$((i+1)); done`,
        `export DBUS_SESSION_BUS_ADDRESS=unix:path=${BUS_SOCKET}`,
        `${mako} &`,
        `mako_pid=$!`,
        `tries=0`,
        `until reply=$(${NOTIFY} 2>/tmp/basuctl.err); do`,
        `  tries=$((tries+1))`,
        `  [ $tries -ge 60 ] && break`,
        `  j=0; while [ $j -lt 20000 ]; do j=$((j+1)); done`,
        `done`,
        `[ $tries -ge 60 ] && while read l; do echo "basuctl.err: $l"; done < /tmp/basuctl.err`,
        `echo "REPLY=$reply"`,
        `${makoctl} list`,
        `while [ ! -e ${toastSeen} ]; do :; done`,
        `kill $mako_pid`,
        `wait $mako_pid`,
        `kill $daemon_pid`,
        `exit 0`,
      ].join("\n");

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();
        host.setInputCanvasDims(1920, 1080);
        host.spawn(loadBytes(compositor), ["wlcompositor"]);
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        const dashExit = host.spawn(loadBytes(dash), ["dash", "-c", script], {
          env: ["PATH=/bin", "HOME=/root", "XDG_RUNTIME_DIR=/tmp", `FONTCONFIG_FILE=${fontConfig}`],
        });

        await waitFor(out, "REPLY=", 60_000, dump);
        await waitFor(out, "  Urgency: ", 20_000, dump);
        expect(out.value, dump()).toContain("REPLY=u 1\n");
        expect(out.value, dump()).toContain("Notification 1: foo\n  App name: omarchy-action\n  Urgency: critical\n");

        await waitFor(out, "LAYER ns=notifications", 20_000, dump);
        writeFileSync(toastSeen, "");

        const dashCode = await Promise.race([
          dashExit,
          new Promise<number>((_, reject) => setTimeout(() => reject(new Error(`dash timed out.\n${dump()}`)), 30_000)),
        ]);
        expect(dashCode, dump()).toBe(0);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    180_000,
  );
});
