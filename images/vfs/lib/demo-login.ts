import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

export const DEMO_LOGIN_USERNAME = "maker";
export const DEMO_LOGIN_HOME = "/home/maker";
export const DEMO_LOGIN_SHELL = "/bin/sh";
export const DEMO_LOGIN_PASSWORD = "kandelo";
export const DEMO_LOGIN_PASSWORD_HASH =
  "$6$kandelo$DKNPruix37YeUx9j4kJIGJ2NvXdqzxDr5b1D3xJZzbwFsNYuep8j3AtxB7OaTD6HWnz/adonyTamRx4XQwJ06/";
export const DEMO_LOGIN_PROGRAM_PATH = "/usr/bin/login";
export const DEMO_AUTOLOGIN_MOTD_PATH = "/etc/motd.autologin";
export const DEMO_SUDOERS_PATH = "/etc/sudoers";
export const DEMO_SUDOERS = "%wheel ALL=(ALL:ALL) ALL\n";
export const DEMO_AUTOLOGIN_MOTD = [
  "Welcome to Kandelo!",
  "",
  "Every new terminal logs in automatically.",
  "",
  `login: ${DEMO_LOGIN_USERNAME}`,
  `password: ${DEMO_LOGIN_PASSWORD}`,
  "",
].join("\n");

export interface DemoLoginOptions {
  home?: string;
  shell?: string;
}

/**
 * Opt an image into the real guest login path. Account databases, policy, and
 * the preauthentication-only greeting remain ordinary VFS files consumed by
 * libc and the guest programs.
 */
export function configureDemoLogin(
  fs: MemoryFileSystem,
  options: DemoLoginOptions = {},
): void {
  const home = options.home ?? DEMO_LOGIN_HOME;
  const shell = options.shell ?? DEMO_LOGIN_SHELL;
  const passwd = updateRequiredRecord(
    readVfsText(fs, "/etc/passwd"),
    DEMO_LOGIN_USERNAME,
    (fields) => {
      fields[5] = home;
      fields[6] = shell;
    },
  );
  const shadow = updateRequiredRecord(
    readVfsText(fs, "/etc/shadow"),
    DEMO_LOGIN_USERNAME,
    (fields) => {
      fields[1] = DEMO_LOGIN_PASSWORD_HASH;
    },
  );
  const group = addGroupMember(
    readVfsText(fs, "/etc/group"),
    "wheel",
    10,
    DEMO_LOGIN_USERNAME,
  );

  writeRootFile(fs, "/etc/passwd", passwd, 0o644);
  writeRootFile(fs, "/etc/shadow", shadow, 0o640);
  writeRootFile(fs, "/etc/group", group, 0o644);
  writeRootFile(fs, DEMO_SUDOERS_PATH, DEMO_SUDOERS, 0o440);
  writeRootFile(fs, DEMO_AUTOLOGIN_MOTD_PATH, DEMO_AUTOLOGIN_MOTD, 0o644);
}

/**
 * True when the final staged filesystem contains one exact canonical account,
 * password, wheel policy, credential message, and root-owned set-ID login
 * entry. Privileged-product publication separately proves the executable
 * bytes and trusted mount provenance before the browser grants session policy.
 */
