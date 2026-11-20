// `delo write <path> <computer> [--key value]`: one file of a computer's
// pipeline, from flags named after the keys of a file object (see
// registry.ts). A new path with no source and no other type is an empty
// file; typed in the input, a line with no source opens the editor instead,
// one pane per option of the file's type, filled from the file and the
// line. A rerun on a path the pipeline writes merges only the given flags.
// A rerun with another type, or a source the file has not, replaces the file
// with exactly the given flags, once the visitor answers Y. The registry
// parser checks the result. The dropdown offers the flags the file's kind
// takes. Kept pure, so the rules are testable without a page.

import type { DeloFlag } from "./command";
import { deloFileKind, deloImageSource, FILE_KEYS, parseDeloFile, type DeloFile, type DeloPipeline } from "./registry";

/** Every flag of `delo write`, with what it gives the file. */
export const DELO_WRITE_FLAGS: Record<string, string> = {
  type: "file (the default), directory or symlink",
  content: "the text of a regular file",
  from: "a path under the binaries root, an https URL, <image>:<path>, or the path a symlink points to",
  lazy: "the computer downloads the bytes when a program first reads the file",
  mode: "an octal mode such as 755; default 644, 755 for a directory",
  owner: "the uid:gid of a directory; default 0:0",
};

export const DELO_FLAGS_ALONE = ["lazy"];

/** What the dropdown offers on a path no file of the pipeline writes, before a type or a source. */
const NEW_FLAGS = ["type", "content", "from"];

const SOURCES = ["content", "from"];

/** A file object the flags describe, before the parser checks it. */
type Fields = Record<string, unknown>;

interface DeloWrite {
  file: DeloFile;
  /** Whether the file replaces one of another kind. */
  replaces: boolean;
}

/** The file `pipeline` writes at `path`, or undefined. */
export function deloPipelineFile(pipeline: DeloPipeline, path: string): DeloFile | undefined {
  const files = pipeline.files.filter((file) => file.to === path);
  if (files.length > 1) throw new Error(`the pipeline has ${files.length} files at ${path}. Remove them with delo remove ${path}, then write one.`);
  return files[0];
}

/** The file `delo write` makes at `path` from `flags`, on top of `existing`, checked by the registry parser. */
export function deloWrittenFile(existing: DeloFile | undefined, path: string, flags: readonly DeloFlag[]): DeloWrite {
  if (!path.startsWith("/")) throw new Error(`${path} is not an absolute path. Did you mean /${path}?`);
  const given = fieldsOf(flags);
  const empty = !SOURCES.some((key) => key in given) && typeOf(given) === "file";
  if (existing === undefined) return { file: parseDeloFile({ to: path, ...(empty ? { content: "" } : {}), ...given }, path), replaces: false };
  if (replaces(existing, given)) return { file: parseDeloFile({ to: path, ...given }, path), replaces: true };
  if (flags.length === 0) throw new Error(`the pipeline already writes ${path}. Give a flag to change it.`);
  return { file: parseDeloFile({ ...existing, ...given }, path), replaces: false };
}

/** Whether a typed `delo write` opens the editor: the line gives no source. */
export function deloWriteEdits(flags: readonly DeloFlag[]): boolean {
  const given = fieldsOf(flags);
  return !SOURCES.some((key) => key in given);
}

/** The value of every option in the editor; an empty string or false leaves the option out of the file. */
export interface DeloEditorFields {
  type: DeloEditorType;
  content: string;
  from: string;
  lazy: boolean;
  mode: string;
  owner: string;
}

/** The options the editor shows for each type, after `type` itself. */
export const DELO_EDITOR_KEYS = {
  file: ["content", "from", "lazy", "mode"],
  directory: ["from", "lazy", "mode", "owner"],
  symlink: ["from"],
} as const;

export type DeloEditorType = keyof typeof DELO_EDITOR_KEYS;

const isEditorType = (type: unknown): type is DeloEditorType => typeof type === "string" && type in DELO_EDITOR_KEYS;

/** The editor's first values: the file at the path, unless the line changes its kind, then the line's flags. */
export function deloEditorFields(existing: DeloFile | undefined, flags: readonly DeloFlag[]): DeloEditorFields {
  const given = fieldsOf(flags);
  const kept = existing === undefined || replaces(existing, given) ? {} : existing as Fields;
  const fields: Fields = { ...kept, ...given };
  const type = typeOf(fields);
  if (!isEditorType(type)) throw new Error(`--type must be one of ${Object.keys(DELO_EDITOR_KEYS).join(", ")}`);
  const text = (key: string) => typeof fields[key] === "string" ? fields[key] as string : "";
  return { type, content: text("content"), from: text("from"), lazy: fields.lazy === true, mode: text("mode"), owner: text("owner") };
}

/** The file the editor writes at `path`: the options its type shows, checked by the registry parser. A regular file with no source is empty. */
export function deloEditedFile(path: string, fields: DeloEditorFields): DeloFile {
  const file: Fields = { to: path, ...(fields.type === "file" ? {} : { type: fields.type }) };
  for (const key of DELO_EDITOR_KEYS[fields.type]) {
    if (fields[key] === "" || fields[key] === false) continue;
    file[key] = fields[key];
  }
  if (fields.type === "file" && !SOURCES.some((key) => key in file)) file.content = "";
  return parseDeloFile(file, path);
}

/** The flags the dropdown offers after `flags`: the keys the file's kind
 *  takes that are not given yet. A new directory also offers `from`, its
 *  archive. Before a type or a source on a new path, the flags that choose
 *  the kind. */
export function deloWriteOffers(existing: DeloFile | undefined, flags: readonly DeloFlag[]): string[] {
  const given: Fields = Object.fromEntries(flags.map(({ key, value }) => [key, value ?? true]));
  const kept = existing !== undefined && !replaces(existing, given);
  const fields = kept ? existing as Fields : given;
  const kind = deloFileKind(fields);
  const image = kind === "from" && typeof fields.from === "string" && deloImageSource(fields.from) !== null;
  const keys = kind === undefined ? NEW_FLAGS
    : image ? ["from"]
    : kind === "directory" && !kept ? ["from", ...FILE_KEYS.directory]
    : FILE_KEYS[kind];
  return keys.filter((key) => key in DELO_WRITE_FLAGS && !(key in given));
}

const typeOf = (fields: Fields) => fields.type ?? "file";

/** Whether `given` changes the kind of `existing`: another type, or a source it has not. */
const replaces = (existing: DeloFile, given: Fields) =>
  ("type" in given && typeOf(given) !== typeOf(existing)) || SOURCES.some((key) => key in given && !(key in existing));

function fieldsOf(flags: readonly DeloFlag[]): Fields {
  const fields: Fields = {};
  for (const { key, value } of flags) {
    if (!(key in DELO_WRITE_FLAGS)) throw new Error(`--${key} is not a flag of delo write: ${Object.keys(DELO_WRITE_FLAGS).map((flag) => `--${flag}`).join(" ")}`);
    if (DELO_FLAGS_ALONE.includes(key)) {
      if (value !== null) throw new Error(`--${key} takes no value`);
      fields[key] = true;
      continue;
    }
    if (value === null) throw new Error(`--${key} takes a value`);
    fields[key] = value;
  }
  return fields;
}
