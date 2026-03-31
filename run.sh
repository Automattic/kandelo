#!/usr/bin/env bash
#
# Unified build, run, and test script for wasm-posix-kernel.
#
# Usage:
#   ./run.sh build [target...]    Build specific targets (or all)
#   ./run.sh rebuild [target...]  Force-rebuild (clean + build)
#   ./run.sh run <example> [args] Run a Node.js example
#   ./run.sh browser [args]       Start the Vite browser dev server
#   ./run.sh list                 Show available targets and examples
#   ./run.sh test [suite...]      Run test suites
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

# ─── Colors ───────────────────────────────────────────────────────────────────

if [ -t 1 ] && command -v tput &>/dev/null && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
    GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); CYAN=$(tput setaf 6)
    RED=$(tput setaf 1); BOLD=$(tput bold); RESET=$(tput sgr0)
else
    GREEN=""; YELLOW=""; CYAN=""; RED=""; BOLD=""; RESET=""
fi

info()  { echo "${GREEN}[OK]${RESET} $*"; }
warn()  { echo "${YELLOW}[>>]${RESET} $*"; }
err()   { echo "${RED}[!!]${RESET} $*" >&2; }
step()  { echo "${CYAN}${BOLD}=== $* ===${RESET}"; }

# ─── Artifact checks ─────────────────────────────────────────────────────────

has_kernel()    { [ -f "$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm" ]; }
has_sysroot()   { [ -f "$REPO_ROOT/sysroot/lib/libc.a" ]; }
has_sdk()       { command -v wasm32posix-cc &>/dev/null; }
has_host()      { [ -d "$REPO_ROOT/host/dist" ]; }
has_programs()  { [ -f "$REPO_ROOT/host/wasm/sh.wasm" ]; }
has_nginx()     { [ -f "$REPO_ROOT/examples/nginx/nginx.wasm" ]; }
has_php()       { [ -f "$REPO_ROOT/examples/libs/php/php-src/sapi/cli/php" ]; }
has_php_fpm()   { [ -f "$REPO_ROOT/examples/nginx/php-fpm.wasm" ]; }
has_mariadb()   { [ -f "$REPO_ROOT/examples/libs/mariadb/mariadb-install/bin/mariadbd" ]; }
has_wordpress() { [ -f "$REPO_ROOT/examples/wordpress/wordpress/wp-settings.php" ]; }
has_wp_bundle() { [ -f "$REPO_ROOT/examples/browser/public/wp-bundle.json" ]; }
has_dash()      { [ -f "$REPO_ROOT/examples/libs/dash/bin/dash.wasm" ]; }
has_coreutils() { [ -f "$REPO_ROOT/examples/libs/coreutils/bin/coreutils.wasm" ]; }
has_grep()      { [ -f "$REPO_ROOT/examples/libs/grep/bin/grep.wasm" ]; }
has_sed()       { [ -f "$REPO_ROOT/examples/libs/sed/bin/sed.wasm" ]; }
has_redis()     { [ -f "$REPO_ROOT/examples/libs/redis/bin/redis-server.wasm" ]; }
has_dlopen()    { [ -f "$REPO_ROOT/examples/dlopen/hello-lib.so" ] && \
                  [ -f "$REPO_ROOT/examples/dlopen/main.wasm" ]; }

# ─── Need functions (ensure dependency is built) ─────────────────────────────

need_kernel() {
    if ! has_kernel; then
        step "Building kernel"
        cd "$REPO_ROOT"
        cargo build --release \
            -Z build-std=core,alloc \
            -Z build-std-features=panic_immediate_abort
        mkdir -p host/wasm
        cp target/wasm32-unknown-unknown/release/wasm_posix_kernel.wasm host/wasm/
        cp target/wasm32-unknown-unknown/release/wasm_posix_userspace.wasm host/wasm/
        info "Kernel built"
    else
        info "Kernel"
    fi
}