export function hasConfiguredDemoLogin(
  fs: MemoryFileSystem,
  privilegedProgramFs: Pick<MemoryFileSystem, "stat"> = fs,
): boolean {
  try {
    const login = privilegedProgramFs.stat(DEMO_LOGIN_PROGRAM_PATH);
    // A separately published product is an immutable, eagerly serialized
    // tree. Only the ordinary MemoryFS path can carry a deferred entry.
    const loginIsEager =
      privilegedProgramFs === fs
        ? fs.getLazyEntry(DEMO_LOGIN_PROGRAM_PATH) === null
        : true;
    const loginIsStaged =
      (login.mode & 0o170000) === 0o100000 &&
      (login.mode & 0o7777) === 0o4755 &&
      login.uid === 0 &&
      login.gid === 0 &&
      loginIsEager;
    const shadowMetadata = fs.stat("/etc/shadow");
    const passwdMetadata = fs.stat("/etc/passwd");
    const groupMetadata = fs.stat("/etc/group");
    const sudoersMetadata = fs.stat(DEMO_SUDOERS_PATH);
    const autologinMotdMetadata = fs.stat(DEMO_AUTOLOGIN_MOTD_PATH);
    const passwd = readVfsText(fs, "/etc/passwd");
    const shadow = readVfsText(fs, "/etc/shadow");
    const group = readVfsText(fs, "/etc/group");
    const sudoers = readVfsText(fs, DEMO_SUDOERS_PATH);
    const autologinMotd = readVfsText(fs, DEMO_AUTOLOGIN_MOTD_PATH);
    const accountRecords = recordsNamed(passwd, DEMO_LOGIN_USERNAME);
    const shadowRecords = recordsNamed(shadow, DEMO_LOGIN_USERNAME);
    const wheelRecords = recordsNamed(group, "wheel");
    const account = accountRecords[0] ?? [];
    const password = shadowRecords[0] ?? [];
    const wheel = wheelRecords[0] ?? [];
    const accountIsCanonical =
      accountRecords.length === 1 &&
      account.length === 7 &&
      account[1] === "x" &&
      account[2] === "1000" &&
      account[3] === "1000" &&
      account[4] === DEMO_LOGIN_USERNAME &&
      account[5] === DEMO_LOGIN_HOME &&
      account[6] === DEMO_LOGIN_SHELL;
    const accountHasCanonicalPassword =
      shadowRecords.length === 1 && password[1] === DEMO_LOGIN_PASSWORD_HASH;
    const wheelAllowsMaker =
      wheelRecords.length === 1 &&
      wheel.length === 4 &&
      wheel[1] === "x" &&
      wheel[2] === "10" &&
      wheel[3] === DEMO_LOGIN_USERNAME;
    return (
      loginIsStaged &&
      passwdMetadata.uid === 0 &&
      passwdMetadata.gid === 0 &&
      (passwdMetadata.mode & 0o7777) === 0o644 &&
      shadowMetadata.uid === 0 &&
      shadowMetadata.gid === 0 &&
      (shadowMetadata.mode & 0o7777) === 0o640 &&
      groupMetadata.uid === 0 &&
      groupMetadata.gid === 0 &&
      (groupMetadata.mode & 0o7777) === 0o644 &&
      sudoersMetadata.uid === 0 &&
      sudoersMetadata.gid === 0 &&
      (sudoersMetadata.mode & 0o7777) === 0o440 &&
      (autologinMotdMetadata.mode & 0o170000) === 0o100000 &&
      autologinMotdMetadata.uid === 0 &&
      autologinMotdMetadata.gid === 0 &&
      (autologinMotdMetadata.mode & 0o7777) === 0o644 &&
      accountIsCanonical &&
      accountHasCanonicalPassword &&
      wheelAllowsMaker &&
      sudoers === DEMO_SUDOERS &&
      autologinMotd === DEMO_AUTOLOGIN_MOTD
    );
  } catch {
    return false;
  }
}

function recordsNamed(content: string, name: string): string[][] {
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(":"))
    .filter((fields) => fields[0] === name);
}

function updateRequiredRecord(
  content: string,
  name: string,
  update: (fields: string[]) => void,
): string {
  let found = false;
  const lines = content
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const fields = line.split(":");
      if (fields[0] !== name) return line;
      found = true;
      update(fields);
      return fields.join(":");
    });
  if (!found) throw new Error(`demo login account ${name} is missing`);
  return `${lines.join("\n")}\n`;
}

function addGroupMember(
  content: string,
  name: string,
  gid: number,
  member: string,
): string {
  let found = false;
  const lines = content
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const fields = line.split(":");
      if (fields[0] !== name) return line;
      found = true;
      const members = new Set((fields[3] ?? "").split(",").filter(Boolean));
      members.add(member);
      fields[3] = Array.from(members).join(",");
      return fields.join(":");
    });
  if (!found) lines.push(`${name}:x:${gid}:${member}`);
  return `${lines.join("\n")}\n`;
}

function readVfsText(fs: MemoryFileSystem, path: string): string {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(st.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.read(
        fd,
        bytes.subarray(offset),
        null,
        bytes.length - offset,
      );
      if (count <= 0) break;
      offset += count;
    }
    return new TextDecoder().decode(bytes.subarray(0, offset));
  } finally {
    fs.close(fd);
  }
}

function writeRootFile(
  fs: MemoryFileSystem,
  path: string,
  content: string,
  mode: number,
): void {
  const bytes = new TextEncoder().encode(content);
  const fd = fs.open(path, 0o1101, mode);
  try {
    fs.write(fd, bytes, 0, bytes.length);
  } finally {
    fs.close(fd);
  }
  fs.chown(path, 0, 0);
  fs.chmod(path, mode);
}
