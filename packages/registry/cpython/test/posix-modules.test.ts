import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBinary } from "../../../../host/src/binary-resolver";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";
import { expandArchiveUnderUsr } from "../../../../images/vfs/scripts/build-kandelo-build-image";

// CPython's POSIX modules on Kandelo, run from the python-browser-bundle
// archive the shell mounts at /usr. Upstream's WASI configure target turns
// these modules off; posix-libc-modules.patch lets configure's usual checks
// build them, and each script below exercises the platform interface the
// module wraps and judges its own result. See packages/registry/cpython/README.md.

const PYTHON_ZIP = "programs/wasm32/python-browser-bundle/python.zip";

async function pythonImage(): Promise<Uint8Array> {
  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(readFileSync(resolveBinary("programs/rootfs.vfs.zst"))));
  expandArchiveUnderUsr(fs, new Uint8Array(readFileSync(resolveBinary(PYTHON_ZIP))), "python archive");
  return fs.saveImage();
}

// No PYTHONHOME: the interpreter finds its prefix and exec_prefix from the
// installed layout, as a process started outside a login shell does.
const ENV = ["PATH=/usr/bin:/bin", "HOME=/tmp", "TMPDIR=/tmp", "LANG=C.UTF-8"];

const SCRIPTS: Record<string, string> = {
  prefix: `
import sys
assert (sys.prefix, sys.exec_prefix) == ("/usr", "/usr"), (sys.prefix, sys.exec_prefix)
assert "/usr/lib/python3.13/lib-dynload" in sys.path, sys.path
print("prefix-ok")
`,
  termios: `
import errno, os, termios
master, slave = os.openpty()
assert os.isatty(slave)
attrs = termios.tcgetattr(slave)
assert attrs[3] & termios.ICANON and attrs[3] & termios.ECHO, attrs
attrs[3] &= ~(termios.ECHO | termios.ICANON)
attrs[6][termios.VMIN] = 1
termios.tcsetattr(slave, termios.TCSANOW, attrs)
now = termios.tcgetattr(slave)
assert not now[3] & (termios.ECHO | termios.ICANON), now
# Non-canonical: a byte is readable without a newline, and is not echoed.
os.write(master, b"x")
assert os.read(slave, 16) == b"x"
os.set_blocking(master, False)
try:
    echoed = os.read(master, 16)
except BlockingIOError:
    echoed = b""
assert echoed == b"", echoed
null = os.open("/dev/null", os.O_RDWR)
try:
    termios.tcgetattr(null)
    raise AssertionError("tcgetattr on /dev/null succeeded")
except termios.error as error:
    assert error.args[0] == errno.ENOTTY, error
print("termios-ok")
`,
  mmap: `
import mmap, os
path = "/tmp/mmap-test"
with open(path, "wb") as f:
    f.write(b"hello world")
with open(path, "r+b") as f:
    m = mmap.mmap(f.fileno(), 0)
    assert m[:5] == b"hello" and m.find(b"world") == 6
    m[:5] = b"HELLO"
    m.flush()
    m.close()
with open(path, "rb") as f:
    assert f.read() == b"HELLO world"
# An anonymous shared mapping is shared with a forked child.
shared = mmap.mmap(-1, mmap.PAGESIZE, flags=mmap.MAP_SHARED)
pid = os.fork()
if pid == 0:
    shared[:5] = b"child"
    os._exit(0)
os.waitpid(pid, 0)
assert shared[:5] == b"child", shared[:5]
print("mmap-ok")
`,
  // resize() uses mremap(MREMAP_MAYMOVE) and madvise() is defined, because
  // sdk/config.site reports both present.
  mmap_resize: `
import mmap, os
page = mmap.PAGESIZE
m = mmap.mmap(-1, page)
m[:5] = b"hello"
m.resize(4 * page)
assert len(m) == 4 * page and m[:5] == b"hello", m[:5]
assert m[page:page + 4] == bytes(4)
m[-3:] = b"end"
m.resize(page // 2)
assert len(m) == page // 2 and m[:5] == b"hello", m[:5]
m.madvise(mmap.MADV_WILLNEED)
m.madvise(mmap.MADV_SEQUENTIAL, 0, len(m))
m.close()
path = "/tmp/mmap-resize"
with open(path, "wb") as f:
    f.write(b"abc")
with open(path, "r+b") as f:
    m = mmap.mmap(f.fileno(), 0)
    m.resize(3 * page)
    m[-3:] = b"xyz"
    m.flush()
    m.close()
assert os.path.getsize(path) == 3 * page
with open(path, "rb") as f:
    data = f.read()
assert data[:3] == b"abc" and data[-3:] == b"xyz", (data[:3], data[-3:])
print("mmap_resize-ok")
`,
  resource: `
import errno, os, resource
soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
assert (soft, hard) == (1024, 4096), (soft, hard)
resource.setrlimit(resource.RLIMIT_NOFILE, (16, hard))
assert resource.getrlimit(resource.RLIMIT_NOFILE) == (16, hard)
fds = []
try:
    while True:
        fds.append(os.open("/dev/null", os.O_RDONLY))
except OSError as error:
    assert error.errno == errno.EMFILE, error
assert max(fds) == 15, fds
for fd in fds:
    os.close(fd)
try:
    resource.setrlimit(resource.RLIMIT_NOFILE, (hard + 1, hard))
    raise AssertionError("soft limit above hard limit accepted")
except ValueError:
    pass
assert resource.getrlimit(resource.RLIMIT_AS)[1] != resource.RLIM_INFINITY
usage = resource.getrusage(resource.RUSAGE_SELF)
assert usage.ru_maxrss >= 0
assert resource.getpagesize() > 0
print("resource-ok")
`,
  syslog: `
import os, socket, syslog
daemon = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
daemon.bind("/dev/log")
try:
    syslog.openlog("pytest", syslog.LOG_PID, syslog.LOG_USER)
    syslog.syslog(syslog.LOG_WARNING, "hello from python")
    daemon.settimeout(10)
    message = daemon.recv(1024).decode()
finally:
    syslog.closelog()
    daemon.close()
    os.unlink("/dev/log")
priority = syslog.LOG_USER | syslog.LOG_WARNING
assert message.startswith(f"<{priority}>"), message
assert f"pytest[{os.getpid()}]: hello from python" in message, message
print("syslog-ok")
`,
  // Processes and pipes work with the fork start method. The SemLock-based
  // primitives do not: Kandelo has no process-shared futexes, so the build
  // leaves SemLock out and CPython refuses them at import (see
  // config.site-wasm32-posix) instead of hanging or failing to exclude.
  multiprocessing: `
import multiprocessing as mp, os, _multiprocessing
def child(conn, value):
    conn.send((os.getpid(), value * 10))
    conn.close()
ctx = mp.get_context("fork")
results = []
for n in range(3):
    parent_end, child_end = ctx.Pipe()
    worker = ctx.Process(target=child, args=(child_end, n))
    worker.start()
    child_end.close()
    assert parent_end.poll(30)
    pid, value = parent_end.recv()
    worker.join(30)
    assert worker.exitcode == 0 and pid == worker.pid, (worker.exitcode, pid, worker.pid)
    results.append(value)
assert results == [0, 10, 20], results
assert not hasattr(_multiprocessing, "SemLock")
try:
    ctx.Lock()
    raise AssertionError("Lock() without process-shared semaphores")
except ImportError as error:
    assert "functioning sem_open" in str(error), error
print("multiprocessing-ok")
`,
  posixshmem: `
import os
from multiprocessing import shared_memory
block = shared_memory.SharedMemory(create=True, size=64)
try:
    block.buf[:6] = b"parent"
    pid = os.fork()
    if pid == 0:
        peer = shared_memory.SharedMemory(name=block.name)
        ok = bytes(peer.buf[:6]) == b"parent"
        peer.buf[:5] = b"child"
        peer.close()
        os._exit(0 if ok else 1)
    _, status = os.waitpid(pid, 0)
    assert os.waitstatus_to_exitcode(status) == 0, status
    assert bytes(block.buf[:5]) == b"child", bytes(block.buf[:6])
    assert os.path.exists("/dev/shm/" + block.name), block.name
finally:
    block.close()
    block.unlink()
assert not os.path.exists("/dev/shm/" + block.name)
print("posixshmem-ok")
`,
};