need_sysroot() {
    if ! has_sysroot; then
        step "Building sysroot (musl)"
        bash "$REPO_ROOT/scripts/build-musl.sh"
        info "Sysroot built"
    else
        info "Sysroot"
    fi
}

need_sdk() {
    need_sysroot
    if ! has_sdk; then
        step "Installing SDK tools"
        cd "$REPO_ROOT/sdk" && npm link
        cd "$REPO_ROOT"
        info "SDK installed"
    else
        info "SDK"
    fi
}

need_host() {
    need_kernel
    if ! has_host; then
        step "Building TypeScript host"
        cd "$REPO_ROOT/host"
        npm install --prefer-offline
        npm run build
        cd "$REPO_ROOT"
        info "Host built"
    else
        info "Host"
    fi
}

need_node_modules() {
    if [ ! -d "$REPO_ROOT/node_modules" ]; then
        warn "Installing root npm dependencies"
        cd "$REPO_ROOT" && npm install --prefer-offline
    fi
}

# ─── Build targets ────────────────────────────────────────────────────────────

build_kernel() {
    need_kernel
}

build_sysroot() {
    need_sysroot
}

build_sdk() {
    need_sdk
}

build_host() {
    need_host
}

build_programs() {
    need_kernel
    need_sysroot
    if ! has_programs; then
        step "Building programs"
        bash "$REPO_ROOT/scripts/build-programs.sh"
        info "Programs built"
    else
        info "Programs"
    fi
}

build_nginx() {
    need_kernel
    need_sdk
    if ! has_nginx; then
        step "Building nginx"
        bash "$REPO_ROOT/examples/nginx/build.sh"
        info "nginx built"
    else
        info "nginx"
    fi
}

build_php() {
    need_kernel
    need_sdk
    if ! has_php; then
        step "Building PHP CLI"
        bash "$REPO_ROOT/examples/libs/php/build-php.sh"
        info "PHP CLI built"
    else
        info "PHP CLI"
    fi
}

build_php_fpm() {
    need_kernel
    need_sdk
    if ! has_php_fpm; then
        step "Building PHP-FPM"
        bash "$REPO_ROOT/examples/nginx/build-php-fpm.sh"
        info "PHP-FPM built"
    else
        info "PHP-FPM"
    fi
}

build_mariadb() {
    need_kernel
    need_sdk
    if ! has_mariadb; then
        step "Building MariaDB"
        bash "$REPO_ROOT/examples/libs/mariadb/build-mariadb.sh"
        info "MariaDB built"
    else
        info "MariaDB"
    fi
}

build_wordpress() {
    if ! has_wordpress; then
        step "Downloading WordPress"
        bash "$REPO_ROOT/examples/wordpress/setup.sh"
        info "WordPress downloaded"
    else
        info "WordPress"
    fi
}

build_wp_bundle() {
    build_wordpress
    if ! has_wp_bundle; then
        step "Building WordPress browser bundle"
        bash "$REPO_ROOT/examples/browser/scripts/build-wp-bundle.sh"
        info "WP bundle built"
    else
        info "WP bundle"
    fi
}

build_dash() {
    need_kernel
    need_sdk
    if ! has_dash; then
        step "Building dash shell"
        bash "$REPO_ROOT/examples/libs/dash/build-dash.sh"
        info "dash built"
    else
        info "dash"
    fi
}

build_coreutils() {
    need_kernel
    need_sdk
    if ! has_coreutils; then
        step "Building GNU coreutils"
        bash "$REPO_ROOT/examples/libs/coreutils/build-coreutils.sh"
        info "coreutils built"
    else
        info "coreutils"
    fi
}

build_grep() {
    need_kernel
    need_sdk
    if ! has_grep; then
        step "Building GNU grep"
        bash "$REPO_ROOT/examples/libs/grep/build-grep.sh"
        info "grep built"
    else
        info "grep"
    fi
}

build_sed() {
    need_kernel
    need_sdk
    if ! has_sed; then
        step "Building GNU sed"
        bash "$REPO_ROOT/examples/libs/sed/build-sed.sh"
        info "sed built"
    else
        info "sed"
    fi
}

