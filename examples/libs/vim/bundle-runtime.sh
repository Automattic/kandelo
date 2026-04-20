#!/usr/bin/env bash
set -euo pipefail

# Bundle a minimal Vim runtime for use in the browser shell demo.
#
# Vim needs runtime files for syntax highlighting, filetype detection,
# and default settings. The full runtime is ~30MB; this script copies
# only the essential files (~500KB).
#
# Output: examples/libs/vim/runtime/ (directory tree)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/vim-src"
RUNTIME_SRC="$SRC_DIR/runtime"
RUNTIME_OUT="$SCRIPT_DIR/runtime"

if [ ! -d "$RUNTIME_SRC" ]; then
    echo "ERROR: Vim source not found. Run build-vim.sh first." >&2
    exit 1
fi

echo "==> Bundling minimal Vim runtime..."

rm -rf "$RUNTIME_OUT"
mkdir -p "$RUNTIME_OUT/syntax" "$RUNTIME_OUT/colors" "$RUNTIME_OUT/ftplugin" \
         "$RUNTIME_OUT/indent" "$RUNTIME_OUT/plugin" "$RUNTIME_OUT/autoload" \
         "$RUNTIME_OUT/doc"

# Core vim scripts
for f in defaults.vim filetype.vim scripts.vim; do
    [ -f "$RUNTIME_SRC/$f" ] && cp "$RUNTIME_SRC/$f" "$RUNTIME_OUT/$f"
done

# Syntax loading infrastructure
for f in syntax.vim synload.vim syncolor.vim nosyntax.vim; do
    [ -f "$RUNTIME_SRC/syntax/$f" ] && cp "$RUNTIME_SRC/syntax/$f" "$RUNTIME_OUT/syntax/$f"
done

# Common syntax files (~20 languages)
SYNTAX_FILES=(
    c.vim cpp.vim python.vim javascript.vim typescript.vim
    sh.vim html.vim css.vim json.vim yaml.vim
    markdown.vim rust.vim go.vim lua.vim vim.vim
    make.vim conf.vim diff.vim gitcommit.vim help.vim
    text.vim xml.vim sql.vim java.vim dockerfile.vim
    toml.vim ini.vim sed.vim awk.vim perl.vim
    ruby.vim php.vim
)

for f in "${SYNTAX_FILES[@]}"; do
    [ -f "$RUNTIME_SRC/syntax/$f" ] && cp "$RUNTIME_SRC/syntax/$f" "$RUNTIME_OUT/syntax/$f"
done

# Filetype plugins for indentation
FTPLUGIN_FILES=(
    c.vim python.vim javascript.vim sh.vim html.vim
    json.vim yaml.vim markdown.vim rust.vim vim.vim
)

for f in "${FTPLUGIN_FILES[@]}"; do
    [ -f "$RUNTIME_SRC/ftplugin/$f" ] && cp "$RUNTIME_SRC/ftplugin/$f" "$RUNTIME_OUT/ftplugin/$f"
done

# Indent files
INDENT_FILES=(
    c.vim python.vim javascript.vim sh.vim html.vim vim.vim
)

for f in "${INDENT_FILES[@]}"; do
    [ -f "$RUNTIME_SRC/indent/$f" ] && cp "$RUNTIME_SRC/indent/$f" "$RUNTIME_OUT/indent/$f"
done

# Autoload files needed by the syntax system
for f in dist/ft.vim; do
    if [ -f "$RUNTIME_SRC/autoload/$f" ]; then
        mkdir -p "$(dirname "$RUNTIME_OUT/autoload/$f")"
        cp "$RUNTIME_SRC/autoload/$f" "$RUNTIME_OUT/autoload/$f"
    fi
done

# netrw — built-in file/directory browser (:Explore, :Vex, opening a dir)
# Local browsing uses vim's readdir/glob/stat only; no shell required.
# Remote features (scp/ftp/http) are not supported in this environment.
NETRW_PLUGIN_FILES=(netrwPlugin.vim)
for f in "${NETRW_PLUGIN_FILES[@]}"; do
    [ -f "$RUNTIME_SRC/plugin/$f" ] && cp "$RUNTIME_SRC/plugin/$f" "$RUNTIME_OUT/plugin/$f"
done

NETRW_AUTOLOAD_FILES=(netrw.vim netrwSettings.vim netrw_gitignore.vim)
for f in "${NETRW_AUTOLOAD_FILES[@]}"; do
    [ -f "$RUNTIME_SRC/autoload/$f" ] && cp "$RUNTIME_SRC/autoload/$f" "$RUNTIME_OUT/autoload/$f"
done

[ -f "$RUNTIME_SRC/syntax/netrw.vim" ] && cp "$RUNTIME_SRC/syntax/netrw.vim" "$RUNTIME_OUT/syntax/netrw.vim"

# A basic color scheme
[ -f "$RUNTIME_SRC/colors/default.vim" ] && cp "$RUNTIME_SRC/colors/default.vim" "$RUNTIME_OUT/colors/default.vim"

# Help files (doc/*.txt + tags) — enables :help
# Excludes version history files (version4-9.txt, ~4.7MB) which are rarely needed.
if [ -d "$RUNTIME_SRC/doc" ]; then
    for f in "$RUNTIME_SRC"/doc/*.txt; do
        case "$(basename "$f")" in
            version[0-9]*.txt) ;; # skip version history
            *) cp "$f" "$RUNTIME_OUT/doc/" ;;
        esac
    done
    [ -f "$RUNTIME_SRC/doc/tags" ] && cp "$RUNTIME_SRC/doc/tags" "$RUNTIME_OUT/doc/tags"
fi

# Count files and total size
FILE_COUNT=$(find "$RUNTIME_OUT" -type f | wc -l | tr -d ' ')
TOTAL_SIZE=$(du -sh "$RUNTIME_OUT" | cut -f1)

echo "==> Bundled $FILE_COUNT runtime files ($TOTAL_SIZE)"
echo "==> Output: $RUNTIME_OUT/"
