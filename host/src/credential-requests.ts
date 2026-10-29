/**
 * Package-owned declarations of which programs send account credentials, and
 * to which HTTPS origins.
 *
 * A package installs one JSON file per declaring program under
 * `/etc/kandelo/credential-requests.d/`. The platform reads these files to
 * decide when to ask the user; it never infers a destination from program
 * behavior. Files are untrusted input, so every field is checked and an
 * unrecognized or malformed file fails loudly rather than being skipped.
 */
export const CREDENTIAL_REQUESTS_DIR = "/etc/kandelo/credential-requests.d";
export const MAX_CREDENTIAL_REQUEST_BYTES = 65_536;
const MAX_DESTINATIONS = 32;
const MAX_TITLE_LENGTH = 128;
const MAX_PATH_LENGTH = 1024;

export type CredentialRequestLaunch = "wait" | "continue";

export interface CredentialRequestDeclaration {
  /** Absolute normalized path of the declaring program's real file, not a symlink to it. */
  program: string;
  /** Name shown to the user when asking. */
  title: string;
  /** Exact HTTPS origins (scheme, host, optional non-default port) credentials may be sent to. */
  destinations: readonly string[];
  /** `wait` holds the program until the user answers; `continue` lets it run meanwhile. */
  launch: CredentialRequestLaunch;
}

const KEYS = ["program", "title", "destinations", "launch"];

function isNormalizedAbsolutePath(value: string): boolean {
  return value.startsWith("/") && value.length > 1 && value.length <= MAX_PATH_LENGTH &&
    !/[\u0000-\u001f\u007f\\]/.test(value) &&
    value.slice(1).split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/**
 * The title is image-controlled text shown in the prompt. Control
 * characters (C0 and C1), format characters (Unicode category Cf: the
 * bidirectional controls U+202A-U+202E, U+2066-U+2069, U+200E, U+200F and
 * U+061C, zero-width space and word joiner, soft hyphen, byte order mark),
 * unpaired surrogates, and line and paragraph separators can make it display
 * as something other than what it is, or hide part of it, so a title may not
 * contain any of them.
 *
 * Two format characters are allowed: the zero-width non-joiner (U+200C) and
 * joiner (U+200D). Persian and Indic writing need them to spell ordinary
 * words, and emoji sequences use the joiner. They change how neighbouring
 * characters are drawn, not which characters a title holds; the trade-off is
 * that two titles can differ only by one of them.
 *
 * A title must also show something: one made only of whitespace, these two
 * joiners, and the blank filler letters (Hangul fillers U+115F, U+1160,
 * U+3164, U+FFA0 and the empty Braille pattern U+2800, which draw nothing)
 * would leave the prompt without a name.
 */
const DISGUISING_TITLE_CHARACTER = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const BLANK_TITLE_CHARACTERS = /[\p{White_Space}\u200c\u200d\u115f\u1160\u2800\u3164\uffa0]/gu;

function isPlainTitle(value: string): boolean {
  return !DISGUISING_TITLE_CHARACTER.test(value) &&
    value.replace(BLANK_TITLE_CHARACTERS, "") !== "";
}

function isHttpsOrigin(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" && url.origin === value;
}

function parseOne(name: string, bytes: Uint8Array): CredentialRequestDeclaration {
  const fail = (message: string): never => { throw new Error(`Credential request declaration ${name}: ${message}`); };
  if (bytes.byteLength > MAX_CREDENTIAL_REQUEST_BYTES) fail(`larger than ${MAX_CREDENTIAL_REQUEST_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    return fail(`not valid UTF-8 JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("expected a JSON object");
  const object = parsed as Record<string, unknown>;
  const unknown = Object.keys(object).find(key => !KEYS.includes(key));
  if (unknown !== undefined) fail(`unknown field ${JSON.stringify(unknown)}`);

  const { program, title, destinations, launch } = object;
  if (typeof program !== "string" || !isNormalizedAbsolutePath(program)) fail("program must be an absolute normalized path");
  if (typeof title !== "string" || !title || title.length > MAX_TITLE_LENGTH || !isPlainTitle(title)) fail("title must be non-empty plain text on one line");
  if (!Array.isArray(destinations) || destinations.length === 0 || destinations.length > MAX_DESTINATIONS) fail("destinations must be a non-empty list");
  for (const destination of destinations as unknown[]) {
    if (typeof destination !== "string" || !isHttpsOrigin(destination)) {
      fail(`destination ${JSON.stringify(destination)} is not an exact HTTPS origin`);
    }
  }
  if (new Set(destinations as string[]).size !== (destinations as string[]).length) fail("duplicate destination");
  if (launch !== "wait" && launch !== "continue") fail('launch must be "wait" or "continue"');
  return {
    program: program as string,
    title: title as string,
    destinations: [...(destinations as string[])],
    launch: launch as CredentialRequestLaunch,
  };
}

/**
 * Parse every installed declaration file, keyed by file name, into declarations
 * keyed by program path. Two files may not declare the same program.
 */
export function parseCredentialRequests(
  files: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, CredentialRequestDeclaration> {
  const declarations = new Map<string, CredentialRequestDeclaration>();
  const origin = new Map<string, string>();
  for (const [name, bytes] of files) {
    const declaration = parseOne(name, bytes);
    const previous = origin.get(declaration.program);
    if (previous !== undefined) {
      throw new Error(`Credential request declaration ${name}: program ${declaration.program} is already declared by ${previous}`);
    }
    origin.set(declaration.program, name);
    declarations.set(declaration.program, declaration);
  }
  return declarations;
}
