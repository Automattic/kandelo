/**
 * PR24 gate, notification side: unmodified upstream mako 1.10.0 (two
 * declared patches — gbm prime-fd pool buffers and a parse_boolean
 * rename against basu, see packages/registry/mako/patches/) runs as a
 * layer-shell client under wlcompositor while owning
 * org.freedesktop.Notifications on the PR22 dbus-daemon session bus.
 *
 * The flow, and what each step proves:
 *
 *   - mako connects via stock wl_display_connect() (XDG_RUNTIME_DIR=/tmp
 *     → /tmp/wayland-0), binds wl_output v4 + layer-shell, and opens the
 *     session bus through basu's sd-bus (EXTERNAL auth, SO_PEERCRED);
 *   - glib_gdbus_smoke --notify sends a full-signature Notify
 *     (susssasa{sv}i) and mako replies with the assigned id — gdbus
 *     client and sd-bus server interoperate over the daemon;
 *   - mako maps its notification as a wlr-layer-shell surface (the
 *     compositor's LAYER ns=notifications marker) and renders it with
 *     pango/cairo through the patched gbm pool path;
 *   - makoctl dismiss round-trips mako's private fr.emersion.Mako
 *     interface, and mako exits clean on SIGTERM (signalfd path).
 *
 * The orchestrating shell must be dash: exec targets resolved via
 * onResolveExec are visible to exec() but not to PATH-search stat calls,
 * so the script invokes them by absolute path. Skips if any binary is
 * missing (bare checkout — mako comes from the package cache).
 */
import { describe, expect, it } from "vitest";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const INCONSOLATA = join(
  REPO_ROOT,
  "examples/libs/wpkdraw/third_party/Inconsolata-Regular.ttf",
);

const compositorBin = tryResolveBinary("programs/wlcompositor.wasm");
const dashBin = tryResolveBinary("programs/dash.wasm");
const daemonBin = tryResolveBinary("programs/dbus/dbus-daemon.wasm");
const makoBin = tryResolveBinary("programs/mako/mako.wasm");
const makoctlBin = tryResolveBinary("programs/mako/makoctl.wasm");
const notifyBin = tryResolveBinary("programs/glib_gdbus_smoke.wasm");
const hasBinaries =
  !!compositorBin && !!dashBin && !!daemonBin && !!makoBin && !!makoctlBin &&
  !!notifyBin && existsSync(dashBin!);

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// Unique per run: the kernel's /tmp is host-backed and persists across
// hosts, so a failed run's leftover socket node would EADDRINUSE the
// next daemon.
const BUS_SOCKET = `/tmp/dbus-mako-${process.pid}.socket`;

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

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function waitFor(
  ref: { value: string },
  needle: string,
  timeoutMs: number,
  context: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ref.value.includes(needle)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for "${needle}".\n${context()}`);
}

describe("mako — upstream notification daemon on wlcompositor + dbus", () => {
  it.skipIf(!hasBinaries)(
    "owns org.freedesktop.Notifications, maps a layer-shell notification, answers makoctl",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const dashBytes = loadBytes(dashBin!);
      const daemonBytes = loadBytes(daemonBin!);
      const makoBytes = loadBytes(makoBin!);
      const makoctlBytes = loadBytes(makoctlBin!);
      const notifyBytes = loadBytes(notifyBin!);

      const root = mkdtempSync(join(tmpdir(), "kandelo-mako-"));
      const fontDir = join(root, "fonts");
      mkdirSync(fontDir);
      copyFileSync(INCONSOLATA, join(fontDir, "Inconsolata-Regular.ttf"));
      const confPath = join(root, "fonts.conf");
      writeFileSync(
        confPath,
        `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <alias>
    <family>monospace</family>
    <prefer><family>Inconsolata</family></prefer>
  </alias>
</fontconfig>
`,
      );

      const script = [
        `printf '%s\\n' '${SESSION_CONF}' > /tmp/mako-session.conf`,
        `/bin/dbus-daemon --config-file=/tmp/mako-session.conf --nofork &`,
        `daemon_pid=$!`,
        `i=0`,
        `while [ ! -S ${BUS_SOCKET} ] && [ $i -lt 20000 ]; do i=$((i+1)); done`,
        `export DBUS_SESSION_BUS_ADDRESS=unix:path=${BUS_SOCKET}`,
        `/bin/mako &`,
        `mako_pid=$!`,
        // Retry until mako owns the name; the first success IS the
        // gate's notification.
        `tries=0`,
        `until /bin/glib_gdbus_smoke --notify 2>/tmp/notify.err; do`,
        `  tries=$((tries+1))`,
        `  [ $tries -ge 60 ] && break`,
        `  j=0; while [ $j -lt 20000 ]; do j=$((j+1)); done`,
        `done`,
        `[ $tries -ge 60 ] && while read l; do echo "notify.err: $l"; done < /tmp/notify.err`,
        `/bin/makoctl dismiss --all && echo MAKOCTL_OK`,
        `kill $mako_pid`,
        `wait $mako_pid`,
        `echo MAKO_EXIT=$?`,
        `kill $daemon_pid`,
        `exit 0`,
      ].join("\n");

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
        onResolveExec: (path) => {
          if (path.endsWith("/dbus-daemon")) return daemonBytes;
          if (path.endsWith("/mako")) return makoBytes;
          if (path.endsWith("/makoctl")) return makoctlBytes;
          if (path.endsWith("/glib_gdbus_smoke")) return notifyBytes;
          return null;
        },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        const compExit = host.spawn(compositorBytes, ["wlcompositor"], {});
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        const dashExit = host.spawn(dashBytes, ["dash", "-c", script], {
          env: [
            "PATH=/bin",
            "HOME=/root",
            "XDG_RUNTIME_DIR=/tmp",
            `FONTCONFIG_FILE=${confPath}`,
          ],
        });

        // mako connected to the compositor and the bus, the Notify round
        // trip resolved with the first assigned id.
        await waitFor(out, "NOTIFY_ID id=1", 60_000, dump);

        // The notification mapped as a wlr-layer-shell surface and the
        // compositor anchored + configured it.
        await waitFor(out, "LAYER ns=notifications", 20_000, dump);
        const layer = out.value.match(/LAYER ns=notifications layer=\d+ x=\d+ y=\d+ w=(\d+) h=(\d+)/);
        expect(layer, `no layer geometry.\n${dump()}`).not.toBeNull();
        expect(parseInt(layer![1], 10)).toBeGreaterThan(0);
        expect(parseInt(layer![2], 10)).toBeGreaterThan(0);

        // makoctl spoke fr.emersion.Mako over the same bus.
        await waitFor(out, "MAKOCTL_OK", 30_000, dump);

        // mako exits clean on SIGTERM (signalfd), then the orchestration.
        await waitFor(out, "MAKO_EXIT=0", 30_000, dump);
        const dashCode = await Promise.race([
          dashExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`dash timed out.\n${dump()}`)), 30_000)),
        ]);
        expect(dashCode, `dash exit.\n${dump()}`).toBe(0);

        // mako was the compositor's only client; its exit ends the session.
        const compCode = await Promise.race([
          compExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`compositor timed out.\n${dump()}`)), 10_000)),
        ]);
        expect(compCode, `compositor exit.\n${dump()}`).toBe(0);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    180_000,
  );
});
