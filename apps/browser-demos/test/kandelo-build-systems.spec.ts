import { expect } from "../playwright-test";
import { test } from "./support/persistent-page";
import { runTerminalCommand } from "./support/terminal-command";
import { gotoMachineOrSkip } from "./support/kandelo-machine";

// The shell's build systems work in the browser as they do on the Node host
// (host/test/guest-autotools, guest-cmake and guest-meson): one C project, a
// static library and a program linked against it, is configured, built and
// run with CMake and make, with Meson and Ninja, and with autoreconf,
// ./configure and make. Each tool, the SDK and Perl/Python are fetched
// lazily on first use, as a user's session would.
const files = String.raw`
cat > add.c <<'EOF'
int add(int a, int b) { return a + b; }
EOF
cat > main.c <<'EOF'
#include <stdio.h>
int add(int, int);
int main(void) { printf("%d\n", add(2, 3)); return 0; }
EOF
cat > CMakeLists.txt <<'EOF'
cmake_minimum_required(VERSION 3.20)
project(sum C)
add_library(add STATIC add.c)
add_executable(app main.c)
target_link_libraries(app add)
EOF
cat > meson.build <<'EOF'
project('sum', 'c')
add = static_library('add', 'add.c')
executable('app', 'main.c', link_with : add)
EOF
cat > configure.ac <<'EOF'
AC_INIT([sum], [1])
AM_INIT_AUTOMAKE([foreign])
AC_PROG_CC
AC_PROG_RANLIB
AC_CONFIG_FILES([Makefile])
AC_OUTPUT
EOF
cat > Makefile.am <<'EOF'
noinst_LIBRARIES = libadd.a
libadd_a_SOURCES = add.c
bin_PROGRAMS = app
app_SOURCES = main.c
app_LDADD = libadd.a
EOF
`;

// Each step logs to a file; on failure the step's log tail is printed, so a
// failed run shows which tool failed and why.
function step(name: string, log: string, command: string): string {
  return `if ! ( ${command} ) > ${log} 2>&1; then\n` +
    `  printf 'step failed: %s\\n' '${name}'; tail -n 30 ${log}; exit 1\nfi\n`;
}

test("CMake, Meson and autotools build and run a project in the shell @slow", async ({ page }) => {
  // Every tool runs inside the machine: cmake, the SDK compiler (about eight
  // clang processes per link), Meson on Python, Perl's autoconf and
  // automake, and configure's own compile-and-run checks.
  test.setTimeout(2_400_000);
  await gotoMachineOrSkip(page, "shell");
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });

  const script = `set -e\nwork=$(mktemp -d)\ncd "$work"\n${files}` +
    step("cmake", "cmake.log", "cmake -S . -B cmake-build && cmake --build cmake-build") +
    step("meson", "meson.log", "meson setup meson-build && ninja -C meson-build") +
    step("autotools", "autotools.log", "autoreconf -fi && ./configure && make") +
    `grep -q 'whether we are cross compiling... no' autotools.log || { printf 'configure ran as a cross build\\n'; exit 1; }\n` +
    `results="$(./cmake-build/app) $(./meson-build/app) $(./app)"\n` +
    // Assembled by the running shell, so it cannot match the pasted script.
    `printf '%s %s %s\\n' build-systems verified "$results"`;
  const { output, exitCode } = await runTerminalCommand(page, script, "build-systems verified 5 5 5", 2_100_000);
  expect(exitCode, output).toBe(0);
});