build_redis() {
    need_kernel
    need_sdk
    if ! has_redis; then
        step "Building Redis"
        bash "$REPO_ROOT/examples/libs/redis/build-redis.sh"
        info "Redis built"
    else
        info "Redis"
    fi
}

build_dlopen() {
    need_sysroot
    if ! has_dlopen; then
        step "Building dlopen example"
        bash "$REPO_ROOT/examples/dlopen/build.sh"
        info "dlopen built"
    else
        info "dlopen"
    fi
}

build_target() {
    local target="$1"
    case "$target" in
        kernel)     build_kernel ;;
        sysroot)    build_sysroot ;;
        sdk)        build_sdk ;;
        host)       build_host ;;
        programs)   build_programs ;;
        nginx)      build_nginx ;;
        php)        build_php ;;
        php-fpm)    build_php_fpm ;;
        dash)       build_dash ;;
        coreutils)  build_coreutils ;;
        grep)       build_grep ;;
        sed)        build_sed ;;
        mariadb)    build_mariadb ;;
        redis)      build_redis ;;
        wordpress)  build_wordpress ;;
        wp-bundle)  build_wp_bundle ;;
        dlopen)     build_dlopen ;;
        all)        build_all ;;
        *)          err "Unknown build target: $target"; cmd_list; exit 1 ;;
    esac
}

build_all() {
    build_kernel
    build_sysroot
    build_sdk
    build_host
    build_programs
    build_dash
    build_coreutils
    build_grep
    build_sed
    build_nginx
    build_php
    build_php_fpm
    build_mariadb
    build_redis
    build_wordpress
    build_wp_bundle
    build_dlopen
}

# ─── Clean targets ────────────────────────────────────────────────────────────

clean_target() {
    local target="$1"
    case "$target" in
        kernel)
            rm -f "$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm" \
                  "$REPO_ROOT/host/wasm/wasm_posix_userspace.wasm"
            rm -rf "$REPO_ROOT/target/wasm32-unknown-unknown/"
            warn "Cleaned kernel" ;;
        sysroot)
            rm -rf "$REPO_ROOT/sysroot"
            warn "Cleaned sysroot" ;;
        sdk)
            warn "SDK is installed globally via npm link — run 'npm unlink -g wasm32posix' to remove"
            ;;
        host)
            rm -rf "$REPO_ROOT/host/dist"
            warn "Cleaned host" ;;
        programs)
            rm -f "$REPO_ROOT/host/wasm/sh.wasm"
            rm -f "$REPO_ROOT/host/wasm/"*.wasm 2>/dev/null || true
            # Keep kernel wasm files
            if [ -f "$REPO_ROOT/target/wasm32-unknown-unknown/release/wasm_posix_kernel.wasm" ]; then
                mkdir -p "$REPO_ROOT/host/wasm"
                cp "$REPO_ROOT/target/wasm32-unknown-unknown/release/wasm_posix_kernel.wasm" "$REPO_ROOT/host/wasm/"
                cp "$REPO_ROOT/target/wasm32-unknown-unknown/release/wasm_posix_userspace.wasm" "$REPO_ROOT/host/wasm/"
            fi
            warn "Cleaned programs" ;;
        dash)
            rm -rf "$REPO_ROOT/examples/libs/dash/dash-src" \
                   "$REPO_ROOT/examples/libs/dash/bin"
            warn "Cleaned dash" ;;
        coreutils)
            rm -rf "$REPO_ROOT/examples/libs/coreutils/coreutils-src" \
                   "$REPO_ROOT/examples/libs/coreutils/bin"
            warn "Cleaned coreutils" ;;
        grep)
            rm -rf "$REPO_ROOT/examples/libs/grep/grep-src" \
                   "$REPO_ROOT/examples/libs/grep/bin"
            warn "Cleaned grep" ;;
        sed)
            rm -rf "$REPO_ROOT/examples/libs/sed/sed-src" \
                   "$REPO_ROOT/examples/libs/sed/bin"
            warn "Cleaned sed" ;;
        nginx)
            rm -rf "$REPO_ROOT/examples/nginx/nginx-src"
            rm -f "$REPO_ROOT/examples/nginx/nginx.wasm"
            warn "Cleaned nginx" ;;
        php)
            rm -rf "$REPO_ROOT/examples/libs/php/php-src" \
                   "$REPO_ROOT/examples/libs/php/php-install"
            warn "Cleaned PHP CLI" ;;
        php-fpm)
            rm -f "$REPO_ROOT/examples/nginx/php-fpm.wasm"
            rm -rf "$REPO_ROOT/examples/nginx/php-fpm-src"
            warn "Cleaned PHP-FPM" ;;
        mariadb)
            rm -rf "$REPO_ROOT/examples/libs/mariadb/mariadb-src" \
                   "$REPO_ROOT/examples/libs/mariadb/mariadb-install"
            warn "Cleaned MariaDB" ;;
        redis)
            rm -rf "$REPO_ROOT/examples/libs/redis/redis-src" \
                   "$REPO_ROOT/examples/libs/redis/bin"
            warn "Cleaned Redis" ;;
        wordpress)
            rm -rf "$REPO_ROOT/examples/wordpress/wordpress"
            warn "Cleaned WordPress" ;;
        wp-bundle)
            rm -f "$REPO_ROOT/examples/browser/public/wp-bundle.json"
            warn "Cleaned WP bundle" ;;
        dlopen)
            rm -f "$REPO_ROOT/examples/dlopen/hello-lib.so" \
                  "$REPO_ROOT/examples/dlopen/main.wasm"
            warn "Cleaned dlopen" ;;
        all)
            for t in kernel sysroot host programs dash coreutils grep sed nginx php php-fpm mariadb redis wordpress wp-bundle dlopen; do
                clean_target "$t"
            done ;;
        *)  err "Unknown clean target: $target"; exit 1 ;;
    esac
}

