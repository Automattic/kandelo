import type { KandeloImageFs } from "../lib/kandelo-image-fs";
import { ensureDirRecursive, writeVfsFile } from "./vfs-image-helpers";
import { addSyslogService, renderService } from "./dinit-image-helpers";
import { COMPUTER_SERVICES_PATH, parseComputerServices } from "../../../web-libs/kandelo-session/src/computer-services";
import type { DemoGuideConfig } from "../../../web-libs/kandelo-session/src/demo-config";

export interface ServiceActivity {
  target: string;
  port: number;
  title?: string;
  shortcuts?: DemoGuideConfig;
}

export function installServiceActivities(fs: KandeloImageFs, activities: readonly ServiceActivity[], control: Uint8Array, preflight = "", syslogd?: Uint8Array): void {
  if (!activities.length || new Set(activities.map(activity => activity.target)).size !== activities.length) throw new Error("Service activities must be nonempty and unique");
  for (const activity of activities) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(activity.target) || !Number.isInteger(activity.port) || activity.port < 1 || activity.port > 65535) throw new Error("Invalid service activity");
    fs.stat(`/etc/dinit.d/${activity.target}`);
  }
  const targets = activities.map(activity => activity.target).join(" ");
  const ports = activities.map(activity => `  ${activity.target}) port=${activity.port} ;;`).join("\n");
  for (const path of ["/sbin", "/usr/bin", "/usr/libexec", "/etc/kandelo", "/run/kandelo-services"]) ensureDirRecursive(fs, path);
  fs.chmod("/run/kandelo-services", 0o700);
  const services = parseComputerServices(JSON.stringify({ version: 1, services: activities.map(activity => ({
    id: activity.target, title: activity.title ?? activity.target, port: activity.port,
    ...(activity.shortcuts ? { shortcuts: activity.shortcuts } : {}),
  })) }));
  writeVfsFile(fs, COMPUTER_SERVICES_PATH, JSON.stringify({ version: 1, services }));
  fs.writeFile("/usr/bin/kandelo-service", control, 0o4755);
  fs.chmod("/usr/bin/kandelo-service", 0o4755);
  // The syslog daemon is infrastructure, not an activity: it has no port and
  // no page, and it must be running before the activity it collects messages
  // from. `machine` is what kandelo-init always starts, so waiting for it here
  // means it runs on every boot whichever activity is enabled.
  //
  // `waits-for`, not `depends-on`: a machine whose logging failed should still
  // serve. Losing the log is worth reporting, not worth refusing to boot.
  const syslogService = syslogd === undefined ? undefined : addSyslogService(fs, { binary: syslogd });
  if (syslogService !== undefined) {
    writeVfsFile(fs, `/etc/dinit.d/${syslogService.name}`, renderService(syslogService));
    // Each activity waits for the daemon too, not just `machine`. kandelo-init
    // passes both `machine` and the enabled activity as dinit targets, so they
    // start in parallel: without this, nginx or PHP-FPM can log before the
    // daemon has bound /dev/log, and those messages are dropped silently --
    // syslog(3) cannot report a missing receiver. The earliest messages are
    // the ones worth having when a service fails to come up.
    for (const activity of activities) {
      const path = `/etc/dinit.d/${activity.target}`;
      const current = new TextDecoder().decode(fs.readFile(path));
      if (!/^waits-for = syslogd$/m.test(current)) {
        writeVfsFile(
          fs,
          path,
          `${current.endsWith("\n") ? current : `${current}\n`}waits-for = ${syslogService.name}\n`,
        );
      }
    }
  }
  writeVfsFile(
    fs,
    "/etc/dinit.d/machine",
    `type = internal\nrestart = false\n${syslogService ? `waits-for = ${syslogService.name}\n` : ""}`,
  );
  writeVfsFile(fs, "/usr/libexec/kandelo-service", `#!/bin/sh
set -eu
action=\${1:-}
target=\${2:-}
case "$action" in
  list|inspect) [ "$#" = 1 ] || exit 2 ;;
  start|stop|enable|disable|status) [ "$#" = 2 ] || exit 2 ;;
  *) echo 'Use list, inspect, start, stop, enable, disable, or status' >&2; exit 2 ;;
esac
if [ "$(id -u)" != 0 ]; then echo 'Service helper requires its delegated credentials' >&2; exit 1; fi
control() { /sbin/dinitctl -p /run/kandelo-services/dinitctl "$@"; }
if [ "$action" = list ] || [ "$action" = inspect ]; then
  machine=0
  if [ "$action" = inspect ]; then machine=1; fi
  enabled=-
  if [ -f /etc/kandelo/enabled-service ]; then enabled=$(cat /etc/kandelo/enabled-service); fi
  case "$enabled" in ${activities.map(activity => activity.target).join("|")}|-) ;; *) echo 'Invalid enabled service configuration' >&2; exit 1 ;; esac
  snapshot=$(control list)
  printf '%s\\n' "$snapshot" | awk -v targets='${targets}' -v machine="$machine" -v enabled="$enabled" '
    {
      split(substr($0, 12), fields, " ")
      state = "unknown"
      if (substr($0, 5, 2) == "<<") state = "starting"
      else if (substr($0, 5, 2) == ">>") state = "stopping"
      else if (substr($0, 3, 1) == "+") state = "running"
      else if (substr($0, 3, 1) == "s") state = "skipped"
      else if (substr($0, 8, 1) == "X") state = "failed"
      else if (substr($0, 8, 1) == "-") state = "stopped"
      states[fields[1]] = state
    }
    END {
      if (machine) printf "KANDELO_SERVICES\\t1\\n"
      else printf "%-24s %-12s %s\\n", "ACTIVITY", "STATE", "NEXT BOOT"
      count = split(targets, activities, " ")
      for (activityIndex = 1; activityIndex <= count; activityIndex++) {
        activity = activities[activityIndex]
        if (machine) printf "%s\\t%s\\t%s\\n", activity, (activity in states ? states[activity] : "not-loaded"), (activity == enabled ? "enabled" : "disabled")
        else printf "%-24s %-12s %s\\n", activity, (activity in states ? states[activity] : "not-loaded"), (activity == enabled ? "enabled" : "disabled")
      }
    }'
  exit
fi
case "$target" in
${ports}
  *) echo 'Unknown service activity' >&2; exit 2 ;;
esac
case "$action" in
  start)
    ${preflight}
    # A boot service may still be STARTING. is-started skips it and lets
    # both websites race for the same port. Stop every competing target;
    # remember only targets dinit intended to run for failure recovery.
    snapshot=$(control list)
    stopped=$(printf '%s\\n' "$snapshot" | awk -v targets='${targets}' -v target="$target" '
      BEGIN { count = split(targets, names, " "); for (i = 1; i <= count; i++) declared[names[i]] = 1 }
      {
        split(substr($0, 12), fields, " ")
        name = fields[1]
        if (name in declared && name != target && substr($0, 7, 1) == " ") print name
      }')
    for other in ${targets}; do
      if [ "$other" != "$target" ]; then control stop --ignore-unstarted "$other"; fi
    done
    if ! control start "$target"; then
      for other in $stopped; do control start "$other" || echo "Could not restore $other" >&2; done
      exit 1
    fi
    /usr/bin/curl --fail --silent --show-error --retry 30 --retry-connrefused --retry-delay 1 --max-time 3 --output /dev/null "http://127.0.0.1:$port/"
    control is-started "$target"
    ;;
  stop) control stop --ignore-unstarted "$target" ;;
  status) control status "$target" ;;
  enable)
    ${preflight}
    printf '%s\\n' "$target" > /etc/kandelo/enabled-service.pending
    sync
    mv /etc/kandelo/enabled-service.pending /etc/kandelo/enabled-service
    sync
    ;;
  disable)
    if [ -f /etc/kandelo/enabled-service ] && [ "$(cat /etc/kandelo/enabled-service)" = "$target" ]; then
      printf '%s\\n' - > /etc/kandelo/enabled-service.pending
      sync
      mv /etc/kandelo/enabled-service.pending /etc/kandelo/enabled-service
      sync
    fi
    ;;
esac
`, 0o755);
  writeVfsFile(fs, "/sbin/kandelo-init", `#!/bin/sh
set -eu
target=\${1:-}
case "$target" in
${ports}
  *) echo 'Unknown initial service activity' >&2; exit 2 ;;
esac
${preflight}
previous=
if [ -f /etc/kandelo/initial-service ]; then previous=$(cat /etc/kandelo/initial-service); fi
if [ "$previous" != "$target" ]; then
  /usr/bin/kandelo-service enable "$target"
  printf '%s\\n' "$target" > /etc/kandelo/initial-service
  sync
fi
enabled=$(cat /etc/kandelo/enabled-service)
case "$enabled" in
${ports}
  -) exec /sbin/dinit --container -p /run/kandelo-services/dinitctl machine ;;
  *) echo 'Invalid enabled service configuration' >&2; exit 2 ;;
esac
target=$enabled
${preflight}
exec /sbin/dinit --container -p /run/kandelo-services/dinitctl machine "$enabled"
`, 0o755);
}

