import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { installServiceActivities } from "../../images/vfs/scripts/service-activities";
import { writeVfsFile } from "../../images/vfs/scripts/vfs-image-helpers";

const environment = ["HOME=/root", "USER=root", "LOGNAME=root", "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin", "TMPDIR=/tmp"];

async function computer(image: string, initial: string, prepare?: (fs: KandeloImageFs) => void) {
  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(readFileSync(resolveBinary(`programs/${image}-vfs.vfs.zst`))));
  let pool = new TextDecoder().decode(fs.readFile("/etc/php-fpm.conf"));
  pool = pool.replace(/pm\.max_children\s*=\s*\d+/, "pm.max_children = 1");
  writeVfsFile(fs, "/etc/php-fpm.conf", pool);
  prepare?.(fs);
  const imageBytes = await fs.saveImage();
  let logs = "";
  const append = (_pid: number, bytes: Uint8Array) => { logs = (logs + new TextDecoder().decode(bytes)).slice(-262144); };
  const host = new NodeKernelHost({ rootfsImage: imageBytes, maxWorkers: 24, onStdout: append, onStderr: append });
  await host.init();
  const init = await host.spawnFromVfs("/bin/sh", ["sh", "/sbin/kandelo-init", initial], { uid: 0, gid: 0, env: environment });
  void init.exit.catch(() => {});
  const command = async (script: string, uid = 0, expected = 0) => {
    const id = `family-test-${randomUUID()}`;
    const child = await host.spawnFromVfs("/bin/sh", ["sh", "-c", script], { uid, gid: uid, env: environment, ownedJob: { id, timeoutMs: 90000 } });
    const exitCode = await child.exit;
    let result = await host.readOwnedJob(id, 0, 65536);
    await expect.poll(async () => {
      result = await host.readOwnedJob(id, 0, 65536);
      return !result.expired && result.terminationObserved;
    }, { timeout: 10000 }).toBe(true);
    expect(result.expired).toBe(false);
    if (result.expired) throw new Error("Command output expired");
    expect(result.terminationObserved).toBe(true);
    await host.releaseOwnedJob(id);
    const output = result.chunks.map(chunk => new TextDecoder().decode(chunk.bytes)).join("");
    expect(exitCode, `${script}\n${output}\n${logs}`).toBe(expected);
    return output;
  };
  return { host, command, init, logs: () => logs };
}

it.each([false, true])("web-stack-service-switch: switches websites and reports start failures (new target fails: %s)", async targetFails => {
  const machine = await computer("web-stack", "web-php", fs => {
    if (!targetFails) {
      // Hold boot before nginx can bind, so the switch reliably overlaps STARTING.
      writeVfsFile(fs, "/etc/dinit.d/boot-gate", 'type = scripted\ncommand = /bin/sh -c "while [ ! -f /tmp/boot-gate-open ]; do sleep 1; done"\n');
      writeVfsFile(fs, "/etc/dinit.d/web-php", new TextDecoder().decode(fs.readFile("/etc/dinit.d/web-php")) + "\ndepends-on = boot-gate\n");
    }
    if (targetFails) writeVfsFile(fs, "/etc/dinit.d/web-static", "type = process\ncommand = /missing/server\nrestart = false\n");
    const services = JSON.parse(new TextDecoder().decode(fs.readFile("/etc/kandelo/services.json")));
    installServiceActivities(fs, services.services.map((service: { id: string; port: number }) => ({ target: service.id, port: service.port })), fs.readFile("/usr/bin/kandelo-service"));
  });
  try {
    await machine.command("while [ ! -S /run/kandelo-services/dinitctl ]; do sleep 1; done");
    if (targetFails) await machine.command("curl --fail --silent --location --cookie-jar /tmp/recovery-cookies --cookie /tmp/recovery-cookies --retry 30 --retry-connrefused --retry-delay 1 --max-time 3 --output /dev/null http://127.0.0.1:8080/", 1000);
    const before = await machine.command("kandelo-service inspect", 1000);
    expect(before).toMatch(targetFails ? /web-php\s+running\s+enabled/ : /web-php\s+starting\s+enabled/);
    const requested = await machine.command("/sbin/dinitctl -p /run/kandelo-services/dinitctl list");
    const transition = await machine.command(targetFails ? "kandelo-service start web-static" : "(sleep 5; touch /tmp/boot-gate-open) & kandelo-service start web-static; result=$?; wait; exit $result", 1000, targetFails ? 1 : 0);
    const after = await machine.command("kandelo-service inspect", 1000);
    expect(after).toMatch(targetFails ? /web-static\s+failed\s+disabled/ : /web-static\s+running\s+disabled/);
    expect(after, `${requested}\n${transition}`).toMatch(targetFails ? /web-php\s+running\s+enabled/ : /web-php\s+stopped\s+enabled/);
    expect(after.match(/\trunning\t/g)).toHaveLength(1);
    expect(await machine.command("curl --fail --silent --location --cookie-jar /tmp/recovery-cookies --cookie /tmp/recovery-cookies --retry 30 --retry-connrefused --retry-delay 1 --max-time 3 http://127.0.0.1:8080/", 1000)).toContain(targetFails ? "Kandelo SQLite demo" : "Hello from nginx");
  } finally { await machine.host.destroy(); }
}, 120000);

