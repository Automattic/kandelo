import { BrowserKernel } from "@host/browser-kernel-host";
import kernelWasmUrl from "@kernel-wasm?url";

const output = document.getElementById("output") as HTMLPreElement;
const programSelect = document.getElementById("program") as HTMLSelectElement;
const runButton = document.getElementById("run") as HTMLButtonElement;
const forkCountDebug = document.getElementById("fork-count-debug") as HTMLDivElement;
const thirdPartyGallery = document.getElementById(
  "third-party-gallery",
) as HTMLDivElement;
const thirdPartyGalleryStatus = document.getElementById(
  "third-party-gallery-status",
) as HTMLParagraphElement;

const decoder = new TextDecoder();
const KANDELO_SOFTWARE_MANIFEST_URL =
  "https://github.com/brandonpayton/kandelo-software/releases/download/binaries-abi-v11/gallery.json";
const DEFAULT_KANDELO_SOFTWARE_INDEX_URL =
  "https://github.com/brandonpayton/kandelo-software/releases/download/binaries-abi-v11/index.toml";

type GalleryPackageRequirement = {
  name: string;
  version: string;
};

type GalleryEntry = {
  id: string;
  title: string;
  description: string;
  packages: GalleryPackageRequirement[];
  package_url?: string;
};

type GalleryManifest = {
  index_url?: string;
  entries: GalleryEntry[];
};

type IndexBinaryEntry = {
  status?: string;
  archive_url?: string;
};

type IndexPackageEntry = {
  name?: string;
  version?: string;
  binary: Record<string, IndexBinaryEntry>;
};

function appendOutput(text: string, className?: string) {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}

function packageKey(pkg: GalleryPackageRequirement): string {
  return `${pkg.name}@${pkg.version}`;
}

function stripTomlComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") {
      inString = !inString;
    } else if (ch === "#" && !inString) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseIndexToml(text: string): Map<string, IndexPackageEntry> {
  const packages = new Map<string, IndexPackageEntry>();
  let currentPackage: IndexPackageEntry | undefined;
  let currentBinary: IndexBinaryEntry | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    if (line === "[[packages]]") {
      currentPackage = { binary: {} };
      currentBinary = undefined;
      continue;
    }

    const binaryMatch = line.match(/^\[packages\.binary\.([A-Za-z0-9_-]+)\]$/);
    if (binaryMatch && currentPackage) {
      currentBinary = {};
      currentPackage.binary[binaryMatch[1]] = currentBinary;
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment || !currentPackage) continue;

    const [, key, rawValue] = assignment;
    const value = parseTomlValue(rawValue);
    if (currentBinary) {
      currentBinary[key as keyof IndexBinaryEntry] = value;
    } else if (key === "name" || key === "version") {
      currentPackage[key] = value;
      if (currentPackage.name && currentPackage.version) {
        packages.set(
          `${currentPackage.name}@${currentPackage.version}`,
          currentPackage,
        );
      }
    }
  }

  return packages;
}

async function fetchTextWithDevProxy(url: string): Promise<string> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return await response.text();
  } catch (error) {
    const isDevHost =
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1" ||
      location.hostname === "[::1]";
    if (!isDevHost) throw error;

    const proxied = `/cors-proxy?url=${encodeURIComponent(url)}`;
    const response = await fetch(proxied, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return await response.text();
  }
}

function packageAvailable(
  index: Map<string, IndexPackageEntry>,
  requirement: GalleryPackageRequirement,
): boolean {
  const entry = index.get(packageKey(requirement));
  return entry?.binary.wasm32?.status === "success";
}

function archiveUrlFor(
  index: Map<string, IndexPackageEntry>,
  indexUrl: string,
  requirement: GalleryPackageRequirement | undefined,
): string | undefined {
  if (!requirement) return undefined;
  const archiveUrl = index.get(packageKey(requirement))?.binary.wasm32
    ?.archive_url;
  if (!archiveUrl) return undefined;
  return new URL(archiveUrl, indexUrl).href;
}

function renderGalleryEntries(
  entries: GalleryEntry[],
  index: Map<string, IndexPackageEntry>,
  indexUrl: string,
) {
  thirdPartyGallery.replaceChildren();

  for (const entry of entries) {
    const article = document.createElement("article");
    article.className = "software-gallery-card";

    const title = document.createElement("h3");
    title.textContent = entry.title;
    article.appendChild(title);

    const description = document.createElement("p");
    description.textContent = entry.description;
    article.appendChild(description);

    const packages = document.createElement("div");
    packages.className = "software-gallery-packages";
    for (const pkg of entry.packages) {
      const tag = document.createElement("span");
      tag.className = "software-gallery-package";
      tag.textContent = packageKey(pkg);
      packages.appendChild(tag);
    }
    article.appendChild(packages);

    const actions = document.createElement("div");
    actions.className = "software-gallery-actions";

    if (entry.package_url) {
      const packageLink = document.createElement("a");
      packageLink.href = entry.package_url;
      packageLink.target = "_blank";
      packageLink.rel = "noopener";
      packageLink.textContent = "Package";
      actions.appendChild(packageLink);
    }

    const primaryPackage = entry.packages[entry.packages.length - 1];
    const archiveUrl = archiveUrlFor(index, indexUrl, primaryPackage);
    if (archiveUrl) {
      const archiveLink = document.createElement("a");
      archiveLink.href = archiveUrl;
      archiveLink.target = "_blank";
      archiveLink.rel = "noopener";
      archiveLink.textContent = "Archive";
      actions.appendChild(archiveLink);
    }

    article.appendChild(actions);
    thirdPartyGallery.appendChild(article);
  }
}

