/**
 * GNU coreutils multicall binary command names.
 *
 * Shared by VFS image builders and browser runtime setup so both sides
 * create the same /bin and /usr/bin symlink set for coreutils.
 */
export const COREUTILS_NAMES = [
  "arch", "b2sum", "base32", "base64", "basename", "basenc", "cat",
  "chcon", "chgrp", "chmod", "chown", "chroot", "cksum", "comm", "cp",
  "csplit", "cut", "date", "dd", "df", "dir", "dircolors", "dirname",
  "du", "echo", "env", "expand", "expr", "factor", "false", "fmt",
  "fold", "groups", "head", "hostid", "id", "install", "join", "link",
  "ln", "logname", "ls", "md5sum", "mkdir", "mkfifo", "mknod", "mktemp",
  "mv", "nice", "nl", "nohup", "nproc", "numfmt", "od", "paste",
  "pathchk", "pr", "printenv", "printf", "ptx", "pwd", "readlink",
  "realpath", "rm", "rmdir", "runcon", "seq", "sha1sum", "sha224sum",
  "sha256sum", "sha384sum", "sha512sum", "shred", "shuf", "sleep",
  "sort", "split", "stat", "stty", "sum", "sync", "tac", "tail",
  "tee", "test", "timeout", "touch", "tr", "true", "truncate", "tsort",
  "tty", "uname", "unexpand", "uniq", "unlink", "vdir", "wc", "whoami",
  "yes",
] as const;

export interface ShellLazyBinarySpec {
  id: string;
  resolverPath: string;
  vfsPath: string;
  symlinks: readonly string[];
}

export const SHELL_LAZY_URL_PREFIX = "kandelo-lazy:";

export function shellLazyPlaceholderUrl(spec: ShellLazyBinarySpec): string {
  return `${SHELL_LAZY_URL_PREFIX}${spec.resolverPath}`;
}

export const SHELL_LAZY_BINARY_SPECS = [
  {
    id: "coreutils",
    resolverPath: "programs/coreutils.wasm",
    vfsPath: "/bin/coreutils",
    symlinks: [...COREUTILS_NAMES, "["].flatMap((n) => [`/bin/${n}`, `/usr/bin/${n}`]),
  },
  {
    id: "grep",
    resolverPath: "programs/grep.wasm",
    vfsPath: "/usr/bin/grep",
    symlinks: ["/bin/grep", "/usr/bin/egrep", "/bin/egrep", "/usr/bin/fgrep", "/bin/fgrep"],
  },
  {
    id: "sed",
    resolverPath: "programs/sed.wasm",
    vfsPath: "/usr/bin/sed",
    symlinks: ["/bin/sed"],
  },
  { id: "bc", resolverPath: "programs/bc.wasm", vfsPath: "/usr/bin/bc", symlinks: ["/bin/bc"] },
  { id: "file", resolverPath: "programs/file/file.wasm", vfsPath: "/usr/bin/file", symlinks: ["/bin/file"] },
  { id: "less", resolverPath: "programs/less.wasm", vfsPath: "/usr/bin/less", symlinks: ["/bin/less"] },
  { id: "m4", resolverPath: "programs/m4.wasm", vfsPath: "/usr/bin/m4", symlinks: ["/bin/m4"] },
  { id: "make", resolverPath: "programs/make.wasm", vfsPath: "/usr/bin/make", symlinks: ["/bin/make"] },
  { id: "tar", resolverPath: "programs/tar.wasm", vfsPath: "/usr/bin/tar", symlinks: ["/bin/tar"] },
  { id: "curl", resolverPath: "programs/curl.wasm", vfsPath: "/usr/bin/curl", symlinks: ["/bin/curl"] },
  {
    id: "netcat",
    resolverPath: "programs/nc.wasm",
    vfsPath: "/usr/bin/nc",
    symlinks: ["/bin/nc", "/usr/bin/netcat", "/bin/netcat"],
  },
  { id: "wget", resolverPath: "programs/wget.wasm", vfsPath: "/usr/bin/wget", symlinks: ["/bin/wget"] },
  { id: "git", resolverPath: "programs/git/git.wasm", vfsPath: "/usr/bin/git", symlinks: ["/bin/git"] },
  {
    id: "git-remote-http",
    resolverPath: "programs/git/git-remote-http.wasm",
    vfsPath: "/usr/bin/git-remote-http",
    symlinks: ["/usr/bin/git-remote-https", "/usr/bin/git-remote-ftp", "/usr/bin/git-remote-ftps"],
  },
  {
    id: "gzip",
    resolverPath: "programs/gzip.wasm",
    vfsPath: "/usr/bin/gzip",
    symlinks: ["/bin/gzip", "/usr/bin/gunzip", "/bin/gunzip", "/usr/bin/zcat", "/bin/zcat"],
  },
  {
    id: "bzip2",
    resolverPath: "programs/bzip2.wasm",
    vfsPath: "/usr/bin/bzip2",
    symlinks: ["/bin/bzip2", "/usr/bin/bunzip2", "/bin/bunzip2", "/usr/bin/bzcat", "/bin/bzcat"],
  },
  {
    id: "xz",
    resolverPath: "programs/xz.wasm",
    vfsPath: "/usr/bin/xz",
    symlinks: [
      "/bin/xz", "/usr/bin/unxz", "/bin/unxz", "/usr/bin/xzcat", "/bin/xzcat",
      "/usr/bin/lzma", "/bin/lzma", "/usr/bin/unlzma", "/bin/unlzma", "/usr/bin/lzcat", "/bin/lzcat",
    ],
  },
  {
    id: "zstd",
    resolverPath: "programs/zstd.wasm",
    vfsPath: "/usr/bin/zstd",
    symlinks: ["/bin/zstd", "/usr/bin/unzstd", "/bin/unzstd", "/usr/bin/zstdcat", "/bin/zstdcat"],
  },
  { id: "zip", resolverPath: "programs/zip.wasm", vfsPath: "/usr/bin/zip", symlinks: ["/bin/zip"] },
  {
    id: "unzip",
    resolverPath: "programs/unzip/unzip.wasm",
    vfsPath: "/usr/bin/unzip",
    symlinks: ["/bin/unzip", "/usr/bin/zipinfo", "/bin/zipinfo"],
  },
  {
    id: "funzip",
    resolverPath: "programs/unzip/funzip.wasm",
    vfsPath: "/usr/bin/funzip",
    symlinks: ["/bin/funzip"],
  },
  { id: "lsof", resolverPath: "programs/lsof.wasm", vfsPath: "/usr/bin/lsof", symlinks: ["/bin/lsof"] },
  { id: "nano", resolverPath: "programs/nano.wasm", vfsPath: "/usr/bin/nano", symlinks: ["/bin/nano"] },
] as const satisfies readonly ShellLazyBinarySpec[];

export const NODE_LAZY_BINARY_SPEC = {
  id: "node",
  resolverPath: "programs/node.wasm",
  vfsPath: "/usr/bin/node",
  symlinks: ["/bin/node", "/usr/local/bin/node"],
} as const satisfies ShellLazyBinarySpec;