export function copyImageTree(source: KandeloImageFs, destination: KandeloImageFs, sourcePath: string, destinationPath = sourcePath): void {
  const stat = source.lstat(sourcePath);
  const kind = stat.mode & 0o170000;
  if (kind === 0o040000) {
    ensureDirRecursive(destination, destinationPath);
    for (const name of source.readDirNames(sourcePath).sort()) {
      if (name === "." || name === "..") continue;
      copyImageTree(source, destination, `${sourcePath}/${name}`, `${destinationPath}/${name}`);
    }
  } else if (kind === 0o120000) {
    ensureDirRecursive(destination, destinationPath.slice(0, destinationPath.lastIndexOf("/")) || "/");
    try { destination.lstat(destinationPath); destination.unlink(destinationPath); }
    catch (error) { if ((error as { errno?: number }).errno !== 2) throw error; }
    destination.symlink(source.readlink(sourcePath), destinationPath);
    return;
  } else if (kind === 0o100000) {
    if (stat.deferred) throw new Error(`Cannot eagerly copy deferred image entry ${sourcePath}`);
    ensureDirRecursive(destination, destinationPath.slice(0, destinationPath.lastIndexOf("/")) || "/");
    destination.writeFile(destinationPath, source.readFile(sourcePath), stat.mode & 0o7777);
  } else {
    throw new Error(`Unsupported image composition entry ${sourcePath}`);
  }
  destination.chmod(destinationPath, stat.mode & 0o7777);
  destination.chown(destinationPath, stat.uid, stat.gid);
}
