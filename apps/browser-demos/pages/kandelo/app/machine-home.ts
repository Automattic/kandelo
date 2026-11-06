/**
 * Where the download dialog opens: the home of the account the machine's
 * exchange agent runs as, so the `~/Downloads` that sent files land in is one
 * step away. A machine without a valid `/etc/kandelo/exchange.conf`, or whose
 * `/etc/passwd` does not list its account, opens at `/`.
 */
import type { KernelHost } from "../../../../../web-libs/kandelo-session/src/kernel-host";

const decoder = new TextDecoder();

/** `user NAME` from exchange.conf, read as kxchgd reads it: any other line makes the file invalid. */
export function exchangeUser(conf: string): string | null {
  let user: string | null = null;
  for (const line of conf.split("\n")) {
    const fields = line.split("#")[0]!.trim().split(/\s+/).filter(Boolean);
    if (fields.length === 0) continue;
    if (fields.length !== 2 || fields[0] !== "user" || user !== null) return null;
    user = fields[1]!;
  }
  return user;
}

export function passwdHome(passwd: string, user: string): string | null {
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    if (fields.length < 7 || fields[0] !== user) continue;
    return fields[5] || null;
  }
  return null;
}

export async function machineHome(host: KernelHost): Promise<string> {
  const [conf, passwd] = await Promise.all([
    host.readVfsFile("/etc/kandelo/exchange.conf"),
    host.readVfsFile("/etc/passwd"),
  ]);
  const user = conf ? exchangeUser(decoder.decode(conf)) : null;
  if (!user || !passwd) return "/";
  return passwdHome(decoder.decode(passwd), user) ?? "/";
}
