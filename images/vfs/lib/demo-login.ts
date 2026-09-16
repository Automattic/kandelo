import type { VfsImageFilesystem } from "../../../host/src/vfs/vfs-image-filesystem";

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
  fs: VfsImageFilesystem,
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
/**
 * "Are this path's bytes in the image?", asked so that either filesystem can
 * answer it completely.
 *
 * `MemoryFileSystem` splits the question: `isPathDeferred` covers archive- and
 * tree-backed files and MISSES a URL-backed single lazy file, so its callers
 * compute the union with `getLazyEntry`. The module bridge does not split it —
 * a deferred file is deferred whether an archive or a URL stands behind it —
 * and deliberately has no `getLazyEntry` at all.
 *
 * Asking only the union broke against the bridge, and broke SILENTLY: the
 * missing method threw, the caller's `try` swallowed it, and a predicate about
 * login policy answered "not configured" when what happened was "could not
 * tell". Asking only `isPathDeferred` would weaken the check against
 * MemoryFileSystem, which is the case lane S's defect is about. So: ask the
 * narrow question first, and add the union only where it exists.
 */
function isDeferredEitherWay(fs: VfsImageFilesystem, path: string): boolean {
  if (fs.isPathDeferred(path)) return true;
  const perFile = (fs as Partial<{ getLazyEntry(p: string): unknown }>).getLazyEntry;
  return typeof perFile === "function" && perFile.call(fs, path) !== null;
}

export function hasConfiguredDemoLogin(
  fs: VfsImageFilesystem,
  privilegedProgramFs: Pick<VfsImageFilesystem, "stat"> = fs,
): boolean {
  try {
    const login = privilegedProgramFs.stat(DEMO_LOGIN_PROGRAM_PATH);
    // A separately published product is an immutable, eagerly serialized
    // tree. Only the ordinary MemoryFS path can carry a deferred entry.
    const loginIsEager =
      privilegedProgramFs === fs
        ? !isDeferredEitherWay(fs, DEMO_LOGIN_PROGRAM_PATH)
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
  } catch (error) {
    // "Not there" is the ANSWER; anything else is a failure to ask.
    //
    // An image without `/etc/shadow` is genuinely not configured for login,
    // and `stat` throwing ENOENT is how this function learns that. Every other
    // error is different in kind: a missing method on an unfamiliar
    // filesystem, a permission refusal, a corrupt read. Returning `false` for
    // those reports a CONFIGURED image as unconfigured, and does it in a shape
    // no caller can tell from the real answer.
    //
    // Found by repointing `demo-login-image.test.ts` at the Rust writer, where
    // a swallowed error would have read as "this image has no login" — the
    // same shape as defect B45, where a loss looked like a successful boot.
    if (isNotFound(error)) return false;
    throw error;
  }
}

/**
 * ENOENT from either filesystem, read structurally rather than by class.
 *
 * The two number errnos with OPPOSITE SIGNS — `host/src/vfs/vfs-errors.ts`
 * uses `-2` because its error carries a returned code, and the image bridge
 * raises `2` because it negates at its boundary — and comparing one convention
 * against the other is silently always-false, which cost 59 browser tests once
 * already. Both are accepted here for that reason.
 *
 * Structural rather than `instanceof` because this module is in `images/` and
 * may be handed either filesystem; importing one side's error class to
 * recognise the other's would be the coupling, not the fix.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { errno, code } = error as { errno?: unknown; code?: unknown };
  if (errno === 2 || code === -2) return true;
  return typeof code === "string" && code === "ENOENT";
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

function readVfsText(fs: VfsImageFilesystem, path: string): string {
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
  fs: VfsImageFilesystem,
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