async function loadThirdPartyGallery() {
  try {
    const manifestText = await fetchTextWithDevProxy(
      KANDELO_SOFTWARE_MANIFEST_URL,
    );
    const manifest = JSON.parse(manifestText) as GalleryManifest;
    const indexUrl = manifest.index_url
      ? new URL(manifest.index_url, KANDELO_SOFTWARE_MANIFEST_URL).href
      : DEFAULT_KANDELO_SOFTWARE_INDEX_URL;
    const index = parseIndexToml(await fetchTextWithDevProxy(indexUrl));
    const availableEntries = manifest.entries.filter((entry) =>
      entry.packages.every((pkg) => packageAvailable(index, pkg)),
    );

    if (availableEntries.length === 0) {
      thirdPartyGallery.classList.add("hidden");
      thirdPartyGalleryStatus.textContent =
        "No third-party VFS builds are marked available for this ABI.";
      return;
    }

    renderGalleryEntries(availableEntries, index, indexUrl);
    thirdPartyGallery.classList.remove("hidden");
    thirdPartyGalleryStatus.textContent =
      `${availableEntries.length} VFS build${availableEntries.length === 1 ? "" : "s"} available for Kandelo ABI 11.`;
  } catch (error) {
    thirdPartyGallery.classList.add("hidden");
    thirdPartyGalleryStatus.textContent =
      `Could not load kandelo-software: ${error}`;
  }
}

/**
 * Pre-stage state required by certain demo programs before they run.
 *
 * `spawn-smoke` is a tiny posix_spawn smoke test: it spawns the program at
 * `argv[1]` and waits for it. To exercise the non-forking spawn path on
 * the browser host we register `/usr/bin/hello` as a lazy file pointing at
 * the same `hello.wasm` URL the simple page already serves. When the
 * spawned child resolves the path, the browser kernel-worker fetches the
 * binary on demand via `MemoryFileSystem.ensureMaterialized`. No new
 * binary built, no separate VFS image.
 */
function prestageForProgram(
  kernel: BrowserKernel,
  programName: string,
): { argv: string[] } {
  if (programName !== "spawn-smoke") {
    return { argv: [programName] };
  }
  const helloUrl = new URL("../hello.wasm", import.meta.url).href;
  // We don't know the exact size up-front without an HTTP HEAD; pass a
  // generous overestimate and let the lazy materializer fetch the actual
  // bytes. The size is only used as a stat hint, not for buffer sizing.
  kernel.registerLazyFiles([
    { path: "/usr/bin/hello", url: helloUrl, size: 1 << 20, mode: 0o755 },
  ]);
  return { argv: ["spawn-smoke", "/usr/bin/hello"] };
}

async function run() {
  runButton.disabled = true;
  output.textContent = "";
  forkCountDebug.dataset.forkCount = "";

  const programName = programSelect.value;
  appendOutput(`Loading ${programName}...\n`, "info");

  try {
    // Fetch kernel and program wasm in parallel
    const programWasmUrl = new URL(`../${programName}.wasm`, import.meta.url)
      .href;
    const [kernelBytes, programBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(programWasmUrl).then((r) => r.arrayBuffer()),
    ]);

    const kernel = new BrowserKernel({
      onStdout: (data) => appendOutput(decoder.decode(data)),
      onStderr: (data) => appendOutput(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes);

    const { argv } = prestageForProgram(kernel, programName);

    appendOutput(`Running ${programName}...\n\n`, "info");

    // Capture the spawned pid via onStarted so we can read the kernel's
    // fork counter after exit. For non-spawn programs this is harmless
    // bookkeeping; for spawn-smoke it's the load-bearing assertion the
    // Playwright test reads through `data-fork-count`.
    let capturedPid: number | undefined;
    const exitCode = await kernel.spawn(programBytes, argv, {
      onStarted: (pid: number) => {
        capturedPid = pid;
      },
    });
    appendOutput(`\nExited with code ${exitCode}\n`, "info");

    if (capturedPid !== undefined) {
      const forkCount = await kernel.getForkCount(capturedPid);
      forkCountDebug.dataset.forkCount = forkCount.toString();
    }
  } catch (e) {
    appendOutput(`\nError: ${e}\n`, "stderr");
    console.error(e);
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", run);
void loadThirdPartyGallery();