it("web-stack-service-switch: one image switches all five web demos and keeps its supervisor and files", async () => {
  const machine = await computer("web-stack", "web-php");
  try {
    expect(await machine.command("kandelo-preview --help", 1000)).toContain("Usage: kandelo-preview");
    expect(await machine.command("kandelo-preview http://localhost:3000/", 1000, 1)).toContain("standard output must be an attached Kandelo terminal");
    await machine.command("curl --fail --silent --location --cookie-jar /tmp/adminer-cookies --cookie /tmp/adminer-cookies --retry 30 --retry-connrefused --retry-delay 1 --max-time 3 -o /tmp/first-page http://127.0.0.1:8080/ && grep -i 'Kandelo SQLite demo' /tmp/first-page >/dev/null || { cat /tmp/first-page /var/log/php-fpm.log; exit 1; }");
    await machine.command("echo kept >/home/maker/family-note; ps -A | grep '[d]init' | awk '{print $1}' >/tmp/init-before");
    const initialList = await machine.command("kandelo-service list", 1000);
    expect(initialList).toMatch(/ACTIVITY\s+STATE\s+NEXT BOOT/);
    expect(initialList).toMatch(/web-php\s+running\s+enabled/);
    expect(initialList).toMatch(/web-python\s+not-loaded\s+disabled/);
    expect(initialList.trim().split("\n")).toHaveLength(6);
    await machine.command("kandelo-service enable web-python", 1000);
    const enabledList = await machine.command("kandelo-service list", 1000);
    expect(enabledList).toMatch(/web-php\s+running\s+disabled/);
    expect(enabledList).toMatch(/web-python\s+not-loaded\s+enabled/);
    await machine.command("kandelo-service disable web-python", 1000);
    expect(await machine.command("kandelo-service list", 1000)).not.toMatch(/\senabled\b/);
    for (const [target, content] of [["web-static", "Hello from nginx"], ["web-python", "Notes"], ["web-ruby", "Todo"], ["web-redis", "What should we do next"], ["web-php", "Kandelo SQLite demo"]]) {
      await machine.command(`/usr/bin/kandelo-service start ${target}`, 1000);
      const listing = await machine.command("kandelo-service list", 1000);
      expect(listing).toMatch(new RegExp(`${target}\\s+running\\s+disabled`));
      expect(listing.match(/\brunning\b/g)).toHaveLength(1);
      await machine.command(`curl --fail --silent --location --cookie-jar /tmp/adminer-cookies --cookie /tmp/adminer-cookies --max-time 10 -o /tmp/family-page http://127.0.0.1:8080/ && grep -i '${content}' /tmp/family-page >/dev/null && /sbin/dinitctl -p /run/kandelo-services/dinitctl is-started ${target}`);
      await machine.command("test \"$(cat /home/maker/family-note)\" = kept; ps -A | grep '[d]init' | awk '{print $1}' >/tmp/init-after; cmp /tmp/init-before /tmp/init-after");
    }
    await machine.command("/usr/bin/kandelo-service stop web-php", 1000);
    expect(await machine.command("kandelo-service list", 1000)).toMatch(/web-php\s+stopped\s+disabled/);
    await machine.command("! /sbin/dinitctl -p /run/kandelo-services/dinitctl is-started web-php; /sbin/dinitctl -p /run/kandelo-services/dinitctl is-started machine");
    await machine.command("/usr/bin/kandelo-service start web-php", 65534, 1);
    await machine.command("/usr/bin/kandelo-service start ../bad", 1000, 2);
    await machine.command("kandelo-service list", 65534, 1);
    for (const invalid of ["", "list web-php", "list web-php extra", "start", "status", "nonsense web-php"]) {
      await machine.command(`kandelo-service ${invalid}`, 1000, 2);
    }
    await machine.command("mv /run/kandelo-services/dinitctl /run/kandelo-services/dinitctl.hidden");
    try {
      expect(await machine.command("kandelo-service list", 1000, 1)).not.toContain("ACTIVITY");
    } finally {
      await machine.command("mv /run/kandelo-services/dinitctl.hidden /run/kandelo-services/dinitctl");
    }
  } finally { await machine.host.destroy(); }
}, 360000);

