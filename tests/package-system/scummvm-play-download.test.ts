import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SCUMMVM_PLAY_SCRIPT } from "../../images/vfs/scripts/build-source-rootfs-shell-image";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runDownload(options: {
  ignoredRange?: boolean;
  ranged?: boolean;
  failRangeOnce?: string;
  failRangeAlways?: string;
  failSingleOnce?: boolean;
  shortRangeOnce?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "kandelo-scummvm-download-"));
  roots.push(root);
  const bin = join(root, "bin");
  const games = join(root, "games");
  mkdirSync(bin);
  mkdirSync(games);
  const source = join(root, "archive");
  const captured = join(root, "captured");
  const ranges = join(root, "ranges");
  const requests = join(root, "requests");
  const failedMarker = join(root, "failed");
  const catalog = join(root, "games.tsv");
  const bytes = Buffer.from(Array.from({ length: 81 }, (_, index) => index));
  writeFileSync(source, bytes);
  writeFileSync(catalog, [
    "fixture", String(bytes.length), "81 B",
    createHash("sha256").update(bytes).digest("hex"),
    "https://example.test/archive.zip", "Fixture",
  ].join("\t") + "\n");

  const curl = join(bin, "curl");
  writeFileSync(curl, `#!/bin/sh
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o) output=$2; shift 2 ;;
        -r) range=$2; shift 2 ;;
        -w) shift 2 ;;
        *) shift ;;
    esac
done
echo "\${range:-full}" >> "$REQUESTS"
if [ -n "\${range:-}" ]; then
    echo "$range" >> "$RANGES"
    if [ "$IGNORE_RANGE" = 1 ]; then
        if [ "$output" = - ]; then cat "$SOURCE"; else cp "$SOURCE" "$output"; fi
        if [ "$output" = - ]; then printf 200 >&2; else printf 200; fi
    else
        first=\${range%-*}
        last=\${range#*-}
        if [ "$FAIL_RANGE_ALWAYS" = "$range" ] ||
           { [ "$FAIL_RANGE_ONCE" = "$range" ] && [ ! -e "$FAILED_MARKER" ]; }; then
            : > "$FAILED_MARKER"
            dd if="$SOURCE" of="$output" bs=1 skip="$first" count=5 2>/dev/null
            printf 206
            exit 18
        fi
        if [ "$SHORT_RANGE_ONCE" = "$range" ] && [ ! -e "$FAILED_MARKER" ]; then
            : > "$FAILED_MARKER"
            dd if="$SOURCE" of="$output" bs=1 skip="$first" count=5 2>/dev/null
            printf 206
            exit 0
        fi
        dd if="$SOURCE" of="$output" bs=1 skip="$first" count="$((last - first + 1))" 2>/dev/null
        printf 206
    fi
else
    if [ "$FAIL_SINGLE_ONCE" = 1 ] && [ ! -e "$FAILED_MARKER" ]; then
        : > "$FAILED_MARKER"
        dd if="$SOURCE" of="$output" bs=1 count=5 2>/dev/null
        printf 200
        exit 18
    fi
    cp "$SOURCE" "$output"
    printf 200
fi
`);
  chmodSync(curl, 0o755);
  const sha256sum = join(bin, "sha256sum");
  writeFileSync(sha256sum, `#!/bin/sh
cp "$GAMES/fixture.zip" "$CAPTURED"
exit 1
`);
  chmodSync(sha256sum, 0o755);
  const sleep = join(bin, "sleep");
  writeFileSync(sleep, "#!/bin/sh\n/bin/sleep 0.01\n");
  chmodSync(sleep, 0o755);

  const script = join(root, "scummvm-play");
  writeFileSync(script, SCUMMVM_PLAY_SCRIPT
    .replace("/usr/local/share/scummvm-play/games.tsv", catalog)
    .replace("/usr/share/scummvm-games", games)
    .replace("RANGE_LIMIT=$((100 * 1024 * 1024))", `RANGE_LIMIT=${options.ranged === false ? 128 : 64}`)
    .replace("RANGE_SIZE=$((32 * 1024 * 1024))", "RANGE_SIZE=16"));
  chmodSync(script, 0o755);
  let output = "";
  try {
    execFileSync("sh", [script, "fixture"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SOURCE: source,
        RANGES: ranges,
        GAMES: games,
        CAPTURED: captured,
        IGNORE_RANGE: options.ignoredRange ? "1" : "0",
        FAIL_RANGE_ONCE: options.failRangeOnce ?? "",
        FAIL_RANGE_ALWAYS: options.failRangeAlways ?? "",
        FAIL_SINGLE_ONCE: options.failSingleOnce ? "1" : "0",
        SHORT_RANGE_ONCE: options.shortRangeOnce ?? "",
        FAILED_MARKER: failedMarker,
        REQUESTS: requests,
      },
      stdio: "pipe",
    });
  } catch (error) {
    output = String((error as { stderr: Buffer }).stderr);
  }
  return {
    output,
    bytes,
    captured,
    ranges,
    requests,
    games,
  };
}

