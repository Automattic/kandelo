// Static design-time fixtures for MockKernelHost. Ported from
// design_handoff_kandelo_ui/reference/src/data.js + the PRESET_LIBRARY and
// CURRENT_DESCRIPTOR_TEMPLATE blocks in reference/src/kernel-host.js.
//
// These types intentionally match the kernel-host interface so the mock
// can return slices of them with no shape coercion.

import type {
  BootDescriptor, DmesgLevel, KernelStateKV, MemMapEntry, MountInfo,
  ProcessInfo, SyscallEvent, VfsKind,
} from "../../../../host/src/kandelo-ui/kernel-host";

// ── Boot log (replayed by MockKernelHost during boot) ──────────────────────

export type BootLogEntry = [t_ms: number, level: DmesgLevel, facility: string, msg: string];

export const BOOT_LOG: BootLogEntry[] = [
  [0, "info", "kernel", "Linux version 6.8.0-kandelo (build@kandelo.dev) (gcc 13.2.0)"],
  [3, "info", "kernel", "Command line: BOOT_IMAGE=/vmlinuz root=/dev/vda1 ro vfs=kandelo:b3:9f2a quiet"],
  [7, "info", "kernel", "KERNEL supported cpus: Intel GenuineIntel · AMD AuthenticAMD · WASM Sandbox"],
  [12, "info", "kernel", "BIOS-provided physical RAM map:"],
  [14, "info", "kernel", "  [mem 0x0000000000000000-0x000000000009fbff] usable"],
  [16, "info", "kernel", "  [mem 0x0000000000100000-0x000000003ffeffff] usable"],
  [22, "info", "kernel", "random: crng init done (entropy folded from URL hash)"],
  [40, "info", "kernel", "Decompressing VFS image kandelo:b3:9f2a … 8.6 MiB → 21.3 MiB"],
  [68, "info", "acpi", "ACPI: Early table checksum verification disabled"],
  [82, "info", "kernel", "CPU0: Intel(R) virtual CPU @ 2.40GHz, 4 cores, 4 threads"],
  [110, "info", "kernel", "Memory: 524288K/524288K available"],
  [142, "info", "kernel", "SLUB: HWalign=64, Order=0-3, MinObjects=0, CPUs=4, Nodes=1"],
  [170, "info", "kernel", "NR_IRQS: 33024, nr_irqs: 456, preallocated irqs: 16"],
  [220, "info", "kernel", "Detected 2399.998 MHz processor"],
  [260, "info", "kernel", "Calibrating delay loop (skipped), value calculated using timer freq."],
  [305, "info", "kernel", "pid_max: default: 32768 minimum: 301"],
  [340, "info", "kernel", "Mount-cache hash table entries: 8192 (order: 4, 65536 bytes)"],
  [380, "info", "kernel", "Initializing cgroup subsys cpuset · cpu · memory · io · pids"],
  [435, "info", "kernel", "futex hash table entries: 1024 (order: 4, 65536 bytes)"],
  [480, "info", "kernel", "Spectre V2 : Mitigation: Retpolines"],
  [520, "info", "kernel", "Speculative Store Bypass: Mitigation: Speculative Store Bypass disabled"],
  [580, "info", "kernel", "Freeing SMP alternatives memory: 36K"],
  [640, "info", "kernel", "smpboot: CPU0: Intel virtual CPU (family: 0x6, model: 0x9e)"],
  [700, "info", "kernel", "Performance Events: PMU not available due to virtualization"],
  [780, "info", "kernel", "rcu: Hierarchical SRCU implementation."],
  [830, "info", "kernel", "NET: Registered PF_NETLINK/PF_ROUTE protocol family"],
  [880, "info", "kernel", "kandelo-vfs: image kandelo:b3:9f2a verified (sha3-256 ok)"],
  [930, "info", "kernel", "kandelo-vfs: 21.3 MiB unpacked → tmpfs root (24112 inodes)"],
  [980, "info", "kernel", "random: kernel_init: uninitialized urandom read (16 bytes)"],
  [1020, "info", "kernel", 'Loaded X.509 cert "kandelo.dev signing key: 9f2a3b81d2…"'],
  [1080, "info", "kernel", "pps_core: LinuxPPS API ver. 1 registered"],
  [1140, "info", "kernel", "PCI: Using ACPI for IRQ routing"],
  [1200, "info", "kernel", "NetLabel: Initializing"],
  [1240, "info", "kernel", "audit: initializing netlink subsys (disabled)"],
  [1280, "info", "kernel", "Bluetooth: Core ver 2.22"],
  [1320, "info", "kernel", "NET: Registered PF_BLUETOOTH protocol family"],
  [1360, "warn", "kernel", "tsc: Marking TSC unstable due to TSCs unsynchronized"],
  [1400, "info", "kernel", "clocksource: Switched to clocksource jiffies"],
  [1440, "info", "kernel", "FS-Cache: Loaded"],
  [1480, "info", "kernel", "CacheFiles: Loaded"],
  [1520, "info", "kernel", "Key type dns_resolver registered"],
  [1560, "info", "kernel", "IPI shorthand broadcast: enabled"],
  [1600, "info", "kernel", "sched_clock: Marking stable (1600013420, 0)->(1600013420, 0)"],
  [1640, "info", "kernel", "registered taskstats version 1"],
  [1680, "info", "kernel", "EXT4-fs (vda1): mounted filesystem with ordered data mode"],
  [1720, "info", "systemd", "systemd 254.6-kandelo running in system mode"],
  [1760, "info", "systemd", "Detected virtualization wasm-sandbox."],
  [1800, "info", "systemd", "Set hostname to <kandelo>."],
  [1840, "info", "systemd", "Queued start job for default target multi-user.target."],
  [1880, "ok", "systemd", "[  OK  ] Mounted /proc /sys /dev /run /tmp."],
  [1920, "ok", "systemd", "[  OK  ] Reached target Local File Systems."],
  [1960, "ok", "systemd", "[  OK  ] Started Journal Service."],
  [2000, "ok", "systemd", "[  OK  ] Started udev Kernel Device Manager."],
  [2050, "ok", "systemd", "[  OK  ] Started Permit User Sessions."],
  [2100, "ok", "systemd", "[  OK  ] Reached target Network."],
  [2150, "ok", "systemd", "[  OK  ] Started Kandelo Shell on tty1."],
  [2200, "info", "login", "kandelo login: user (auto)"],
  [2240, "info", "login", "Last login: never · system folded from URL b3:9f2a"],
];

