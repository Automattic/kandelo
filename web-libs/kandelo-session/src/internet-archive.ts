// The Internet Archive as a source of files for a machine's library.
//
// Search (advancedsearch.php) and item metadata (/metadata/<id>) are public
// JSON endpoints that send CORS headers, so they are fetched directly. File
// bytes live on download hosts that send no CORS headers, so every byte read
// goes through a caller-provided fetch, which in the browser is the CORS
// proxy. Nothing here knows what the files are: queries come from the image's
// `library` block, and the caller decides which names it can load.
//
// Everything the Archive returns is untrusted: identifiers, file names, the
// download host and directory are validated before they are used to build a
// URL, JSON bodies are size-capped while streaming, and a file's bytes are
// capped by the caller before a single byte is buffered past the cap.

import type { BootInputResolver } from "./boot-inputs";
import type { BootJsonValue } from "./kernel-host";
import {
  extractZipEntryBounded,
  fetchZipCentralDirectory,
  fetchZipMember,
  parseZipCentralDirectory,
  type RemoteZipDirectory,
  type ZipEntry,
} from "../../../host/src/vfs/zip";

export type ArchiveFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ArchiveSearchItem {
  identifier: string;
  title: string;
  creator?: string;
  downloads?: number;
}

export interface ArchiveSearchPage {
  items: ArchiveSearchItem[];
  /** Total matches the Archive reports, for paging. */
  total: number;
}

export interface ArchiveFile {
  name: string;
  size?: number;
  format?: string;
}

export interface ArchiveItem {
  identifier: string;
  title: string;
  server: string;
  directory: string;
  files: ArchiveFile[];
}

/**
 * Where one file of an item is: the file itself, one member of a ZIP file,
 * or one member (`inner`) of a ZIP that is itself a member of a ZIP file.
 * Collections of games are often a ZIP of per-game ZIPs.
 */
export interface ArchiveLocator {
  item: string;
  file: string;
  member?: string;
  inner?: string;
}

export interface ArchiveRequestOptions {
  /** For search and metadata. Defaults to the global fetch. */
  fetch?: ArchiveFetch;
  signal?: AbortSignal;
}

export interface ArchiveDownloadOptions {
  /** For file bytes: a fetch that can reach hosts without CORS headers. */
  fetch: ArchiveFetch;
  /** Hard cap on the file's (or member's) size. */
  maxBytes: number;
  /**
   * Largest ZIP downloaded whole when a relay ignores Range, and largest
   * nested ZIP read into memory. Defaults to 64 MiB.
   */
  maxArchiveBytes?: number;
  signal?: AbortSignal;
}

export class ArchiveError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/** The resolver name share links use for Internet Archive boot inputs. */
export const INTERNET_ARCHIVE_RESOLVER = "internet-archive";

const SEARCH_API = "https://archive.org/advancedsearch.php";
const METADATA_API = "https://archive.org/metadata/";
const MAX_QUERY_CHARS = 120;
const MAX_ROWS = 50;
const MAX_SEARCH_JSON_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_JSON_BYTES = 32 * 1024 * 1024;
const MAX_METADATA_FILES = 50_000;
const MAX_IDENTIFIER_CHARS = 128;
const MAX_FILE_NAME_CHARS = 2_048;
const MAX_ZIP_ENTRIES = 100_000;
const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export function validateArchiveIdentifier(identifier: string): string {
  if (
    identifier.length === 0 || identifier.length > MAX_IDENTIFIER_CHARS
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier)
  ) {
    throw new ArchiveError("E_IDENTIFIER", `not an Internet Archive identifier: ${identifier}`);
  }
  return identifier;
}

function validateFileName(name: string): string {
  if (
    name.length === 0 || name.length > MAX_FILE_NAME_CHARS || name.startsWith("/")
    || name.includes("\\") || name.includes("\0")
    || name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ArchiveError("E_FILE_NAME", `unsafe Internet Archive file name: ${name}`);
  }
  return name;
}

function validateServer(server: string): string {
  const host = server.trim().toLowerCase();
  if (!/^(?:[a-z0-9-]+\.)*archive\.org$/.test(host)) {
    throw new ArchiveError("E_SERVER", `unexpected Internet Archive download host: ${server}`);
  }
  return host;
}