it("wordpress-family-service-switch: Caddy and PHP-FPM share the SQLite site and keep uploads private", async () => {
  const machine = await computer("wordpress-family", "frankenphp-caddy");
  try {
    await machine.command("curl --fail --silent --show-error --retry 30 --retry-connrefused --retry-delay 1 --max-time 3 -o /tmp/wordpress-page http://127.0.0.1:8080/ && grep -i wordpress /tmp/wordpress-page >/dev/null");
    await machine.host.writeFileToVfs("/srv/www/html/server-probe.php", new TextEncoder().encode(`<?php
require __DIR__ . '/wp-load.php';
header('Content-Type: application/json');
if (isset($_GET['value'])) update_option('kandelo_server_probe', $_GET['value']);
echo json_encode(array('backend' => defined('DB_DIR') ? 'sqlite' : 'mariadb', 'value' => get_option('kandelo_server_probe', 'unset')));
`), 0o644);
    const probe = async (query = "") => JSON.parse(await machine.command(
      `curl --fail --silent --max-time 30 'http://127.0.0.1:8080/server-probe.php${query}'`));
    expect(await probe("?value=shared-sqlite")).toEqual({ backend: "sqlite", value: "shared-sqlite" });
    await machine.command("printf 'sqlite-upload' > /var/lib/wordpress-sites/sqlite/wp-content/uploads/shared.txt; printf '<?php echo \"must-not-run\"; ?>' > /var/lib/wordpress-sites/sqlite/wp-content/uploads/probe.php");
    for (const target of ["wordpress-sqlite", "frankenphp-caddy", "wordpress-mariadb", "frankenphp-caddy"]) {
      await machine.command(`/usr/bin/kandelo-service start ${target}`, 1000);
      const sqlite = target !== "wordpress-mariadb";
      expect(await probe()).toEqual({ backend: sqlite ? "sqlite" : "mariadb", value: sqlite ? "shared-sqlite" : "unset" });
      if (sqlite) {
        expect(await machine.command("curl --fail --silent --max-time 10 http://127.0.0.1:8080/wp-content/uploads/shared.txt")).toBe("sqlite-upload");
      }
      for (const path of ["/wp-content/uploads", "/wp-content/uploads/", "/wp-content/uploads/probe.php", "/wp-content/db.php", "/wp-content/database/wordpress.db"]) {
        expect(await machine.command(`curl --silent --output /tmp/denied-body --write-out '%{http_code}' --max-time 10 'http://127.0.0.1:8080${path}'`)).toBe("404");
      }
      const state = await machine.command("kandelo-service inspect", 1000);
      expect(state).toMatch(new RegExp(`${target}\\s+running\\s+`));
      expect(state.match(/\trunning\t/g)).toHaveLength(1);
    }
    const bytes = await machine.host.readFileFromVfs("/var/log/frankenphp-caddy.log");
    expect(bytes).toBeTruthy();
    const log = new TextDecoder().decode(bytes!);
    expect(log).toContain('"total_threads":2');
    expect(log).not.toMatch(/^(?:panic:|fatal error:)|PHP Fatal error/m);
  } finally { await machine.host.destroy(); }
}, 240000);

