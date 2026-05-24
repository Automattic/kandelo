// Device-table-style manifest parser for mkrootfs.
//
// Grammar (one entry per non-blank, non-comment line):
//
//   <path>  <type>  <mode>  [<uid>]  [<gid>]  [key=value ...]
//   archive  url=<path>  [base=/prefix] [fmode=<octal>] [dmode=<octal>] [uid=<n>] [gid=<n>]
//
// Where:
//   <type>   one of d (dir), f (file), l (symlink), c (char dev), b (block dev)
//   <mode>   octal, optional leading 0
//   <uid>/<gid>  decimal; both default to 0
//
// Per-type trailing key=value fields:
//   f   src=<repo-relative path>       — override implicit sourceTree/<path>
//   l   target=<symlink target path>   — required
//   c|b major=<n>  minor=<n>           — both required
//
// Archive directive fields:
//   url=<path or URL>                  — required; archive to ingest (zip/tar)
//   base=<absolute mount prefix>       — defaults to "/"; must be absolute
//   fmode=<octal>                      — file mode for archive entries (default 0644)
//   dmode=<octal>                      — directory mode (default 0755)
//   uid=<n>  gid=<n>                   — owner applied to all entries (default 0:0)
//
// Comments start with `#` and run to end of line. The `#` is only
// treated as a comment when it appears at the start of a line or is
// preceded by whitespace, so values like `url=./x.zip#frag` are
// preserved. Leading/trailing whitespace on each line is stripped.
// Blank lines are skipped.

export type NodeType = "d" | "f" | "l" | "c" | "b";

export interface ManifestNode {
  kind: "node";
  path: string;
  type: NodeType;
  mode: number;
  uid: number;
  gid: number;
  /** 1-indexed line number in the source manifest; used for downstream error reporting. */
  lineNumber: number;
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
  /** 1-indexed line number in the source manifest; used for downstream error reporting. */
  lineNumber: number;
}

export type ManifestEntry = ManifestNode | ManifestArchive;

// The literal token that introduces an archive directive line.
const ARCHIVE_DIRECTIVE = "archive";

const VALID_TYPES = new Set<NodeType>(["d", "f", "l", "c", "b"]);

export function parseManifest(text: string, sourcePath?: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/(^|\s)#.*$/, "").trim();
    if (!stripped) continue;
    const lineNumber = i + 1;
    const tokens = stripped.split(/\s+/);
    if (tokens[0] === ARCHIVE_DIRECTIVE) {
      entries.push(parseArchive(tokens.slice(1), lineNumber, sourcePath));
      continue;
    }
    entries.push(parseNode(tokens, lineNumber, sourcePath));
  }
  return entries;
}

function parseArchive(
  tokens: string[],
  lineNumber: number,
  sourcePath: string | undefined,
): ManifestArchive {
  const archive: ManifestArchive = {
    kind: "archive",
    url: "",
    base: "/",
    fmode: 0o644,
    dmode: 0o755,
    uid: 0,
    gid: 0,
    lineNumber,
  };
  let urlSeen = false;
  let baseSeen = false;
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq <= 0) {
      throw err(lineNumber, sourcePath, `bad archive field "${tok}" (expected key=value)`);
    }
    const key = tok.slice(0, eq);
    const value = tok.slice(eq + 1);
    switch (key) {
      case "url":
        archive.url = value;
        urlSeen = true;
        break;
      case "base":
        archive.base = value;
        baseSeen = true;
        break;
      case "fmode":
        archive.fmode = parseOctal(value, lineNumber, sourcePath, "fmode");
        break;
      case "dmode":
        archive.dmode = parseOctal(value, lineNumber, sourcePath, "dmode");
        break;
      case "uid":
        archive.uid = parseDecimal(value, lineNumber, sourcePath, "uid");
        break;
      case "gid":
        archive.gid = parseDecimal(value, lineNumber, sourcePath, "gid");
        break;
      default:
        throw err(lineNumber, sourcePath, `unknown archive field "${key}"`);
    }
  }
  if (!urlSeen) {
    throw err(lineNumber, sourcePath, "archive requires url=");
  }
  if (archive.url === "") {
    throw err(lineNumber, sourcePath, "archive has empty url=");
  }
  if (baseSeen && archive.base === "") {
    throw err(lineNumber, sourcePath, "archive has empty base=");
  }
  if (!archive.base.startsWith("/")) {
    throw err(
      lineNumber,
      sourcePath,
      `archive base= must be absolute, got "${archive.base}"`,
    );
  }
  return archive;
}

