import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchHomebrewBottleBytes } from "../host/src/homebrew-vfs-fetch";

export interface PublicBottleVerificationOptions {
  url: string;
  sha256: string;
  bytes: number;
  out: string;
}

interface VerificationDependencies {
  fetchBottle?: (url: string) => Promise<Uint8Array>;
  sleep?: (milliseconds: number) => Promise<void>;
}

const RETRIES = 3;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await verifyPublicBottle(options);
}

export async function verifyPublicBottle(
  options: PublicBottleVerificationOptions,
  dependencies: VerificationDependencies = {},
): Promise<void> {
  const fetchBottle = dependencies.fetchBottle ?? fetchHomebrewBottleBytes;
  const sleep = dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let bottle: Uint8Array | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const candidate = await fetchBottle(options.url);
      verifyBottle(candidate, options);
      bottle = candidate;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) {
        console.error(`public bottle readback failed (attempt ${attempt}/${RETRIES}); retrying`);
        await sleep(attempt * 2_000);
      }
    }
  }

  if (!bottle) throw lastError;
  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, bottle);
  console.log(`Verified anonymous bottle readback: ${options.url}`);
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

function verifyBottle(bottle: Uint8Array, options: PublicBottleVerificationOptions): void {
  if (bottle.byteLength !== options.bytes) {
    throw new Error(
      `public bottle byte count ${bottle.byteLength} does not match expected ${options.bytes}`,
    );
  }
  const actualSha256 = createHash("sha256").update(bottle).digest("hex");
  if (actualSha256 !== options.sha256) {
    throw new Error(
      `public bottle sha256 ${actualSha256} does not match expected ${options.sha256}`,
    );
  }
}

function usage(): never {
  console.error(
    "usage: npx tsx scripts/homebrew-verify-public-bottle.ts " +
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
