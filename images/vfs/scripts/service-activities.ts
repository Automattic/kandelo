import type { KandeloImageFs } from "../lib/kandelo-image-fs";
import { ensureDirRecursive, writeVfsFile } from "./vfs-image-helpers";
import { COMPUTER_SERVICES_PATH, parseComputerServices } from "../../../web-libs/kandelo-session/src/computer-services";
import type { DemoGuideConfig } from "../../../web-libs/kandelo-session/src/demo-config";

export interface ServiceActivity {
  target: string;
  port: number;
  title?: string;
  shortcuts?: DemoGuideConfig;
}

export function installServiceActivities(fs: KandeloImageFs, activities: readonly ServiceActivity[], control: Uint8Array, preflight = ""): void {
  if (!activities.length || new Set(activities.map(activity => activity.target)).size !== activities.length) throw new Error("Service activities must be nonempty and unique");
  for (const activity of activities) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(activity.target) || !Number.isInteger(activity.port) || activity.port < 1 || activity.port > 65535) throw new Error("Invalid service activity");
    fs.stat(`/etc/dinit.d/${activity.target}`);
  }
  const targets = activities.map(activity => activity.target).join(" ");
  const ports = activities.map(activity => `  ${activity.target}) port=${activity.port} ;;`).join("\n");
  for (const path of ["/sbin", "/usr/local/bin", "/usr/local/libexec", "/etc/kandelo", "/run/kandelo-services"]) ensureDirRecursive(fs, path);
  fs.chmod("/run/kandelo-services", 0o700);
  const services = parseComputerServices(JSON.stringify({ version: 1, services: activities.map(activity => ({
    id: activity.target, title: activity.title ?? activity.target, port: activity.port,
    ...(activity.shortcuts ? { shortcuts: activity.shortcuts } : {}),
  })) }));
  writeVfsFile(fs, COMPUTER_SERVICES_PATH, JSON.stringify({ version: 1, services }));
  fs.writeFile("/usr/local/bin/kandelo-service", control, 0o4755);
  fs.chmod("/usr/local/bin/kandelo-service", 0o4755);
  writeVfsFile(fs, "/etc/dinit.d/machine", "type = internal\nrestart = false\n");
  writeVfsFile(fs, "/usr/local/libexec/kandelo-service", `#!/bin/sh
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
    stopped=
    for other in ${targets}; do
      if [ "$other" != "$target" ] && control is-started "$other" >/dev/null 2>&1; then
        control stop --ignore-unstarted "$other"
        stopped="$stopped $other"
      fi
    done
    if ! control start "$target"; then
      for other in $stopped; do control start "$other" || echo "Could not restore $other" >&2; done
      exit 1
    fi
    /usr/bin/curl --fail --silent --show-error --retry 30 --retry-connrefused --retry-delay 1 --max-time 3 --output /dev/null "http://127.0.0.1:$port/"
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
  /usr/local/bin/kandelo-service enable "$target"
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
