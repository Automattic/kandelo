// Device-table-style manifest parser for mkrootfs.
//
// Grammar (one entry per non-blank, non-comment line):
//
//   <path>  <type>  <mode>  [<uid>]  [<gid>]  [key=value ...]
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
// Comments start with `#` and run to end of line. Leading/trailing
// whitespace on each line is stripped. Blank lines are skipped.
//
// The `archive` directive is parsed in Task 2.3; this parser rejects it.

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

export type ManifestEntry = ManifestNode;

const VALID_TYPES = new Set<NodeType>(["d", "f", "l", "c", "b"]);

export function parseManifest(text: string, sourcePath?: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/(^|\s)#.*$/, "").trim();
    if (!stripped) continue;
    const lineNumber = i + 1;
    const tokens = stripped.split(/\s+/);
    if (tokens[0] === "archive") {
      throw err(lineNumber, sourcePath, "archive directive not yet implemented (deferred to Task 2.3)");
    }
    entries.push(parseNode(tokens, lineNumber, sourcePath));
  }
  return entries;
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
