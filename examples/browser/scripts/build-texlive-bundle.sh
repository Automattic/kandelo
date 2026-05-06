#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BROWSER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BROWSER_DIR/../.." && pwd)"

# Pinned to the same TeX Live release whose source tarball
# build-texlive.sh compiles. Bumping requires changing both — the
# texmf-dist macros + format files install-tl downloads here must match
# the engine pdftex.wasm we just built. mismatch surfaces as either an
# install-tl version error (cross-edition tlpdb) or runtime "format
# file not found / cannot read format" once pdftex tries to load
# latex.fmt at demo time.
TEXLIVE_VERSION="${TEXLIVE_VERSION:-2025}"

# Frozen historical archive — `mirror.ctan.org/.../tlnet/` always points
# at the *current* TeX Live release, so as soon as upstream rolls
# (around April annually) install-tl + tlpdb shift to the new edition
# and refuse to install against an older `local: 2025` engine. The
# `historic/.../<year>/tlnet-final/` tree is the immutable post-rollover
# snapshot of that year's final release; using it pins both halves of
# the install (install-tl binary + the repository it pulls packages
# from) to the same edition.
TEXLIVE_INSTALL_URL="https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/${TEXLIVE_VERSION}/tlnet-final/install-tl-unx.tar.gz"
TEXLIVE_REPOSITORY="https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/${TEXLIVE_VERSION}/tlnet-final"

TEXLIVE_DIR="$REPO_ROOT/examples/libs/texlive"
HOST_PDFTEX="$TEXLIVE_DIR/texlive-host-build/texk/web2c/pdftex"
INSTALL_DIR="$TEXLIVE_DIR/texlive-dist"

# Bundle output destination. Default: served-from-public/ for direct
# `bash build-texlive-bundle.sh` invocations during local dev.
# Overridable so build-texlive.sh can drop the bundle into
# $WASM_POSIX_DEP_OUT_DIR (resolver scratch, packed into the package's
# tar.zst archive — same pattern as vim's runtime tree).
BUNDLE_FILE="${TEXLIVE_BUNDLE_OUT:-$BROWSER_DIR/public/texlive-bundle.json}"

if [ ! -x "$HOST_PDFTEX" ]; then
    echo "ERROR: Host pdftex not found. Run build-texlive.sh first." >&2
    exit 1
fi

# ─── Step 1: Install minimal TeX Live distribution ─────────────
if [ ! -d "$INSTALL_DIR/texmf-dist" ]; then
    echo "==> Installing minimal TeX Live distribution..."

    # Download install-tl from the pinned historical archive (see header).
    INSTALLER_DIR="$TEXLIVE_DIR/install-tl"
    if [ ! -d "$INSTALLER_DIR" ]; then
        curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
            -fsSL "$TEXLIVE_INSTALL_URL" \
            -o "/tmp/install-tl.tar.gz"
        mkdir -p "$INSTALLER_DIR"
        tar xzf "/tmp/install-tl.tar.gz" -C "$INSTALLER_DIR" --strip-components=1
        rm "/tmp/install-tl.tar.gz"
    fi

    # Create installation profile
    cat > "$TEXLIVE_DIR/texlive.profile" << EOF
selected_scheme scheme-custom
TEXDIR $INSTALL_DIR
TEXMFLOCAL $INSTALL_DIR/texmf-local
TEXMFSYSCONFIG $INSTALL_DIR/texmf-config
TEXMFSYSVAR $INSTALL_DIR/texmf-var
TEXMFHOME ~/texmf
collection-basic 1
collection-latex 1
collection-latexrecommended 1
collection-fontsrecommended 1
collection-mathscience 1
collection-pictures 1
instopt_letter 0
tlpdbopt_install_docfiles 0
tlpdbopt_install_srcfiles 0
EOF

    # install-tl normally calls `sw_vers -productVersion` (Apple) or
    # equivalent system tools to identify the host platform. Under
    # `nix develop --ignore-environment` (CI + scripts/dev-shell.sh),
    # those tools aren't on PATH and detection fails with "only
    # MacOSX is supported, not darwin" / "no binary platform
    # specified/available". Force the platform explicitly so install
    # proceeds without depending on host introspection.
    #
    # We don't actually use install-tl's downloaded binaries — pdftex
    # comes from our own wasm32 cross-build. The platform is named
    # purely so install-tl agrees to run; the binfiles end up in
    # texlive-dist/bin/<platform>/ unused.
    case "$(uname -s)" in
        Darwin) TL_PLATFORM=universal-darwin ;;
        Linux)
            case "$(uname -m)" in
                x86_64)         TL_PLATFORM=x86_64-linux ;;
                aarch64|arm64)  TL_PLATFORM=aarch64-linux ;;
                *) echo "ERROR: unsupported Linux arch: $(uname -m)" >&2; exit 1 ;;
            esac
            ;;
        *) echo "ERROR: unsupported OS: $(uname -s)" >&2; exit 1 ;;
    esac

    cd "$INSTALLER_DIR"
    perl install-tl \
        --profile="$TEXLIVE_DIR/texlive.profile" \
        --no-interaction \
        --force-platform="$TL_PLATFORM" \
        --repository="$TEXLIVE_REPOSITORY"
    cd "$REPO_ROOT"
fi

