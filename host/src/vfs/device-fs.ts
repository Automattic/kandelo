import type { StatResult } from "../types";
import type { FileSystemBackend, DirEntry } from "./types";

const S_IFCHR = 0o020000;
const S_IFDIR = 0o040000;

type DeviceReader = (buffer: Uint8Array, length: number) => number;
type DeviceWriter = (buffer: Uint8Array, length: number) => number;

interface DeviceNode {
  reader: DeviceReader;
  writer: DeviceWriter;
  mode: number;
}

const nullDevice: DeviceNode = {
  reader: () => 0, // EOF
  writer: (_buf, len) => len, // discard, report success
  mode: S_IFCHR | 0o666,
};

const zeroDevice: DeviceNode = {
  reader: (buf, len) => {
    buf.fill(0, 0, len);
    return len;
  },
  writer: (_buf, len) => len, // discard
  mode: S_IFCHR | 0o666,
};

const ttyDevice: DeviceNode = {
  reader: () => { throw new Error("ENXIO"); },
  writer: () => { throw new Error("ENXIO"); },
  mode: S_IFCHR | 0o666,
};

function makeRandomDevice(): DeviceNode {
  return {
    reader: (buf, len) => {
      if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
        // crypto.getRandomValues rejects SharedArrayBuffer-backed views in browsers,
        // so generate into a temporary non-shared buffer and copy.
        const tmp = new Uint8Array(len);
        globalThis.crypto.getRandomValues(tmp);
        buf.set(tmp, 0);
      } else {
        // Fallback: not cryptographically secure, but functional
        for (let i = 0; i < len; i++) buf[i] = (Math.random() * 256) | 0;
      }
      return len;
    },
    writer: (_buf, len) => len, // writes accepted, discarded (matches Linux)
    mode: S_IFCHR | 0o666,
  };
}

interface OpenHandle {
  device: DeviceNode;
}

export class DeviceFileSystem implements FileSystemBackend {
  private devices = new Map<string, DeviceNode>();
  private handles = new Map<number, OpenHandle>();
  private nextHandle = 1;
  private deviceNames: string[];

  constructor() {
    const random = makeRandomDevice();
    this.devices.set("null", nullDevice);
    this.devices.set("zero", zeroDevice);
    this.devices.set("urandom", random);
    this.devices.set("random", random);
    this.devices.set("console", ttyDevice);
    this.devices.set("tty", ttyDevice);
    this.deviceNames = [...this.devices.keys()];
  }

  private getDevice(path: string): DeviceNode {
    const name = path.startsWith("/") ? path.slice(1) : path;
    const dev = this.devices.get(name);
    if (!dev) throw new Error("ENOENT");
    return dev;
  }

  open(path: string, _flags: number, _mode: number): number {
    const device = this.getDevice(path);
    const handle = this.nextHandle++;
    this.handles.set(handle, { device });
    return handle;
  }

  close(handle: number): number {
    if (!this.handles.delete(handle)) throw new Error("EBADF");
    return 0;
  }

  read(handle: number, buffer: Uint8Array, _offset: number | null, length: number): number {
    const h = this.handles.get(handle);
    if (!h) throw new Error("EBADF");
    return h.device.reader(buffer, Math.min(length, buffer.length));
  }

  write(handle: number, buffer: Uint8Array, _offset: number | null, length: number): number {
    const h = this.handles.get(handle);
    if (!h) throw new Error("EBADF");
    return h.device.writer(buffer, Math.min(length, buffer.length));
  }

  seek(_handle: number, _offset: number, _whence: number): number {
    return 0; // character devices don't seek
  }

  fstat(handle: number): StatResult {
    const h = this.handles.get(handle);
    if (!h) throw new Error("EBADF");
    const now = Date.now();
    return {
      dev: 5, ino: 0, mode: h.device.mode, nlink: 1,
      uid: 0, gid: 0, size: 0,
      atimeMs: now, mtimeMs: now, ctimeMs: now,
    };
  }

  ftruncate(_handle: number, _length: number): void {}
  fsync(_handle: number): void {}
  fchmod(_handle: number, _mode: number): void {}
  fchown(_handle: number, _uid: number, _gid: number): void {}

  stat(path: string): StatResult {
    if (path === "/" || path === "" || path === ".") {
      const now = Date.now();
      return {
        dev: 5, ino: 0, mode: S_IFDIR | 0o755, nlink: 2 + this.devices.size,
        uid: 0, gid: 0, size: 0,
        atimeMs: now, mtimeMs: now, ctimeMs: now,
      };
    }
    const dev = this.getDevice(path);
    const now = Date.now();
    return {
      dev: 5, ino: 0, mode: dev.mode, nlink: 1,
      uid: 0, gid: 0, size: 0,
      atimeMs: now, mtimeMs: now, ctimeMs: now,
    };
  }

  lstat(path: string): StatResult {
    return this.stat(path);
  }

  mkdir(_path: string, _mode: number): void {
    throw new Error("EACCES");
  }

  rmdir(_path: string): void {
    throw new Error("EACCES");
  }

  unlink(_path: string): void {
    throw new Error("EACCES");
  }

  rename(_oldPath: string, _newPath: string): void {
    throw new Error("EACCES");
  }

  link(_existingPath: string, _newPath: string): void {
    throw new Error("ENOSYS");
  }

  symlink(_target: string, _path: string): void {
    throw new Error("EACCES");
  }

  readlink(_path: string): string {
    throw new Error("EINVAL");
  }

  chmod(_path: string, _mode: number): void {}
  chown(_path: string, _uid: number, _gid: number): void {}

  access(path: string, _mode: number): void {
    this.stat(path); // throws ENOENT if not found
  }

  utimensat(_path: string, _atimeSec: number, _atimeNsec: number, _mtimeSec: number, _mtimeNsec: number): void {
    // No-op for device files
  }

  // Directory iteration for /dev itself
  private dirHandles = new Map<number, number>();
  private nextDirHandle = 1;

  opendir(path: string): number {
    if (path !== "/" && path !== "" && path !== ".") throw new Error("ENOTDIR");
    const handle = this.nextDirHandle++;
    this.dirHandles.set(handle, 0);
    return handle;
  }

  readdir(handle: number): DirEntry | null {
    const idx = this.dirHandles.get(handle);
    if (idx === undefined) throw new Error("EBADF");
    if (idx >= this.deviceNames.length) return null;
    this.dirHandles.set(handle, idx + 1);
    const name = this.deviceNames[idx];
    return { name, type: 2 /* DT_CHR */, ino: idx + 1 };
  }

  closedir(handle: number): void {
    this.dirHandles.delete(handle);
  }
}
