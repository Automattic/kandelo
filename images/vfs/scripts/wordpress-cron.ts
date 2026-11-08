import type { KandeloImageFs } from "../lib/kandelo-image-fs";
import { ensureDirRecursive, writeVfsFile } from "./vfs-image-helpers";
import { wordpressCronCurlConfig } from "../../../apps/browser-demos/lib/init/wordpress-runtime-config";

/** Make ordinary Dinit service ownership include WordPress's HTTP scheduler. */
export function installWordPressCron(fs: KandeloImageFs, targets: readonly string[]): void {
  // The normal shell/partial dependency closure must provide this command.
  // Fail during composition instead of shipping a scheduler that cannot run.
  fs.stat("/usr/bin/curl");
  ensureDirRecursive(fs, "/etc/wordpress");
  writeVfsFile(fs, "/etc/wordpress/cron.curl", wordpressCronCurlConfig());
  for (const target of targets) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(target)) throw new Error("Invalid WordPress service target");
    const path = `/etc/dinit.d/${target}`;
    const original = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFile(path));
    if (!/^type = process$/m.test(original)) throw new Error(`${target} is not a process service`);
    const restart = /^restart = true$/m.test(original);
    writeVfsFile(fs, `${path}-server`, original);
    // The public activity is the dependency owner. Cron depends on the real
    // listener, so a stop/switch cannot leave a timer keeping that server up.
    writeVfsFile(fs, path, `type = internal
restart = ${restart}
depends-on = ${target}-server
depends-on = ${target}-cron
`);
    writeVfsFile(fs, `${path}-cron`, `type = process
command = /usr/bin/curl --config /etc/wordpress/cron.curl
depends-on = ${target}-server
restart = true
smooth-recovery = true
restart-delay = 60
logfile = /var/log/${target}-cron.log
stop-timeout = 30
`);
  }
}