// ── Shell session (typed on the Shell pane after boot) ─────────────────────

export type ShellSessionEntry =
  | { kind: "banner" }
  | { kind: "prompt" }
  | { kind: "cmd"; text: string }
  | { kind: "out"; text: string };

export const SHELL_SESSION: ShellSessionEntry[] = [
  { kind: "banner" },
  { kind: "prompt" },
  { kind: "cmd", text: "uname -a" },
  { kind: "out", text: "Linux kandelo 6.8.0-kandelo #1 SMP PREEMPT_DYNAMIC Mon May 11 2026 wasm32 GNU/Linux" },
  { kind: "prompt" },
  { kind: "cmd", text: "cat /proc/version_url" },
  { kind: "out", text: "kandelo.dev/c/b3_9f2a3b81d2c47f1e_8ed1f0c9a4_e7c2b1d8f6a3" },
  { kind: "prompt" },
  { kind: "cmd", text: 'echo "hello from a URL"' },
  { kind: "out", text: "hello from a URL" },
  { kind: "prompt" },
];

// ── Process table ──────────────────────────────────────────────────────────

export const PROCS: ProcessInfo[] = [
  { pid: 1, ppid: 0, user: "root", cmdline: "/sbin/init", state: "R", memory: "256.0M" },
  { pid: 2, ppid: 0, user: "root", cmdline: "[kthreadd]", state: "R", memory: "64.0M" },
  { pid: 8, ppid: 2, user: "root", cmdline: "[kworker/0:0H-events_highpri]", state: "R", memory: "64.0M" },
  { pid: 41, ppid: 2, user: "root", cmdline: "[ksoftirqd/0]", state: "R", memory: "64.0M" },
  { pid: 99, ppid: 2, user: "root", cmdline: "[rcu_sched]", state: "R", memory: "64.0M" },
  { pid: 142, ppid: 1, user: "root", cmdline: "/usr/lib/systemd/systemd-journald", state: "R", memory: "128.0M" },
  { pid: 188, ppid: 1, user: "root", cmdline: "/usr/lib/systemd/systemd-udevd", state: "R", memory: "128.0M" },
  { pid: 221, ppid: 1, user: "kvfs", cmdline: "kandelo-vfs --image b3:9f2a", state: "R", memory: "256.0M" },
  { pid: 234, ppid: 1, user: "root", cmdline: "cron", state: "R", memory: "128.0M" },
  { pid: 308, ppid: 1, user: "root", cmdline: "agetty --noclear tty1", state: "R", memory: "128.0M" },
  { pid: 412, ppid: 308, user: "user", cmdline: "-bash", state: "R", memory: "256.0M" },
  { pid: 614, ppid: 1, user: "user", cmdline: "kfb-compositor --mode rgb565", state: "R", memory: "512.0M" },
  { pid: 728, ppid: 614, user: "user", cmdline: "kclock --tz UTC", state: "R", memory: "128.0M" },
  { pid: 902, ppid: 412, user: "user", cmdline: "top -b -n 1", state: "R", memory: "128.0M" },
];