for (const backend of ["sqlite", "mariadb"] as const) {
  it(`wordpress-family-service-switch: ${backend} switches independent sites without copying core files or losing data`, async () => {
    const machine = await computer("wordpress-family", `wordpress-${backend}`);
    try {
      expect(await machine.command("kandelo-preview --help", 1000)).toContain("Usage: kandelo-preview");
      await machine.command("curl --fail --silent --show-error --retry 30 --retry-connrefused --retry-delay 1 --max-time 3 -o /tmp/wordpress-page http://127.0.0.1:8080/ && grep -i wordpress /tmp/wordpress-page >/dev/null || { cat /tmp/wordpress-page /var/log/nginx.log /var/log/php-fpm.log; exit 1; }");
      await machine.host.writeFileToVfs("/srv/www/html/backend-probe.php", new TextEncoder().encode(`<?php
require __DIR__ . '/wp-load.php';
header('Content-Type: application/json');
if (isset($_GET['value'])) update_option('kandelo_site_probe', $_GET['value']);
echo json_encode(array('backend' => defined('DB_DIR') ? 'sqlite' : 'mariadb', 'value' => get_option('kandelo_site_probe', 'unset')));
`), 0o644);
      const listing = await machine.command("kandelo-service list", 1000);
      expect(listing).toMatch(new RegExp(`wordpress-${backend}\\s+running\\s+enabled`));
      const other = backend === "sqlite" ? "mariadb" : "sqlite";
      for (const site of [backend, other]) {
        await machine.command(`/usr/bin/kandelo-service start wordpress-${site}`, 1000);
        const result = JSON.parse(await machine.command(`curl --fail --silent --max-time 30 'http://127.0.0.1:8080/backend-probe.php?value=${site}-private'`));
        expect(result).toEqual({ backend: site, value: `${site}-private` });
        await machine.command(`printf '${site}-upload' > /var/lib/wordpress-sites/${site}/wp-content/uploads/probe.txt`);
        await machine.command(`printf '${site}-pdf' > /var/lib/wordpress-sites/${site}/wp-content/uploads/probe.pdf; printf '<?php echo "must-not-run"; ?>' > /var/lib/wordpress-sites/${site}/wp-content/uploads/probe.php`);
        await machine.command(`printf '<?php echo "must-not-run"; ?>' > /var/lib/wordpress-sites/${site}/wp-content/uploads/index.php`);
      }
      for (const site of [backend, other, backend]) {
        await machine.command(`/usr/bin/kandelo-service start wordpress-${site}`, 1000);
        expect(JSON.parse(await machine.command("curl --fail --silent --max-time 30 http://127.0.0.1:8080/backend-probe.php"))).toEqual({ backend: site, value: `${site}-private` });
        expect(await machine.command("curl --fail --silent --max-time 10 http://127.0.0.1:8080/wp-content/uploads/probe.txt")).toBe(`${site}-upload`);
        expect(await machine.command("curl --fail --silent --max-time 10 http://127.0.0.1:8080/wp-content/uploads/probe.pdf")).toBe(`${site}-pdf`);
        for (const path of ["/wp-content/uploads", "/wp-content/uploads/", "/wp-content/uploads/probe.php", "/wp-content/db.php", "/wp-content/database/wordpress.db", `/wp-content/../../${site === "sqlite" ? "mariadb" : "sqlite"}/wp-content/uploads/probe.txt`]) {
          expect(await machine.command(`curl --path-as-is --silent --output /tmp/denied-body --write-out '%{http_code}' --max-time 10 'http://127.0.0.1:8080${path}'`)).toMatch(/^(400|404)$/);
        }
        const state = await machine.command("kandelo-service inspect", 1000);
        expect(state.match(/\trunning\t/g)).toHaveLength(1);
      }
      await machine.command(`/usr/bin/kandelo-service enable wordpress-${other}`, 1000);
      await machine.command("test ! -e /etc/kandelo/wordpress-backend; test ! -d /var/lib/wordpress-sites/sqlite/wp-admin; test ! -d /var/lib/wordpress-sites/mariadb/wp-admin");
    } finally { await machine.host.destroy(); }
  }, 240000);
}
