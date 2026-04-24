// Device-table-style manifest parser for mkrootfs.
//
// Grammar (one entry per non-blank, non-comment line):
//
//   <path>  <type>  <mode>  [<uid>]  [<gid>]  [key=value ...]
//   archive  key=value  [key=value ...]
//
// Where:
//   <type>   one of d (dir), f (file), l (symlink), c (char dev), b (block dev)
//   <mode>   octal, optional leading 0
//   <uid>/<gid>  decimal; both default to 0
//
// Per-type trailing key=value fields:
//   f   src=<repo-relative path>       — override implicit sourceTree/<path>
//   l   target=<symlink target path>
//   c|b major=<n>  minor=<n>
//
// Archive directive fields (url= required):
//   url=<repo-relative zip path>       — archive to ingest
//   base=<mount prefix>                — default "/"; entries are placed under base
//   fmode=<octal>                      — per-archive file mode (default 0644)
//   dmode=<octal>                      — per-archive dir mode  (default 0755)
//   uid=<n>  gid=<n>                   — owner applied to all entries (default 0:0)
//
// Comments start with `#` and run to end of line. Leading/trailing
// whitespace on each line is stripped. Blank lines are skipped.

export type NodeType = "d" | "f" | "l" | "c" | "b";

export interface ManifestNode {
  kind: "node";
  path: string;
  type: NodeType;
  mode: number;
  uid: number;
  gid: number;
  src?: string;
  target?: string;
  major?: number;
  minor?: number;
}

export interface ManifestArchive {
  kind: "archive";
  url: string;
  base: string;
  fmode: number;
  dmode: number;
  uid: number;
  gid: number;
}

export type ManifestEntry = ManifestNode | ManifestArchive;

export function parseManifest(src: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.replace(/#.*$/, "").trim();
    if (!stripped) continue;

    const tokens = stripped.split(/\s+/);
    if (tokens[0] === "archive") {
      entries.push(parseArchive(tokens.slice(1), i + 1));
      continue;
    }
    entries.push(parseNode(tokens, i + 1));
  }
  return entries;
}

const VALID_TYPES = new Set(["d", "f", "l", "c", "b"]);

function parseNode(tokens: string[], lineNumber: number): ManifestNode {
  if (tokens.length < 3) {
    throw new Error(`manifest line ${lineNumber}: expected at least <path> <type> <mode>`);
  }
  const [path, type, modeStr, uidStr, gidStr, ...extras] = tokens;
  if (!VALID_TYPES.has(type)) {
    throw new Error(`manifest line ${lineNumber}: unknown type "${type}"`);
  }
  const node: ManifestNode = {
    kind: "node",
    path,
    type: type as NodeType,
    mode: parseOctal(modeStr, lineNumber),
    uid: uidStr !== undefined ? parseDecimal(uidStr, lineNumber) : 0,
    gid: gidStr !== undefined ? parseDecimal(gidStr, lineNumber) : 0,
  };
  for (const extra of extras) {
    const eq = extra.indexOf("=");
    if (eq < 0) {
      throw new Error(`manifest line ${lineNumber}: bad extra "${extra}"`);
    }
    const key = extra.slice(0, eq);
    const value = extra.slice(eq + 1);
    switch (key) {
      case "src":    node.src = value; break;
      case "target": node.target = value; break;
      case "major":  node.major = parseDecimal(value, lineNumber); break;
      case "minor":  node.minor = parseDecimal(value, lineNumber); break;
      default:
        throw new Error(`manifest line ${lineNumber}: unknown field "${key}"`);
    }
  }
  return node;
}

function parseArchive(tokens: string[], lineNumber: number): ManifestArchive {
  const archive: ManifestArchive = {
    kind: "archive",
    url: "",
    base: "/",
    fmode: 0o644,
    dmode: 0o755,
    uid: 0,
    gid: 0,
  };
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq < 0) {
      throw new Error(`manifest line ${lineNumber}: bad archive field "${tok}"`);
    }
    const key = tok.slice(0, eq);
    const value = tok.slice(eq + 1);
    switch (key) {
      case "url":    archive.url = value; break;
      case "base":   archive.base = value; break;
      case "fmode":  archive.fmode = parseOctal(value, lineNumber); break;
      case "dmode":  archive.dmode = parseOctal(value, lineNumber); break;
      case "uid":    archive.uid = parseDecimal(value, lineNumber); break;
      case "gid":    archive.gid = parseDecimal(value, lineNumber); break;
      default:
        throw new Error(`manifest line ${lineNumber}: unknown archive field "${key}"`);
    }
  }
  if (!archive.url) {
    throw new Error(`manifest line ${lineNumber}: archive requires url=`);
  }
  return archive;
}

function parseOctal(s: string, lineNumber: number): number {
  if (!/^[0-7]+$/.test(s)) {
    throw new Error(`manifest line ${lineNumber}: invalid octal "${s}"`);
  }
  return parseInt(s, 8);
}

function parseDecimal(s: string, lineNumber: number): number {
  if (!/^[0-9]+$/.test(s)) {
    throw new Error(`manifest line ${lineNumber}: invalid integer "${s}"`);
  }
  return parseInt(s, 10);
}