// ── VFS tree ───────────────────────────────────────────────────────────────

export type VfsNode =
  | { n: string; kind: "d"; mode: string; children: VfsNode[] }
  | { n: string; kind: Exclude<VfsKind, "d">; mode: string; size: string };

export const VFS_ROOT: VfsNode = {
  n: "/", kind: "d", mode: "drwxr-xr-x", children: [
    { n: "bin", kind: "d", mode: "drwxr-xr-x", children: [
      { n: "bash", kind: "f", size: "1.2M", mode: "-rwxr-xr-x" },
      { n: "ls", kind: "f", size: "142K", mode: "-rwxr-xr-x" },
      { n: "cat", kind: "f", size: "54K", mode: "-rwxr-xr-x" },
      { n: "top", kind: "f", size: "188K", mode: "-rwxr-xr-x" },
    ]},
    { n: "etc", kind: "d", mode: "drwxr-xr-x", children: [
      { n: "hostname", kind: "f", size: "8", mode: "-rw-r--r--" },
      { n: "os-release", kind: "f", size: "286", mode: "-rw-r--r--" },
      { n: "kandelo.toml", kind: "f", size: "1.4K", mode: "-rw-r--r--" },
    ]},
    { n: "home", kind: "d", mode: "drwxr-xr-x", children: [
      { n: "user", kind: "d", mode: "drwxr-xr-x", children: [
        { n: ".bashrc", kind: "f", size: "512", mode: "-rw-r--r--" },
        { n: "README.md", kind: "f", size: "1.1K", mode: "-rw-r--r--" },
        { n: "notes", kind: "d", mode: "drwxr-xr-x", children: [
          { n: "todo.txt", kind: "f", size: "208", mode: "-rw-r--r--" },
        ]},
      ]},
    ]},
    { n: "proc", kind: "d", mode: "dr-xr-xr-x", children: [
      { n: "cpuinfo", kind: "f", size: "4.1K", mode: "-r--r--r--" },
      { n: "meminfo", kind: "f", size: "1.2K", mode: "-r--r--r--" },
      { n: "version_url", kind: "f", size: "64", mode: "-r--r--r--" },
    ]},
    { n: "sys", kind: "d", mode: "dr-xr-xr-x", children: [] },
    { n: "tmp", kind: "d", mode: "drwxrwxrwt", children: [] },
    { n: "usr", kind: "d", mode: "drwxr-xr-x", children: [
      { n: "lib", kind: "d", mode: "drwxr-xr-x", children: [] },
      { n: "share", kind: "d", mode: "drwxr-xr-x", children: [] },
    ]},
    { n: "var", kind: "d", mode: "drwxr-xr-x", children: [
      { n: "log", kind: "d", mode: "drwxr-xr-x", children: [
        { n: "messages", kind: "f", size: "14.2K", mode: "-rw-r-----" },
        { n: "kandelo.log", kind: "f", size: "3.8K", mode: "-rw-r-----" },
      ]},
    ]},
    { n: "vmlinuz", kind: "f", size: "4.8M", mode: "-rw-r--r--" },
  ],
};

// ── Mounts ─────────────────────────────────────────────────────────────────

export const MOUNTS: MountInfo[] = [
  { source: "kandelo-vfs", target: "/", fs: "tmpfs", opts: "ro,relatime,verified=b3:9f2a" },
  { source: "proc", target: "/proc", fs: "proc", opts: "rw,nosuid,nodev,noexec,relatime" },
  { source: "sysfs", target: "/sys", fs: "sysfs", opts: "rw,nosuid,nodev,noexec,relatime" },
  { source: "devtmpfs", target: "/dev", fs: "devtmpfs", opts: "rw,nosuid,size=4096k,nr_inodes=4096" },
  { source: "tmpfs", target: "/tmp", fs: "tmpfs", opts: "rw,nosuid,nodev,size=16M" },
  { source: "tmpfs", target: "/run", fs: "tmpfs", opts: "rw,nosuid,nodev,size=2M" },
];

// ── Kernel state ───────────────────────────────────────────────────────────

