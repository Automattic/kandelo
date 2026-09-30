/*
 * PR22 gate, daemon side: the dbus port (packages/registry/dbus/) —
 * dbus-daemon serves a session bus under the kernel and dbus-send
 * round-trips a method call over EXTERNAL auth (SO_PEERCRED).
 *
 * The orchestrating shell must be dash (programs/dash.wasm): exec
 * targets staged via execPrograms are visible to exec() but not to
 * PATH search stat calls, so the script invokes them by absolute path.
 */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const dashWasm = tryResolveBinary("programs/dash.wasm");
const daemonWasm = tryResolveBinary("programs/dbus/dbus-daemon.wasm");
const sendWasm = tryResolveBinary("programs/dbus/dbus-send.wasm");
const monitorWasm = tryResolveBinary("programs/dbus/dbus-monitor.wasm");
const gdbusWasm = tryResolveBinary("programs/glib_gdbus_smoke.wasm");
const haveAll = dashWasm && daemonWasm && sendWasm;
const haveGdbus = dashWasm && daemonWasm && monitorWasm && gdbusWasm;

const SESSION_CONF = `<busconfig>
  <type>session</type>
  <listen>unix:path=/tmp/dbus-test-socket</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>`;

describe("dbus port — session daemon", () => {
  it.skipIf(!daemonWasm)(
    "reports its version",
    async () => {
      const result = await runCentralizedProgram({
        programPath: daemonWasm!,
        argv: ["dbus-daemon", "--version"],
        env: [],
        timeout: 30_000,
      });

      expect(
        result.exitCode,
        `dbus-daemon exited non-zero. stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain("1.14.10");
    },
    60_000,
  );

  it.skipIf(!haveAll)(
    "serves a session bus that answers dbus-send",
    async () => {
      const script = [
        `printf '%s\\n' '${SESSION_CONF}' > /tmp/test-session.conf`,
        `/bin/dbus-daemon --config-file=/tmp/test-session.conf --nofork &`,
        `daemon_pid=$!`,
        `i=0`,
        `while [ ! -S /tmp/dbus-test-socket ] && [ $i -lt 20000 ]; do i=$((i+1)); done`,
        `DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-test-socket \\`,
        `  /bin/dbus-send --session --print-reply --dest=org.freedesktop.DBus \\`,
        `  /org/freedesktop/DBus org.freedesktop.DBus.GetId`,
        `rc=$?`,
        `kill $daemon_pid`,
        `exit $rc`,
      ].join("\n");

      const result = await runCentralizedProgram({
        programPath: dashWasm!,
        argv: ["dash", "-c", script],
        env: ["PATH=/bin"],
        timeout: 60_000,
        execPrograms: new Map([
          ["/bin/dbus-daemon", daemonWasm!],
          ["/bin/dbus-send", sendWasm!],
        ]),
      });

      expect(
        result.exitCode,
        `bus round trip failed. stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      expect(
        result.stdout,
        `empty reply. stdout=${result.stdout} stderr=${result.stderr}`,
      ).toContain("string");
    },
    90_000,
  );

  it.skipIf(!haveGdbus)(
    "gdbus ping + notify-send-shaped round trip with dbus-monitor eavesdrop",
    async () => {
      const script = [
        `printf '%s\\n' '${SESSION_CONF}' > /tmp/test-session.conf`,
        `rm -f /tmp/gdbus-server-ready`,
        `/bin/dbus-daemon --config-file=/tmp/test-session.conf --nofork &`,
        `daemon_pid=$!`,
        `i=0`,
        `while [ ! -S /tmp/dbus-test-socket ] && [ $i -lt 20000 ]; do i=$((i+1)); done`,
        `export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-test-socket`,
        `/bin/dbus-monitor --session > /tmp/monitor.log 2>/dev/null &`,
        `monitor_pid=$!`,
        `/bin/glib_gdbus_smoke --server &`,
        `server_pid=$!`,
        `i=0`,
        `while [ ! -f /tmp/gdbus-server-ready ] && [ $i -lt 20000 ]; do i=$((i+1)); done`,
        `/bin/glib_gdbus_smoke --client`,
        `client_rc=$?`,
        `wait $server_pid`,
        `server_rc=$?`,
        `kill $monitor_pid`,
        `grep -q "quux summary" /tmp/monitor.log && echo MONITOR_SAW_NOTIFY`,
        `kill $daemon_pid`,
        `[ $client_rc -eq 0 ] && [ $server_rc -eq 0 ] && echo ALL_OK`,
        `exit 0`,
      ].join("\n");

      const result = await runCentralizedProgram({
        programPath: dashWasm!,
        argv: ["dash", "-c", script],
        env: ["PATH=/bin"],
        timeout: 90_000,
        execPrograms: new Map([
          ["/bin/dbus-daemon", daemonWasm!],
          ["/bin/dbus-monitor", monitorWasm!],
          ["/bin/glib_gdbus_smoke", gdbusWasm!],
        ]),
      });

      const dump = `stdout=${result.stdout} stderr=${result.stderr}`;
      expect(result.stdout, dump).toContain("PING_OK");
      expect(result.stdout, dump).toContain("NOTIFY_OK");
      expect(result.stdout, dump).toContain("SERVER_DONE");
      expect(result.stdout, dump).toContain("MONITOR_SAW_NOTIFY");
      expect(result.stdout, dump).toContain("ALL_OK");
    },
    120_000,
  );
});