function validateDirectory(directory: string, identifier: string): string {
  const parts = directory.split("/");
  if (
    !directory.startsWith("/") || directory.includes("\\") || directory.includes("\0")
    || parts.slice(1).some((part) => part === "" || part === "." || part === "..")
    || parts.at(-1) !== identifier
  ) {
    throw new ArchiveError("E_DIRECTORY", "Internet Archive metadata named an unsafe directory");
  }
  return directory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(value: unknown, max: number): string | undefined {
  const raw = typeof value === "string" ? value
    : Array.isArray(value) && typeof value[0] === "string" ? value[0]
    : undefined;
  const trimmed = raw?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value)
    : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readBounded(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const declared = nonNegativeInteger(response.headers.get("content-length"));
  if (declared !== undefined && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ArchiveError("E_TOO_LARGE", `${label} is ${declared} bytes; the limit is ${maxBytes}`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new ArchiveError("E_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ArchiveError("E_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fetchJson(
  url: URL,
  options: ArchiveRequestOptions,
  maxBytes: number,
  label: string,
): Promise<unknown> {
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const response = await fetchImpl(url.href, {
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new ArchiveError("E_HTTP", `${label} failed: HTTP ${response.status}`);
  }
  const bytes = await readBounded(response, maxBytes, label);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ArchiveError("E_JSON", `${label} returned invalid JSON`);
  }
}

function quoteTerm(term: string): string {
  return `"${term.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The search URL for `query` within an image-declared group clause. The
 * visitor's words only ever appear quoted, so they cannot change the clause.
 */
export function buildArchiveSearchUrl(
  query: string,
  groupClause: string,
  page = 1,
  rows = 24,
): URL {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (normalized.length > MAX_QUERY_CHARS) {
    throw new ArchiveError("E_QUERY", `search text is longer than ${MAX_QUERY_CHARS} characters`);
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) {
    throw new ArchiveError("E_ROWS", `rows must be between 1 and ${MAX_ROWS}`);
  }
  if (!Number.isInteger(page) || page < 1 || page > 1000) {
    throw new ArchiveError("E_PAGE", "page must be between 1 and 1000");
  }
  const terms = normalized ? normalized.split(" ") : [];
  const words = terms.length === 0 ? "" :
    ` AND ((${terms.map((term) => `title:${quoteTerm(term)}`).join(" AND ")})` +
    ` OR (${terms.map((term) => `identifier:${quoteTerm(term)}`).join(" AND ")}))`;
  const url = new URL(SEARCH_API);
  url.searchParams.set("q", `(${groupClause})${words}`);
  for (const field of ["identifier", "title", "creator", "downloads"]) {
    url.searchParams.append("fl[]", field);
  }
  url.searchParams.append("sort[]", "downloads desc");
  url.searchParams.set("rows", String(rows));
  url.searchParams.set("page", String(page));
  url.searchParams.set("output", "json");
  return url;
}

export async function searchArchive(
  query: string,
  groupClause: string,
  options: ArchiveRequestOptions & { page?: number; rows?: number } = {},
): Promise<ArchiveSearchPage> {
  const parsed = await fetchJson(
    buildArchiveSearchUrl(query, groupClause, options.page, options.rows),
    options,
    MAX_SEARCH_JSON_BYTES,
    "Internet Archive search",
  );
  if (!isRecord(parsed) || !isRecord(parsed.response) || !Array.isArray(parsed.response.docs)) {
    throw new ArchiveError("E_SCHEMA", "Internet Archive search returned an unexpected shape");
  }
  const items: ArchiveSearchItem[] = [];
  for (const doc of parsed.response.docs) {
    if (!isRecord(doc) || typeof doc.identifier !== "string") continue;
    let identifier: string;
    try {
      identifier = validateArchiveIdentifier(doc.identifier);
    } catch {
      continue;
    }
    const creator = firstString(doc.creator, 200);
    const downloads = nonNegativeInteger(doc.downloads);
    items.push({
      identifier,
      title: firstString(doc.title, 300) ?? identifier,
      ...(creator ? { creator } : {}),
      ...(downloads === undefined ? {} : { downloads }),
    });
  }
  return { items, total: nonNegativeInteger(parsed.response.numFound) ?? items.length };
}

export async function getArchiveItem(
  identifier: string,
  options: ArchiveRequestOptions = {},
): Promise<ArchiveItem> {
  const id = validateArchiveIdentifier(identifier);
  const parsed = await fetchJson(
    new URL(encodeURIComponent(id), METADATA_API),
    options,
    MAX_METADATA_JSON_BYTES,
    `Internet Archive metadata for ${id}`,
  );
  if (!isRecord(parsed) || !Array.isArray(parsed.files) || !isRecord(parsed.metadata)) {
    // The metadata API answers {} for an identifier that does not exist.
    throw new ArchiveError("E_NOT_FOUND", `no Internet Archive item named ${id}`);
  }
  if (parsed.files.length > MAX_METADATA_FILES) {
    throw new ArchiveError("E_SCHEMA", `${id} lists ${parsed.files.length} files; the limit is ${MAX_METADATA_FILES}`);
  }
  if (firstString(parsed.metadata.identifier, MAX_IDENTIFIER_CHARS) !== id) {
    throw new ArchiveError("E_SCHEMA", `metadata for ${id} describes a different item`);
  }
  // `d1`/`d2` are the item's current storage hosts; `server` is the same
  // information in older responses. Preferring d1 avoids the /download/
  // redirect, which a relay would otherwise have to follow.
  const server = firstString(parsed.d1, 255) ?? firstString(parsed.server, 255);
  const dir = firstString(parsed.dir, 1024);
  if (!server || !dir) {
    throw new ArchiveError("E_SCHEMA", `metadata for ${id} omits where its files are`);
  }
  const files: ArchiveFile[] = [];
  for (const file of parsed.files) {
    if (!isRecord(file) || typeof file.name !== "string") continue;
    let name: string;
    try {
      name = validateFileName(file.name);
    } catch {
      continue;
    }
    const size = nonNegativeInteger(file.size);
    const format = firstString(file.format, 100);
    files.push({
      name,
      ...(size === undefined ? {} : { size }),
      ...(format ? { format } : {}),
    });
  }
  return {
    identifier: id,
    title: firstString(parsed.metadata.title, 300) ?? id,
    server: validateServer(server),
    directory: validateDirectory(dir, id),
    files,
  };
}

export function archiveFileUrl(item: ArchiveItem, name: string): string {
  const path = [
    ...item.directory.split("/").filter(Boolean),
    ...validateFileName(name).split("/"),
  ].map(encodeURIComponent).join("/");
  return `https://${validateServer(item.server)}/${path}`;
}

const MAX_THUMBNAIL_BYTES = 512 * 1024;

/**
 * An item's thumbnail image. The image service sends no CORS or CORP headers,
 * so a cross-origin-isolated page cannot show it with a plain <img>: it is
 * fetched through the caller's fetch (the CORS proxy) and handed back as a
 * same-origin Blob, capped and checked to be an image.
 */
export async function downloadArchiveThumbnail(
  identifier: string,
  options: { fetch: ArchiveFetch; signal?: AbortSignal },
): Promise<Blob> {
  const url = `https://archive.org/services/img/${encodeURIComponent(validateArchiveIdentifier(identifier))}`;
  const response = await options.fetch(url, { method: "GET", signal: options.signal });
  if (!response.ok) {
    throw new ArchiveError("E_HTTP", `thumbnail for ${identifier} failed: HTTP ${response.status}`);
  }
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!/^image\/(?:jpeg|png|gif|webp)$/.test(type)) {
    await response.body?.cancel().catch(() => {});
    throw new ArchiveError("E_THUMBNAIL", `thumbnail for ${identifier} is not an image`);
  }
  const bytes = await readBounded(response, MAX_THUMBNAIL_BYTES, `thumbnail for ${identifier}`);
  return new Blob([Uint8Array.from(bytes)], { type });
}

function findFile(item: ArchiveItem, name: string): ArchiveFile {
  const file = item.files.find((candidate) => candidate.name === name);
  if (!file) throw new ArchiveError("E_NOT_FOUND", `${item.identifier} has no file ${name}`);
  return file;
}

/** Download one whole file of an item, refusing it past `maxBytes`. */
export async function downloadArchiveFile(
  item: ArchiveItem,
  name: string,
  options: ArchiveDownloadOptions,
): Promise<Uint8Array> {
  const file = findFile(item, name);
  if (file.size !== undefined && file.size > options.maxBytes) {
    throw new ArchiveError("E_TOO_LARGE", `${name} is ${file.size} bytes; the limit is ${options.maxBytes}`);
  }
  const response = await options.fetch(archiveFileUrl(item, name), {
    method: "GET",
    signal: options.signal,
  });
  if (!response.ok) {
    throw new ArchiveError("E_HTTP", `download of ${name} failed: HTTP ${response.status}`);
  }
  const bytes = await readBounded(response, options.maxBytes, name);
  if (file.size !== undefined && bytes.byteLength !== file.size) {
    throw new ArchiveError(
      "E_SIZE",
      `${name} should be ${file.size} bytes but ${bytes.byteLength} arrived`,
    );
  }
  return bytes;
}

/** The members of one ZIP file of an item, read by range where possible. */
export async function readArchiveZip(
  item: ArchiveItem,
  name: string,
  options: Omit<ArchiveDownloadOptions, "maxBytes">,
): Promise<RemoteZipDirectory> {
  findFile(item, name);
  try {
    return await fetchZipCentralDirectory(archiveFileUrl(item, name), {
      fetch: options.fetch,
      signal: options.signal,
      parse: { names: "display", maxEntries: MAX_ZIP_ENTRIES },
      maxWholeArchiveBytes: options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
    });
  } catch (err) {
    throw new ArchiveError(
      "E_ZIP",
      `could not read ${name} as a ZIP archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Whether a member can be handed to a machine at all. */
export function zipMemberProblem(entry: ZipEntry, maxBytes: number): string | null {
  if (entry.isDirectory) return "a directory";
  if (entry.encrypted) return "encrypted";
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    return `compressed with method ${entry.compressionMethod}, which is not supported`;
  }
  if (entry.uncompressedSize > maxBytes) {
    return `${entry.uncompressedSize} bytes, over the ${maxBytes}-byte limit`;
  }
  return null;
}

export async function readArchiveZipMember(
  item: ArchiveItem,
  name: string,
  directory: RemoteZipDirectory,
  member: string,
  options: ArchiveDownloadOptions,
): Promise<Uint8Array> {
  const matches = directory.entries.filter((entry) => entry.fileName === member);
  if (matches.length !== 1) {
    throw new ArchiveError(
      "E_MEMBER",
      matches.length === 0
        ? `${name} has no member ${member}`
        : `${name} has ${matches.length} members named ${member}`,
    );
  }
  const problem = zipMemberProblem(matches[0], options.maxBytes);
  if (problem) throw new ArchiveError("E_MEMBER", `${member} is ${problem}`);
  return fetchZipMember(archiveFileUrl(item, name), directory, matches[0], {
    fetch: options.fetch,
    signal: options.signal,
    maxBytes: options.maxBytes,
  });
}

/** A ZIP that is a member of an item's ZIP, read whole into memory. */
export interface NestedZip {
  /** The member's name in the outer ZIP. */
  name: string;
  bytes: Uint8Array;
  entries: ZipEntry[];
}

/**
 * Read a member of an item's ZIP that is itself a ZIP. A nested ZIP cannot be
 * read by range, so it is fetched whole, capped at `maxArchiveBytes`.
 */
export async function readArchiveNestedZip(
  item: ArchiveItem,
  name: string,
  directory: RemoteZipDirectory,
  member: string,
  options: Omit<ArchiveDownloadOptions, "maxBytes">,
): Promise<NestedZip> {
  const bytes = await readArchiveZipMember(item, name, directory, member, {
    ...options,
    maxBytes: options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
  });
  try {
    return {
      name: member,
      bytes,
      entries: parseZipCentralDirectory(bytes, { names: "display", maxEntries: MAX_ZIP_ENTRIES }),
    };
  } catch (err) {
    throw new ArchiveError(
      "E_ZIP",
      `could not read ${member} as a ZIP archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Extract one member of a nested ZIP, capped at `maxBytes`. */
export function readNestedZipMember(
  nested: NestedZip,
  inner: string,
  maxBytes: number,
): Uint8Array {
  const matches = nested.entries.filter((entry) => entry.fileName === inner);
  if (matches.length !== 1) {
    throw new ArchiveError(
      "E_MEMBER",
      matches.length === 0
        ? `${nested.name} has no member ${inner}`
        : `${nested.name} has ${matches.length} members named ${inner}`,
    );
  }
  const problem = zipMemberProblem(matches[0], maxBytes);
  if (problem) throw new ArchiveError("E_MEMBER", `${inner} is ${problem}`);
  try {
    // The central directory is untrusted: bound the inflate by its own claim,
    // which zipMemberProblem has already held to the cap.
    return extractZipEntryBounded(nested.bytes, matches[0], matches[0].uncompressedSize);
  } catch (err) {
    throw new ArchiveError(
      "E_MEMBER",
      `could not extract ${inner}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Parse a boot input's locator strictly: exactly these keys, all strings. */
export function parseArchiveLocator(value: BootJsonValue): ArchiveLocator {
  if (!isRecord(value)) {
    throw new ArchiveError("E_LOCATOR", "an Internet Archive locator must be an object");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["item", "file", "member", "inner"].includes(key))) {
    throw new ArchiveError("E_LOCATOR", `unexpected locator field in ${keys.join(", ")}`);
  }
  if (typeof value.item !== "string" || typeof value.file !== "string") {
    throw new ArchiveError("E_LOCATOR", "an Internet Archive locator needs item and file");
  }
  if (value.member !== undefined && typeof value.member !== "string") {
    throw new ArchiveError("E_LOCATOR", "a locator's member must be a string");
  }
  if (value.inner !== undefined && (typeof value.inner !== "string" || value.member === undefined)) {
    throw new ArchiveError("E_LOCATOR", "a locator's inner must be a string, inside a member");
  }
  return {
    item: validateArchiveIdentifier(value.item),
    file: validateFileName(value.file),
    ...(value.member === undefined ? {} : { member: value.member }),
    ...(value.inner === undefined ? {} : { inner: value.inner }),
  };
}

export function archiveLocatorJson(locator: ArchiveLocator): BootJsonValue {
  return {
    item: locator.item,
    file: locator.file,
    ...(locator.member === undefined ? {} : { member: locator.member }),
    ...(locator.inner === undefined ? {} : { inner: locator.inner }),
  };
}

/** Fetch the bytes a locator names, capped at `maxBytes`. */
export async function readArchiveLocator(
  locator: ArchiveLocator,
  options: ArchiveDownloadOptions & { metadataFetch?: ArchiveFetch },
): Promise<Uint8Array> {
  const item = await getArchiveItem(locator.item, {
    fetch: options.metadataFetch,
    signal: options.signal,
  });
  if (locator.member === undefined) {
    return downloadArchiveFile(item, locator.file, options);
  }
  const directory = await readArchiveZip(item, locator.file, options);
  if (locator.inner === undefined) {
    return readArchiveZipMember(item, locator.file, directory, locator.member, options);
  }
  const nested = await readArchiveNestedZip(item, locator.file, directory, locator.member, options);
  return readNestedZipMember(nested, locator.inner, options.maxBytes);
}

/**
 * The boot-input resolver for Internet Archive files. The boot-input layer
 * checks the result against the descriptor's byteLength and sha256, so this
 * only has to fetch no more than that many bytes.
 */
export function createInternetArchiveResolver(options: {
  fetch: ArchiveFetch;
  metadataFetch?: ArchiveFetch;
  maxArchiveBytes?: number;
}): BootInputResolver {
  return async (locator, context) => readArchiveLocator(parseArchiveLocator(locator), {
    fetch: options.fetch,
    metadataFetch: options.metadataFetch,
    maxArchiveBytes: options.maxArchiveBytes,
    maxBytes: context.input.byteLength,
    signal: context.signal,
  });
}