export const KSTATE: KernelStateKV[] = [
  { k: "kernel.hostname", v: "kandelo" },
  { k: "kernel.version", v: "6.8.0-kandelo #1" },
  { k: "kernel.osrelease", v: "6.8.0-kandelo" },
  { k: "kernel.pid_max", v: "32768" },
  { k: "kernel.threads_max", v: "14820" },
  { k: "kernel.random.entropy_avail", v: "256" },
  { k: "vm.swappiness", v: "60" },
  { k: "vm.overcommit_memory", v: "0" },
  { k: "vm.dirty_ratio", v: "20" },
  { k: "net.core.somaxconn", v: "4096" },
  { k: "net.ipv4.ip_forward", v: "0" },
  { k: "fs.file-max", v: "524288" },
  { k: "fs.inotify.max_user_watches", v: "8192" },
  { k: "kandelo.image_hash", v: "b3:9f2a3b81d2c47f1e" },
  { k: "kandelo.url_size", v: "1284 bytes" },
  { k: "kandelo.boot_seed", v: "0x8ed1f0c9a4e7c2b1" },
];

// ── Syscalls ───────────────────────────────────────────────────────────────

export const SYSCALLS: SyscallEvent[] = [
  { t: "+0.000012", call: "execve", args: '"/bin/bash", ["bash"], 0x7ffd…', ret: "0" },
  { t: "+0.000048", call: "brk", args: "NULL", ret: "0x55a4f8" },
  { t: "+0.000061", call: "arch_prctl", args: "0x3001, 0x7ffd…", ret: "-1 EINVAL" },
  { t: "+0.000094", call: "openat", args: 'AT_FDCWD, "/etc/ld.so.cache", O_RDONLY', ret: "3" },
  { t: "+0.000118", call: "fstat", args: "3, {st_mode=S_IFREG|0644, st_size=20136}", ret: "0" },
  { t: "+0.000140", call: "mmap", args: "NULL, 20136, PROT_READ, MAP_PRIVATE, 3, 0", ret: "0x7f3a…" },
  { t: "+0.000164", call: "close", args: "3", ret: "0" },
  { t: "+0.000182", call: "openat", args: 'AT_FDCWD, "/lib/libc.so.6", O_RDONLY', ret: "3" },
  { t: "+0.000201", call: "read", args: '3, "\\177ELF\\2\\1\\1\\3"…', ret: "832" },
  { t: "+0.000234", call: "mmap", args: "NULL, 2138472, PROT_READ|PROT_EXEC", ret: "0x7f3a…" },
  { t: "+0.001012", call: "getpid", args: "", ret: "412" },
  { t: "+0.001088", call: "getuid", args: "", ret: "1000" },
  { t: "+0.001140", call: "rt_sigaction", args: "SIGINT, {sa_handler=0x4045a0}", ret: "0" },
  { t: "+0.002201", call: "write", args: '1, "hello from a URL\\n", 17', ret: "17" },
  { t: "+0.002284", call: "exit_group", args: "0", ret: "?" },
];

// ── Memory map ─────────────────────────────────────────────────────────────

export const MEMMAP: MemMapEntry[] = [
  { range: "00400000-005c2000", perm: "r-xp", offset: "00000000", size: "1.8M", path: "/bin/bash" },
  { range: "007c1000-007cb000", perm: "r--p", offset: "001c1000", size: "40K", path: "/bin/bash" },
  { range: "007cb000-007d6000", perm: "rw-p", offset: "001cb000", size: "44K", path: "/bin/bash" },
  { range: "01a4f000-01af1000", perm: "rw-p", offset: "00000000", size: "648K", path: "[heap]" },
  { range: "7f3a0000-7f3a8000", perm: "r-xp", offset: "00000000", size: "32K", path: "/lib/ld-linux.so.2" },
  { range: "7f3a8000-7f3aa000", perm: "r--p", offset: "00008000", size: "8K", path: "/lib/ld-linux.so.2" },
  { range: "7f3aa000-7f3ad000", perm: "rw-p", offset: "0000a000", size: "12K", path: "/lib/ld-linux.so.2" },
  { range: "7f3b0000-7f5b8000", perm: "r-xp", offset: "00000000", size: "2.0M", path: "/lib/libc.so.6" },
  { range: "7f5b8000-7f5bc000", perm: "r--p", offset: "00208000", size: "16K", path: "/lib/libc.so.6" },
  { range: "7f5bc000-7f5c0000", perm: "rw-p", offset: "0020c000", size: "16K", path: "/lib/libc.so.6" },
  { range: "7ffe2000-7ffe4000", perm: "rw-p", offset: "00000000", size: "8K", path: "[stack]" },
  { range: "7ffe9000-7ffeb000", perm: "r--p", offset: "00000000", size: "8K", path: "[vvar]" },
  { range: "7ffeb000-7ffed000", perm: "r-xp", offset: "00000000", size: "8K", path: "[vdso]" },
];