# ─── Commands ─────────────────────────────────────────────────────────────────

cmd_build() {
    if [ $# -eq 0 ]; then
        build_all
    else
        for t in "$@"; do
            build_target "$t"
        done
    fi
    echo ""
    info "Build complete"
}

cmd_rebuild() {
    if [ $# -eq 0 ]; then
        err "Usage: $0 rebuild <target...>"
        err "Use 'rebuild all' to rebuild everything"
        exit 1
    fi
    for t in "$@"; do
        clean_target "$t"
        build_target "$t"
    done
    echo ""
    info "Rebuild complete"
}

cmd_run() {
    if [ $# -eq 0 ]; then
        err "Usage: $0 run <example> [args...]"
        err "Examples: shell, nginx, redis, mariadb, wordpress, wordpress-nginx, lamp, dlopen"
        exit 1
    fi

    local example="$1"; shift
    need_node_modules

    case "$example" in
        nginx)
            build_nginx
            step "Starting nginx"
            exec npx tsx "$REPO_ROOT/examples/nginx/serve.ts" "$@"
            ;;
        mariadb)
            build_mariadb
            step "Starting MariaDB"
            exec npx tsx "$REPO_ROOT/examples/mariadb/serve.ts" "$@"
            ;;
        redis)
            build_redis
            step "Starting Redis"
            exec npx tsx "$REPO_ROOT/examples/redis/serve.ts" "$@"
            ;;
        wordpress)
            build_php
            build_wordpress
            step "Starting WordPress (PHP built-in server + SQLite)"
            exec npx tsx "$REPO_ROOT/examples/wordpress/serve.ts" "$@"
            ;;
        wordpress-nginx)
            build_nginx
            build_php_fpm
            build_wordpress
            step "Starting WordPress (nginx + PHP-FPM + SQLite)"
            exec npx tsx "$REPO_ROOT/examples/wordpress/serve-nginx.ts" "$@"
            ;;
        lamp)
            build_mariadb
            build_nginx
            build_php_fpm
            # LAMP uses its own WordPress setup (MySQL mode)
            if [ ! -f "$REPO_ROOT/examples/lamp/wordpress/wp-settings.php" ]; then
                step "Setting up LAMP WordPress"
                bash "$REPO_ROOT/examples/lamp/setup.sh"
            fi
            step "Starting LAMP stack (MariaDB + PHP-FPM + nginx + WordPress)"
            exec npx tsx "$REPO_ROOT/examples/lamp/serve.ts" "$@"
            ;;
        shell)
            build_programs
            build_dash
            build_coreutils
            build_grep
            build_sed
            need_host
            step "Starting interactive shell"
            exec npx tsx "$REPO_ROOT/examples/shell/serve.ts" "$@"
            ;;
        dlopen)
            build_dlopen
            step "Running dlopen example"
            exec npx tsx "$REPO_ROOT/examples/dlopen/serve.ts" "$@"
            ;;
        *)
            err "Unknown example: $example"
            err "Available: shell, nginx, redis, mariadb, wordpress, wordpress-nginx, lamp, dlopen"
            exit 1
            ;;
    esac
}