it("assembles bounded ranges and reports progress for the whole archive", () => {
  const result = runDownload();
  expect(readFileSync(result.ranges, "utf8").trim().split("\n"))
    .toEqual(["0-15", "16-31", "32-47", "48-63", "64-79", "80-80"]);
  expect(readFileSync(result.captured)).toEqual(result.bytes);
  const progress = [...result.output.matchAll(/#### (\d+)%/g)]
    .map((match) => Number(match[1]));
  expect(progress.some((percent) => percent > 0 && percent < 100)).toBe(true);
  expect(progress.every((percent, index) => index === 0 || percent >= progress[index - 1]))
    .toBe(true);
  expect(result.output).toContain("#### 100%");
  expect(result.output).toContain("Checksum mismatch");
});

it("rejects a server that ignores a requested range", () => {
  const result = runDownload({ ignoredRange: true });
  expect(readFileSync(result.requests, "utf8").trim().split("\n")).toEqual(["0-15"]);
  expect(result.output).toContain("Download failed");
  expect(result.output).not.toContain("#### 100%");
  expect(() => readFileSync(result.captured)).toThrow();
});

it("retries a failed range without duplicating its partial bytes", () => {
  const result = runDownload({ failRangeOnce: "16-31" });
  expect(readFileSync(result.requests, "utf8").trim().split("\n"))
    .toEqual(["0-15", "16-31", "16-31", "32-47", "48-63", "64-79", "80-80"]);
  expect(readFileSync(result.captured)).toEqual(result.bytes);
  expect(result.output).toContain("Retrying download (attempt 2/3)");
  expect(result.output).toContain("#### 100%");
});

it("retries a short range response even when curl reports success", () => {
  const result = runDownload({ shortRangeOnce: "16-31" });
  expect(readFileSync(result.requests, "utf8").trim().split("\n"))
    .toEqual(["0-15", "16-31", "16-31", "32-47", "48-63", "64-79", "80-80"]);
  expect(readFileSync(result.captured)).toEqual(result.bytes);
});

it("stops after three failed attempts and removes partial output", () => {
  const result = runDownload({ failRangeAlways: "16-31" });
  expect(readFileSync(result.requests, "utf8").trim().split("\n"))
    .toEqual(["0-15", "16-31", "16-31", "16-31"]);
  expect(result.output).toContain("Download failed");
  expect(result.output).not.toContain("#### 100%");
  expect(existsSync(join(result.games, "fixture.zip"))).toBe(false);
  expect(existsSync(join(result.games, "fixture.zip.part"))).toBe(false);
});

it("uses a single request for archives below the range threshold", () => {
  const result = runDownload({ ranged: false });
  expect(readFileSync(result.captured)).toEqual(result.bytes);
  expect(() => readFileSync(result.ranges)).toThrow();
  expect(readFileSync(result.requests, "utf8").trim()).toBe("full");
  expect(result.output).toContain("#### 100%");
  expect(result.output).not.toContain("Download failed");
});

it("retries a failed small-file request from the beginning", () => {
  const result = runDownload({ ranged: false, failSingleOnce: true });
  expect(readFileSync(result.requests, "utf8").trim().split("\n")).toEqual(["full", "full"]);
  expect(readFileSync(result.captured)).toEqual(result.bytes);
  expect(result.output).toContain("Retrying download (attempt 2/3)");
});