const CURSES = `
import curses, curses.panel
def main(screen):
    rows, cols = screen.getmaxyx()
    assert (rows, cols) == (24, 80), (rows, cols)
    screen.addstr(2, 4, "curses-drawn")
    window = curses.newwin(3, 20, 5, 5)
    window.addstr(1, 1, "panel-drawn")
    panel = curses.panel.new_panel(window)
    curses.panel.update_panels()
    curses.doupdate()
    screen.refresh()
    assert curses.has_colors()
    return curses.longname()
name = curses.wrapper(main)
print("curses-ok", name)
`;

describe("CPython POSIX modules on Kandelo", () => {
  let host: NodeKernelHost;
  let stdout = new Map<number, string>();
  let stderr = new Map<number, string>();
  const diagnostics: unknown[] = [];
  const text = new TextDecoder();

  beforeAll(async () => {
    host = new NodeKernelHost({
      rootfsImage: await pythonImage(),
      onStdout: (pid, data) => stdout.set(pid, (stdout.get(pid) ?? "") + text.decode(data)),
      onStderr: (pid, data) => stderr.set(pid, (stderr.get(pid) ?? "") + text.decode(data)),
      onPtyOutput: (pid, data) => stdout.set(pid, (stdout.get(pid) ?? "") + text.decode(data)),
      onHostDiagnostic: (value) => diagnostics.push(value),
    });
    await host.init();
  }, 300_000);

  afterAll(async () => {
    await host?.destroy();
  });

  async function python(script: string, options: { pty?: boolean; env?: string[] } = {}) {
    const { pid, exit } = await host.spawnFromVfs("/usr/bin/python3", ["python3", "-c", script], {
      env: options.env ?? ENV,
      cwd: "/tmp",
      uid: 0,
      gid: 0,
      ...(options.pty ? { pty: true, ptyRows: 24, ptyCols: 80 } : {}),
    });
    const code = await exit;
    return { code, out: stdout.get(pid) ?? "", err: stderr.get(pid) ?? "" };
  }

  for (const [name, script] of Object.entries(SCRIPTS)) {
    it(`${name}`, async () => {
      const { code, out, err } = await python(script);
      expect(code, `${out}\n${err}`).toBe(0);
      expect(out).toBe(`${name}-ok\n`);
      // Also the startup-warning check: no "Could not find platform
      // dependent libraries <exec_prefix>" without PYTHONHOME.
      expect(err).toBe("");
    }, 120_000);
  }

  it("curses and curses.panel draw on a terminal", async () => {
    const { code, out, err } = await python(CURSES, {
      pty: true,
      env: [...ENV, "TERM=xterm-256color"],
    });
    expect(code, `${out}\n${err}`).toBe(0);
    expect(out).toContain("curses-drawn");
    expect(out).toContain("panel-drawn");
    // xterm's alternate screen, entered by initscr and left by endwin.
    expect(out).toContain("\x1b[?1049h");
    expect(out).toContain("\x1b[?1049l");
    expect(out).toMatch(/curses-ok \S/);
    expect(diagnostics).toEqual([]);
  }, 120_000);
});