function parseNode(tokens: string[], lineNumber: number, sourcePath: string | undefined): ManifestNode {
  if (tokens.length < 3) {
    throw err(lineNumber, sourcePath, `expected at least <path> <type> <mode>, got "${tokens.join(" ")}"`);
  }
  const [path, type, modeStr, uidStr, gidStr, ...extras] = tokens;
  if (!path.startsWith("/")) {
    throw err(lineNumber, sourcePath, `path must be absolute, got "${path}"`);
  }
  if (!VALID_TYPES.has(type as NodeType)) {
    throw err(lineNumber, sourcePath, `unknown type "${type}" (expected d, f, l, c, or b)`);
  }
  const node: ManifestNode = {
    kind: "node",
    path,
    type: type as NodeType,
    mode: parseOctal(modeStr, lineNumber, sourcePath, "mode"),
    uid: uidStr !== undefined ? parseDecimal(uidStr, lineNumber, sourcePath, "uid") : 0,
    gid: gidStr !== undefined ? parseDecimal(gidStr, lineNumber, sourcePath, "gid") : 0,
    lineNumber,
  };
  for (const extra of extras) {
    const eq = extra.indexOf("=");
    if (eq <= 0) {
      throw err(lineNumber, sourcePath, `bad extra field "${extra}" (expected key=value)`);
    }
    const key = extra.slice(0, eq);
    const value = extra.slice(eq + 1);
    switch (key) {
      case "src": node.src = value; break;
      case "target": node.target = value; break;
      case "major": node.major = parseDecimal(value, lineNumber, sourcePath, "major"); break;
      case "minor": node.minor = parseDecimal(value, lineNumber, sourcePath, "minor"); break;
      default:
        throw err(lineNumber, sourcePath, `unknown field "${key}"`);
    }
  }
  validateRequiredExtras(node, lineNumber, sourcePath);
  return node;
}

function validateRequiredExtras(node: ManifestNode, lineNumber: number, sourcePath: string | undefined): void {
  if (node.type === "l") {
    if (node.target === undefined) {
      throw err(lineNumber, sourcePath, `symlink "${node.path}" requires target=`);
    }
    if (node.target === "") {
      throw err(lineNumber, sourcePath, `symlink "${node.path}" has empty target=`);
    }
  }
  if (node.src === "") {
    throw err(lineNumber, sourcePath, `"${node.path}" has empty src=`);
  }
  if (node.type === "c" || node.type === "b") {
    if (node.major === undefined) {
      throw err(lineNumber, sourcePath, `device "${node.path}" requires major=`);
    }
    if (node.minor === undefined) {
      throw err(lineNumber, sourcePath, `device "${node.path}" requires minor=`);
    }
  }
}

function parseOctal(s: string, lineNumber: number, sourcePath: string | undefined, field: string): number {
  if (!/^[0-7]+$/.test(s)) {
    throw err(lineNumber, sourcePath, `invalid octal ${field} "${s}"`);
  }
  return parseInt(s, 8);
}

function parseDecimal(s: string, lineNumber: number, sourcePath: string | undefined, field: string): number {
  if (!/^[0-9]+$/.test(s)) {
    throw err(lineNumber, sourcePath, `invalid integer ${field} "${s}"`);
  }
  return parseInt(s, 10);
}

function err(lineNumber: number, sourcePath: string | undefined, msg: string): Error {
  const prefix = sourcePath ? `${sourcePath} line ${lineNumber}` : `manifest line ${lineNumber}`;
  return new Error(`${prefix}: ${msg}`);
}