cmd_browser() {
    local BROWSER_DIR="$REPO_ROOT/examples/browser"

    # Build all wasm artifacts needed by browser demos:
    #   simple: kernel + programs
    #   shell:  kernel + dash + coreutils + grep + sed
    #   php:    kernel + php
    #   nginx:  kernel + nginx
    #   nginx-php: kernel + nginx + php-fpm
    #   mariadb: kernel + mariadb
    #   wordpress: kernel + nginx + php-fpm + wp-bundle
    #   redis: kernel + redis
    #   lamp: kernel + nginx + php-fpm + mariadb + wp-bundle
    build_kernel
    build_sysroot
    build_programs
    build_dash
    build_coreutils
    build_grep
    build_sed
    build_nginx
    build_php
    build_php_fpm
    build_mariadb
    build_redis
    build_wp_bundle

    # Install browser deps if needed
    if [ ! -d "$BROWSER_DIR/node_modules" ]; then
        warn "Installing browser example dependencies"
        cd "$BROWSER_DIR" && npm install && cd "$REPO_ROOT"
    fi

    step "Starting Vite browser dev server"
    cd "$BROWSER_DIR"
    exec npx vite "$@"
}

cmd_test() {
    local suites=("$@")
    if [ ${#suites[@]} -eq 0 ]; then
        suites=(cargo vitest libc posix)
    fi

    local failed=0
    for suite in "${suites[@]}"; do
        case "$suite" in
            cargo)
                step "Running cargo tests"
                if ! cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib; then
                    failed=1
                fi
                ;;
            vitest)
                step "Running vitest"
                cd "$REPO_ROOT/host"
                if ! npx vitest run; then
                    failed=1
                fi
                cd "$REPO_ROOT"
                ;;
            libc)
                step "Running libc-test suite"
                if ! bash "$REPO_ROOT/scripts/run-libc-tests.sh"; then
                    failed=1
                fi
                ;;
            posix)
                step "Running POSIX test suite"
                if ! bash "$REPO_ROOT/scripts/run-posix-tests.sh"; then
                    failed=1
                fi
                ;;
            sortix)
                step "Running Sortix test suite"
                if ! bash "$REPO_ROOT/scripts/run-sortix-tests.sh" --all; then
                    failed=1
                fi
                ;;
            browser)
                step "Running browser E2E tests"
                cd "$REPO_ROOT/examples/browser"
                [ -d node_modules ] || npm install
                if ! npx playwright test --grep-invert "@slow"; then
                    failed=1
                fi
                cd "$REPO_ROOT"
                ;;
            browser-all)
                step "Running ALL browser E2E tests (including @slow)"
                cd "$REPO_ROOT/examples/browser"
                [ -d node_modules ] || npm install
                if ! npx playwright test; then
                    failed=1
                fi
                cd "$REPO_ROOT"
                ;;
            all)
                cmd_test cargo vitest libc posix sortix browser
                return $?
                ;;
            *)
                err "Unknown test suite: $suite"
                err "Available: cargo, vitest, libc, posix, sortix, browser, browser-all, all"
                exit 1
                ;;
        esac
    done

    if [ "$failed" -ne 0 ]; then
        err "Some test suites failed"
        exit 1
    fi
    info "All test suites passed"
}

