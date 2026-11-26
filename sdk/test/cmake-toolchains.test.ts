import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../..");

it.each([
  ["wasm32", "sysroot", "kandelo-toolchain.cmake", 4],
  ["wasm64", "sysroot64", "kandelo-wasm64-toolchain.cmake", 8],
] as const)("%s CMake toolchain identifies Kandelo and links probes", (_arch, sysroot, toolchain, pointerSize) => {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-cmake-toolchain-"));
  const build = join(dir, "build");
  const env = {
    ...process.env,
    PATH: [join(repo, "sdk", "bin"), process.env.PATH].join(delimiter),
    WASM_POSIX_SYSROOT: join(repo, sysroot),
  };

  try {
    writeFileSync(join(dir, "CMakeLists.txt"), `
cmake_minimum_required(VERSION 3.18)
project(sdk_probe C)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Kandelo" OR NOT UNIX STREQUAL "1")
  message(FATAL_ERROR "Expected Kandelo Unix, got \${CMAKE_SYSTEM_NAME} UNIX=\${UNIX}")
endif()
if(NOT CMAKE_SIZEOF_VOID_P EQUAL ${pointerSize})
  message(FATAL_ERROR "Unexpected pointer size \${CMAKE_SIZEOF_VOID_P}")
endif()
if(NOT CMAKE_TRY_COMPILE_TARGET_TYPE STREQUAL "EXECUTABLE")
  message(FATAL_ERROR "Feature probes must link executables")
endif()

include(CheckFunctionExists)
check_function_exists(puts HAVE_PUTS)
check_function_exists(kandelo_test_missing_function HAVE_MISSING_FUNCTION)
if(NOT HAVE_PUTS OR HAVE_MISSING_FUNCTION)
  message(FATAL_ERROR "Incorrect link probes: puts=\${HAVE_PUTS} missing=\${HAVE_MISSING_FUNCTION}")
endif()

add_executable(sdk_probe main.c)
`);
    writeFileSync(join(dir, "main.c"), '#include <stdio.h>\nint main(void) { return puts("SDK"); }\n');
    execFileSync("cmake", [
      "-S", dir, "-B", build,
      `-DCMAKE_TOOLCHAIN_FILE=${join(repo, "sdk", "cmake", toolchain)}`,
    ], { env });
    execFileSync("cmake", ["--build", build], { env });

    expect(readFileSync(join(build, "sdk_probe.wasm")).subarray(0, 4)).toEqual(
      Buffer.from([0, 0x61, 0x73, 0x6d]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