// ── Preset library ─────────────────────────────────────────────────────────

export interface Preset {
  id: string;
  title: string;
  summary: string;
  base: string;
  packages: string[];
  accent: string;
  glyph: string;
  bootCommand: string[];
  estimatedUrlBytes: number;
}

export const PRESET_LIBRARY: Preset[] = [
  { id: "shell", title: "Bare shell", summary: "Bash, dash, coreutils, and the full utility set from the shell demo.",
    base: "kandelo:shell@abi8",
    packages: ["bash@local", "dash@local", "coreutils@local", "grep@local", "sed@local", "curl@local", "git@local", "nano@local"],
    accent: "#dc6529", glyph: "sh", bootCommand: ["bash", "-l", "-i"], estimatedUrlBytes: 312 },
  { id: "nginx", title: "nginx", summary: "Static HTTP service supervised by dinit and exposed through the browser bridge.",
    base: "kandelo:shell@abi8",
    packages: ["dinit@local", "nginx@local", "bash@local", "coreutils@local"],
    accent: "#3a8f41", glyph: "nx", bootCommand: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl"], estimatedUrlBytes: 756 },
  { id: "nginx-php", title: "nginx + PHP", summary: "nginx forwarding through FastCGI to PHP-FPM.",
    base: "kandelo:shell@abi8",
    packages: ["dinit@local", "nginx@local", "php-fpm@local", "bash@local", "coreutils@local"],
    accent: "#6b63a6", glyph: "php", bootCommand: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl"], estimatedUrlBytes: 944 },
  { id: "wordpress-sqlite", title: "WordPress SQLite", summary: "WordPress on nginx + PHP-FPM with the SQLite database plugin.",
    base: "kandelo:shell@abi8",
    packages: ["dinit@local", "nginx@local", "php-fpm@local", "wordpress@local", "sqlite@local", "bash@local", "coreutils@local"],
    accent: "#21759b", glyph: "wp", bootCommand: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl"], estimatedUrlBytes: 1284 },
  { id: "wordpress-mariadb", title: "WordPress MariaDB", summary: "WordPress on nginx + PHP-FPM with MariaDB.",
    base: "kandelo:shell@abi8",
    packages: ["dinit@local", "nginx@local", "php-fpm@local", "mariadb@local", "wordpress@local", "bash@local", "coreutils@local"],
    accent: "#5f8f73", glyph: "wp+", bootCommand: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl"], estimatedUrlBytes: 1442 },
  { id: "doom", title: "fbDOOM", summary: "id Software's DOOM rendering directly to /dev/fb0.",
    base: "kandelo:shell@abi8",
    packages: ["fbdoom@local", "doom-shareware@local", "bash@local", "coreutils@local"],
    accent: "#b5301c", glyph: "D", bootCommand: ["/usr/games/fbdoom"], estimatedUrlBytes: 1018 },
];

// ── Current-machine descriptor template ────────────────────────────────────

export const CURRENT_DESCRIPTOR_TEMPLATE: BootDescriptor = {
  version: 1,
  id: "b3-9f2a",
  title: "Untitled machine",
  base: "kandelo:shell@abi8",
  runtime: {
    arch: "wasm32",
    kernel: "kernel@sha256:9f2a3b81d2c47f1e",
    memoryPages: 4096,
    features: ["shared-array-buffer", "pty", "tcp-bridge"],
    time: "real",
  },
  packages: [
    "dash@sha256:f4e2c8a91b3d4e5f6a7b8c9d0e1f2a3b",
    "coreutils@sha256:9a3c0e1f2a3b4c5d6e7f8a9b0c1d2e3f",
    "less@sha256:b711c8a91b3d4e5f6a7b8c9d0e1f2a3b",
  ],
  mounts: [
    { path: "/", source: "image", ref: "rootfs@sha256:9f2a3b81", readonly: true },
    { path: "/usr", source: "package-layer", ref: "coreutils@sha256:9a3c0e1f", readonly: true },
    { path: "/home/user", source: "inline-overlay", data: "a3qF7Yk2…" },
    { path: "/tmp", source: "scratch", ephemeral: true },
  ],
  boot: {
    argv: ["/bin/sh"],
    cwd: "/home/user",
    env: { HOME: "/home/user", PATH: "/bin:/usr/bin", TERM: "xterm-256color" },
  },
  caps: { network: true, persistence: false, clipboard: true, signedSources: ["kandelo-official"] },
};