# ─── Step 2: Generate latex.fmt ────────────────────────────────
FMT_DIR="$TEXLIVE_DIR/texlive-fmt"
if [ ! -f "$FMT_DIR/latex.fmt" ]; then
    echo "==> Generating latex.fmt..."
    mkdir -p "$FMT_DIR"

    # Set up TEXMF paths for host pdftex
    export TEXMFDIST="$INSTALL_DIR/texmf-dist"
    export TEXMFCNF="$INSTALL_DIR/texmf-dist/web2c"

    # Create minimal language.dat with English only — the full
    # hyphen.cfg tries to load patterns for many languages (German,
    # French, etc.) that aren't installed with our minimal profile.
    cat > "$INSTALL_DIR/texmf-dist/tex/generic/config/language.dat" << 'LANGDAT'
english hyphen.tex
=usenglish
=USenglish
=american
dumylang dumyhyph.tex
nohyphenation zerohyph.tex
ukenglish loadhyph-en-gb.tex
=british
=UKenglish
usenglishmax loadhyph-en-us.tex
LANGDAT

    cd "$FMT_DIR"
    "$HOST_PDFTEX" -ini -jobname=latex \
        -progname=pdflatex \
        "*latex.ini"
    cd "$REPO_ROOT"
fi

# ─── Step 3: Pack bundle ──────────────────────────────────────
echo "==> Building TeX Live bundle..."
mkdir -p "$(dirname "$BUNDLE_FILE")"

node --experimental-strip-types - \
    "$INSTALL_DIR" "$FMT_DIR" "$BUNDLE_FILE" << 'BUNDLER'
import { readFileSync, readdirSync, statSync, lstatSync, writeFileSync } from "fs";
import { join } from "path";

const installDir = process.argv[2];
const fmtDir = process.argv[3];
const outFile = process.argv[4];

const texmfDist = join(installDir, "texmf-dist");

interface BundleEntry {
  path: string;
  data: string;
}

const files: BundleEntry[] = [];
let totalSize = 0;

// File extensions we need
const INCLUDE_EXTS = new Set([
  ".sty", ".cls", ".clo", ".def", ".cfg", ".fd", ".ldf",  // LaTeX macros
  ".tfm", ".vf",                                           // TeX font metrics
  ".pfb", ".pfa",                                          // Type1 fonts
  ".map", ".enc",                                          // Font mappings
  ".tex", ".ltx", ".ini",                                  // TeX sources
  ".cnf",                                                  // Config
]);

// Directories to skip
const SKIP_DIRS = new Set([
  "doc", "source", "man", "info",
  "context", "luatex", "xetex", "lualatex", "xelatex",
  "platex", "uplatex", "ptex", "uptex", "eptex",
]);

function shouldInclude(name: string): boolean {
  for (const ext of INCLUDE_EXTS) {
    if (name.endsWith(ext)) return true;
  }
  // Include .code.tex files (pgf/TikZ)
  if (name.endsWith(".code.tex")) return true;
  return false;
}

function scanDir(dir: string, vfsPrefix: string) {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }

  for (const entry of entries) {
    const fullPath = join(dir, entry);

    try {
      if (lstatSync(fullPath).isSymbolicLink()) continue;
    } catch { continue; }

    let stat;
    try { stat = statSync(fullPath); } catch { continue; }

    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      scanDir(fullPath, `${vfsPrefix}/${entry}`);
    } else if (stat.isFile() && shouldInclude(entry)) {
      const data = readFileSync(fullPath);
      totalSize += data.length;
      files.push({
        path: `${vfsPrefix}/${entry}`,
        data: data.toString("base64"),
      });
    }
  }
}

// Scan texmf-dist
scanDir(texmfDist, "/usr/share/texmf-dist");

// Scan texmf-var for generated files (e.g. pdftex.map from updmap)
const texmfVar = join(installDir, "texmf-var");
scanDir(texmfVar, "/usr/share/texmf-dist");

// Add format file
const fmtData = readFileSync(join(fmtDir, "latex.fmt"));
totalSize += fmtData.length;
files.push({
  path: "/usr/share/texmf-dist/web2c/pdftex/latex.fmt",
  data: fmtData.toString("base64"),
});

// Add texmf.cnf
const cnf = `% Minimal texmf.cnf for wasm-posix-kernel
TEXMFDIST = /usr/share/texmf-dist
TEXMF = {$TEXMFDIST}
TEXMFCNF = /usr/share/texmf-dist/web2c
TEXINPUTS = .;$TEXMF/tex/{latex,generic,}//
TFMFONTS = .;$TEXMF/fonts/tfm//
T1FONTS = .;$TEXMF/fonts/type1//
AFMFONTS = .;$TEXMF/fonts/afm//
VFFONTS = .;$TEXMF/fonts/vf//
ENCFONTS = .;$TEXMF/fonts/enc//
TEXFONTMAPS = .;$TEXMF/fonts/map/{pdftex,}//
TEXPSHEADERS = .;$TEXMF/fonts/type1//;$TEXMF/fonts/enc//
TEXFORMATS = .;$TEXMF/web2c/{pdftex,}
MFINPUTS = .;$TEXMF/metafont//;$TEXMF/fonts/source//
TEX_HUSH = all
`;
files.push({
  path: "/usr/share/texmf-dist/web2c/texmf.cnf",
  data: Buffer.from(cnf).toString("base64"),
});

// Sort for deterministic output
files.sort((a, b) => a.path.localeCompare(b.path));

writeFileSync(outFile, JSON.stringify({ files }, null, 0));

const bundleSize = statSync(outFile).size;
console.log(`Files: ${files.length}`);
console.log(`Source size: ${(totalSize / 1024 / 1024).toFixed(1)}MB`);
console.log(`Bundle size: ${(bundleSize / 1024 / 1024).toFixed(1)}MB`);
BUNDLER

echo "==> TeX Live bundle: $BUNDLE_FILE"
ls -lh "$BUNDLE_FILE"