cmd_list() {
    echo "${BOLD}Build targets:${RESET}"
    echo "  kernel      Rust kernel + userspace Wasm         $(has_kernel && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  sysroot     musl libc sysroot                    $(has_sysroot && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  sdk         SDK cross-compilation tools           $(has_sdk && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  host        TypeScript host (tsup)                $(has_host && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  programs    Simple C programs (sh, cat, ls, ...)  $(has_programs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  dash        dash 0.5.12 shell                      $(has_dash && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  coreutils   GNU coreutils 9.6                      $(has_coreutils && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  grep        GNU grep 3.11                          $(has_grep && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  sed         GNU sed 4.9                            $(has_sed && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  nginx       nginx 1.24 Wasm binary                $(has_nginx && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  php         PHP 8.3 CLI binary                    $(has_php && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  php-fpm     PHP-FPM Wasm binary                   $(has_php_fpm && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  mariadb     MariaDB 10.5 Wasm binary              $(has_mariadb && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  redis       Redis 7.2 Wasm binary                 $(has_redis && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  wordpress   WordPress + SQLite plugin             $(has_wordpress && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  wp-bundle   WordPress browser bundle              $(has_wp_bundle && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  dlopen      dlopen shared library example          $(has_dlopen && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  all         Build everything"
    echo ""
    echo "${BOLD}Run examples:${RESET}"
    echo "  ./run.sh run shell                   Interactive shell (dash + coreutils + grep + sed)"
    echo "  ./run.sh run nginx [port]            nginx HTTP server"
    echo "  ./run.sh run redis [port]            Redis key-value store"
    echo "  ./run.sh run mariadb                 MariaDB standalone"
    echo "  ./run.sh run wordpress [port]        WordPress (PHP built-in + SQLite)"
    echo "  ./run.sh run wordpress-nginx [port]  WordPress (nginx + PHP-FPM + SQLite)"
    echo "  ./run.sh run lamp [port]             Full LAMP stack (MariaDB + nginx + PHP-FPM)"
    echo "  ./run.sh run dlopen                  dlopen shared library demo"
    echo ""
    echo "${BOLD}Browser:${RESET}"
    echo "  ./run.sh browser                     Start Vite dev server for browser demos"
    echo ""
    echo "${BOLD}Test suites:${RESET}"
    echo "  ./run.sh test                        Run default suites (cargo + vitest + libc + posix)"
    echo "  ./run.sh test cargo                  Kernel unit tests"
    echo "  ./run.sh test vitest                 Host integration tests"
    echo "  ./run.sh test libc                   musl libc-test conformance"
    echo "  ./run.sh test posix                  Open POSIX test suite"
    echo "  ./run.sh test sortix                 Sortix os-test suite"
    echo "  ./run.sh test browser                Browser E2E tests (fast only)"
    echo "  ./run.sh test browser-all            Browser E2E tests (including slow)"
    echo "  ./run.sh test all                    All suites including sortix + browser"
}

# ─── Main dispatch ────────────────────────────────────────────────────────────

case "${1:-list}" in
    build)    cmd_build "${@:2}" ;;
    rebuild)  cmd_rebuild "${@:2}" ;;
    run)      cmd_run "${@:2}" ;;
    browser)  cmd_browser "${@:2}" ;;
    test)     cmd_test "${@:2}" ;;
    list)     cmd_list ;;
    -h|--help|help) cmd_list ;;
    *)
        err "Unknown command: $1"
        echo ""
        cmd_list
        exit 1
        ;;
esac
