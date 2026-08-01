import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// WHY: the campaign runs this exact source with Node's built-in TypeScript
// stripping and no node_modules. The explicit extension gives native ESM one
// deterministic module path instead of relying on a third-party resolver.
import { fetchHomebrewBottleResponse } from "../host/src/homebrew-vfs-fetch.ts";

export interface PublicBottleVerificationOptions {
  url: string;
  sha256: string;
  bytes: number;
  out: string;
}

interface VerificationDependencies {
  fetchResponse?: (url: string) => Promise<Response>;
  maximumBytes?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const RETRIES = 3;
export const MAX_COMPRESSED_BOTTLE_BYTES = loadCompressedBottleLimit();

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await verifyPublicBottle(options);
}

export async function verifyPublicBottle(
  options: PublicBottleVerificationOptions,
  dependencies: VerificationDependencies = {},
): Promise<void> {
  const maximumBytes = dependencies.maximumBytes ?? MAX_COMPRESSED_BOTTLE_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > MAX_COMPRESSED_BOTTLE_BYTES
  ) {
    throw new Error(
      `compressed bottle limit must be between 1 and ${MAX_COMPRESSED_BOTTLE_BYTES} bytes`,
    );
  }
  if (options.bytes > maximumBytes) {
    throw new Error(
      `expected public bottle byte count ${options.bytes} exceeds ` +
        `compressed bottle limit ${maximumBytes}`,
    );
  }

  const fetchResponse = dependencies.fetchResponse ?? fetchHomebrewBottleResponse;
  const sleep = dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;

  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      await streamVerifiedBottle(
        () => fetchResponse(options.url),
        options,
        maximumBytes,
      );
      console.log(`Verified anonymous bottle readback: ${options.url}`);
      return;
    } catch (error) {
      lastError = error;
      if (isFileExistsError(error)) throw error;
      if (attempt < RETRIES) {
        console.error(`public bottle readback failed (attempt ${attempt}/${RETRIES}); retrying`);
        await sleep(attempt * 2_000);
      }
    }
  }

  throw lastError;
}

async function streamVerifiedBottle(
  fetchResponse: () => Promise<Response>,
  options: PublicBottleVerificationOptions,
  maximumBytes: number,
): Promise<void> {
  await mkdir(dirname(options.out), { recursive: true });
  let output: FileHandle | undefined;
  let outputCreated = false;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    // WHY: a retry must never overwrite a prior accepted bottle or a path
    // placed by another process. A file created by this attempt is removed on
    // every failure, so the next attempt also starts from an absent pathname.
    output = await open(options.out, "wx", 0o644);
    outputCreated = true;
    response = await fetchResponse();
    reader = response.body?.getReader();
    const digest = createHash("sha256");
    let byteCount = 0;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const nextByteCount = byteCount + value.byteLength;
        if (nextByteCount > maximumBytes) {
          throw new Error(
            `public bottle exceeds compressed bottle limit ${maximumBytes} bytes`,
          );
        }
        if (nextByteCount > options.bytes) {
          throw new Error(
            `public bottle byte count exceeds expected ${options.bytes}`,
          );
        }
        await writeAll(output, value);
        digest.update(value);
        byteCount = nextByteCount;
      }
    }

    if (byteCount !== options.bytes) {
      throw new Error(
        `public bottle byte count ${byteCount} does not match expected ${options.bytes}`,
      );
    }
    const actualSha256 = digest.digest("hex");
    if (actualSha256 !== options.sha256) {
      throw new Error(
        `public bottle sha256 ${actualSha256} does not match expected ${options.sha256}`,
      );
    }
    await output.sync();
    await output.close();
    output = undefined;
  } catch (error) {
    if (reader) {
      await reader.cancel().catch(() => undefined);
    } else {
      await response?.body?.cancel().catch(() => undefined);
    }
    if (output) await output.close().catch(() => undefined);
    if (outputCreated) {
      try {
        await rm(options.out, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `public bottle verification failed and could not remove ${options.out}`,
        );
      }
    }
    throw error;
  } finally {
    reader?.releaseLock();
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST";
}

async function writeAll(output: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await output.write(chunk, offset);
    if (bytesWritten <= 0) {
      throw new Error("public bottle output stopped accepting bytes");
    }
    offset += bytesWritten;
  }
}

function parseArgs(args: string[]): PublicBottleVerificationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) usage();
    if (values.has(flag)) usage();
    values.set(flag, value);
  }

  const url = values.get("--url") ?? "";
  const sha256 = values.get("--sha256") ?? "";
  const out = values.get("--out") ?? "";
  const bytesText = values.get("--bytes") ?? "";
  if (values.size !== 4 || !url || !sha256 || !out || !bytesText) usage();
  if (!/^[0-9a-f]{64}$/.test(sha256)) usage();

  const parsedUrl = new URL(url);
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "ghcr.io" ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash ||
    !parsedUrl.pathname.endsWith(`/blobs/sha256:${sha256}`)
  ) {
    usage();
  }

  const bytes = Number(bytesText);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) usage();
  return { url, sha256, bytes, out };
}

function loadCompressedBottleLimit(): number {
  const script = fileURLToPath(new URL("./homebrew-publication-limits.sh", import.meta.url));
  let value: string;
  try {
    value = execFileSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; printf "%s\\n" "$HOMEBREW_MAX_BOTTLE_BYTES"',
        "homebrew-publication-limit",
        script,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (error) {
    throw new Error(`cannot load compressed bottle limit from ${script}`, { cause: error });
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`compressed bottle limit is not a positive canonical integer: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`compressed bottle limit is not a safe integer: ${value}`);
  }
  return parsed;
}

function usage(): never {
  console.error(
    "usage: node --experimental-strip-types " +
      "scripts/homebrew-verify-public-bottle.ts " +
      "--url <ghcr-blob-url> --sha256 <sha256> --bytes <bytes> --out <path>",
  );
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
