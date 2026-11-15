#!/usr/bin/env python3
"""Build minimal C algorithm variants and actual O2/O3/LTO profiles."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

MODES = ["native", "generic", "span", "cache", "aligned", "vector", "opaque", "combined"]


def read(mode, p="p", cached="c"):
    if mode == "native":
        return f"raw_read({p})"
    if mode in ["cache", "combined"]:
        return f"cached_read({p}, root, &{cached}, {int(mode == 'combined')})"
    if mode == "aligned":
        return f"aligned_read({p}, root)"
    if mode == "opaque":
        return f"opaque_read({p}, root)"
    return f"read32({p}, root)"


def write(mode, p="p", value="i"):
    if mode == "native":
        return f"raw_write({p}, {value});"
    if mode in ["cache", "combined"]:
        return f"cached_write({p}, {value}, root, &c, {int(mode == 'combined')});"
    if mode == "aligned":
        return f"aligned_write({p}, {value}, root);"
    if mode == "opaque":
        return f"opaque_write({p}, {value}, root);"
    return f"write32({p}, {value}, root);"


def source():
    result = '#include "optimization.h"\n'
    # Scalar loops intentionally retain scalar memory operations. Explicit
    # SIMD variants below have a separately matched native SIMD control.
    for mode in MODES:
        load_body = read(mode)
        store_body = write(mode, value="v")
        if mode in ["span", "combined"]:
            load_body = f"(physical ? raw_read(physical) : {load_body})"
            store_body = f"if (physical) raw_write(physical, v); else {{ {store_body} }}"
        result += f'''__attribute__((export_name("{mode}_load")))
uint32_t {mode}_load(uint32_t p, uint32_t root) {{
    Cache c = {{ UINT32_MAX, 0 }}; uint32_t physical = 0;
    {'physical = try_span(p, 4, 1, root);' if mode in ['span', 'combined'] else ''}
    return {load_body};
}}
__attribute__((export_name("{mode}_store")))
void {mode}_store(uint32_t p, uint32_t v, uint32_t root) {{
    Cache c = {{ UINT32_MAX, 0 }}; uint32_t physical = 0;
    {'physical = try_span(p, 4, 2, root);' if mode in ['span', 'combined'] else ''}
    {store_body}
}}\n'''
        for op in ["read", "write", "chase", "fields", "atomic"]:
            body = ""
            if op in ["read", "write"]:
                if mode == "aligned":
                    operation = "sum += raw_read(address(p, 4, 1, root));" if op == "read" else "raw_write(address(p, 4, 2, root), i);"
                    body += f"if (!(base & 3)) {{ for (uint32_t i = 0; i < n; i++) {{ uint32_t p = base + ((i << 2) & mask); {operation} }} return sum; }}"
                body += "uint32_t physical = 0;"
                if mode in ["span", "combined"]:
                    rights = 1 if op == "read" else 2
                    body += f"if (mask <= LIMIT - 4) physical = try_span(base, mask + 4, {rights}, root);"
                if mode == "native":
                    body += "physical = base;"
                body += "for (uint32_t i = 0; i < n; i++) { uint32_t offset = (i << 2) & mask; uint32_t p = base + offset;"
                if op == "read":
                    body += f"sum += physical ? raw_read(physical + offset) : {read(mode)};"
                else:
                    body += f"if (physical) raw_write(physical + offset, i); else {{ {write(mode)} }}"
                body += "}"
            elif op == "chase":
                body += "uint32_t p = base, physical = 0;"
                if mode in ["span", "combined"]:
                    body += "if (mask <= LIMIT - 4) physical = try_span(base, mask + 4, 1, root);"
                body += "for (uint32_t i = 0; i < n; i++) {"
                body += f"p = physical && p - base <= mask ? raw_read(physical + p - base) : {read(mode)};"
                body += "sum ^= p - base; }"
            elif op == "fields":
                body += "uint32_t p = base; for (uint32_t i = 0; i < n; i++) { uint32_t physical = 0;"
                if mode in ["span", "combined"]:
                    body += "physical = try_span(p, 16, 1, root);"
                if mode == "native":
                    body += "physical = p;"
                body += f"uint32_t next = physical ? raw_read(physical) : {read(mode)};"
                body += f"uint32_t v1 = physical ? raw_read(physical + 4) : {read(mode, 'p + 4')};"
                body += f"uint32_t v2 = physical ? raw_read(physical + 8) : {read(mode, 'p + 8')};"
                body += f"uint32_t v3 = physical ? raw_read(physical + 12) : {read(mode, 'p + 12')};"
                body += "sum ^= (next - base) ^ v1 ^ v2 ^ v3; p = next; }"
            else:
                body += "uint32_t physical = 0;"
                if mode in ["span", "combined"]:
                    body += "physical = try_span(base, 4, 3, root);"
                if mode == "native":
                    body += "physical = base;"
                body += "for (uint32_t i = 0; i < n; i++) { uint32_t a;"
                if mode in ["cache", "combined"]:
                    fallback = "cached_address(base, 3, root, &c)"
                else:
                    fallback = "address(base, 4, 3, root)"
                body += f"a = physical ? physical : {fallback}; if (a & 3) __builtin_trap();"
                body += "sum += __atomic_fetch_add((uint32_t *)(uintptr_t)a, 1, __ATOMIC_SEQ_CST); }"
            result += f'''__attribute__((export_name("{mode}_{op}")))
uint32_t kernel_{mode}_{op}(uint32_t n, uint32_t base, uint32_t mask, uint32_t root, uint32_t scratch) {{
    (void)scratch; uint32_t sum = 0; Cache c = {{ UINT32_MAX, 0 }};
    if (!n) return 0; {body} return sum;
}}\n'''
    # Bulk operation comparison includes an explicitly scalarized control;
    # the existing WAT prototype already preserves bulk copies.
    for mode in ["native", "generic", "scalarized", "combined"]:
        physical = "uint32_t d = base, s = mask;" if mode == "native" else "uint32_t d = try_span(base, 65536, 2, root), s = try_span(mask, 65536, 1, root);"
        fast = "" if mode == "scalarized" else "if (d && s) { __builtin_memmove((void *)(uintptr_t)d, (void *)(uintptr_t)s, 65536); continue; }"
        result += f'''__attribute__((export_name("{mode}_copy")))
uint32_t {mode}_copy(uint32_t n, uint32_t base, uint32_t mask, uint32_t root, uint32_t scratch) {{
    for (uint32_t repeat = 0; repeat < n; repeat++) {{
        {physical} {fast}
        // Preserve memory.copy's all-or-nothing access admission even for a
        // fragmented slow path, before staging or changing destination bytes.
        validate_span(mask, 65536, 1, root);
        validate_span(base, 65536, 2, root);
        for (uint32_t j = 0; j < 65536; j++)
            *(uint8_t *)(uintptr_t)(scratch + j) = *(uint8_t *)(uintptr_t)address(mask + j, 1, 1, root);
        for (uint32_t j = 0; j < 65536; j++)
            *(uint8_t *)(uintptr_t)address(base + j, 1, 2, root) = *(uint8_t *)(uintptr_t)(scratch + j);
    }} return 0;
}}\n'''
    for mode in ["native", "vector", "combined"]:
        for op in ["read", "write"]:
            name = f"{mode}_simd_{op}"
            rights = 1 if op == "read" else 2
            span = "uint32_t physical = base;" if mode == "native" else (
                f"uint32_t physical = mask <= LIMIT - 4 ? try_span(base, mask + 4, {rights}, root) : 0;" if mode == "combined" else "uint32_t physical = 0;")
            scalar_read = "raw_read(base + ((i << 2) & mask))" if mode == "native" else "read32(base + ((i << 2) & mask), root)"
            scalar_write = "raw_write(base + ((i << 2) & mask), i);" if mode == "native" else "write32(base + ((i << 2) & mask), i, root);"
            if op == "read":
                fallback_read = "cached_vector_read(base + offset, root, &c)" if mode == "combined" else "vector_read(base + offset, root)"
                vector = "wasm_v128_load((void *)(uintptr_t)(physical + offset))" if mode == "native" else f"(physical ? wasm_v128_load((void *)(uintptr_t)(physical + offset)) : {fallback_read})"
                step = f"acc = wasm_i32x4_add(acc, {vector});"
                tail = f"sum += {scalar_read};"
            else:
                value = "wasm_i32x4_make(i, i + 1, i + 2, i + 3)"
                fallback_write = f"cached_vector_write(base + offset, {value}, root, &c);" if mode == "combined" else f"vector_write(base + offset, {value}, root);"
                step = f"wasm_v128_store((void *)(uintptr_t)(physical + offset), {value});" if mode == "native" else f"if (physical) wasm_v128_store((void *)(uintptr_t)(physical + offset), {value}); else {fallback_write}"
                tail = scalar_write
            result += f'''__attribute__((export_name("{name}")))
uint32_t {name}(uint32_t n, uint32_t base, uint32_t mask, uint32_t root, uint32_t scratch) {{
    if (!n) return 0;
    // A cyclic SIMD loop needs a power-of-two window containing whole vectors.
    uint32_t length = mask + 4;
    if (mask > LIMIT - 4 || length < 16 || (length & (length - 1)))
        return kernel_{mode if mode != 'vector' else 'generic'}_{op}(n, base, mask, root, scratch);
    {span} uint32_t i = 0, sum = 0; v128_t acc = wasm_i32x4_splat(0); Cache c = {{ UINT32_MAX, 0 }};
    for (; n - i >= 4; i += 4) {{ uint32_t offset = (i << 2) & mask; {step} }}
    sum = (uint32_t)wasm_i32x4_extract_lane(acc, 0) + (uint32_t)wasm_i32x4_extract_lane(acc, 1)
        + (uint32_t)wasm_i32x4_extract_lane(acc, 2) + (uint32_t)wasm_i32x4_extract_lane(acc, 3);
    for (; i < n; i++) {{ {tail} }} return sum;
}}\n'''
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    here = Path(__file__).resolve().parent
    compiler = str(Path(os.environ["LLVM_BIN"]) / "clang")
    code = out / "optimization-kernels.c"
    code.write_text(source())
    common = ["--target=wasm32-unknown-unknown", "-ffreestanding", "-fno-builtin",
              "-matomics", "-mbulk-memory", "-msimd128", "-I", str(here)]
    link = ["-fuse-ld=" + str(Path(os.environ["LLVM_BIN"]) / "wasm-ld"), "-nostdlib", "-Wl,--no-entry", "-Wl,--import-memory", "-Wl,--initial-memory=67108864",
            "-Wl,--max-memory=134217728", "-Wl,--shared-memory", "-Wl,--export=__stack_pointer", "-Wl,-z,stack-size=65536"]
    receipt = {"compiler": subprocess.check_output([compiler, "--version"], text=True), "compilerPath": compiler, "profiles": {},
               "scope": "manually expressed C memory-access transforms; not a general instrumenter"}
    for name, flags in [("O2", ["-O2"]), ("O3", ["-O3"]), ("O3-lto", ["-O3", "-flto"]),
                        ("O3-lto-auto", ["-O3", "-flto"]), ("O3-lto-post", ["-O3", "-flto"])]:
        profile_common = common + ([] if name in ["O3-lto-auto", "O3-lto-post"] else ["-fno-vectorize", "-fno-slp-vectorize"])
        objects = []
        for tag, src in [("kernels", code), ("access", here / "optimization-access.c")]:
            obj = out / f"{name}-{tag}.o"
            command = [compiler, *profile_common, *flags, "-c", str(src), "-o", str(obj)]
            subprocess.run(command, check=True)
            objects.append(str(obj))
        wasm = out / f"optimization-{name}.wasm"
        command = [compiler, *profile_common, *flags, *link, *objects, "-o", str(wasm)]
        subprocess.run(command, check=True)
        post_flags = []
        if name == "O3-lto-post":
            temporary = out / "post-optimized.wasm"
            post_flags = ["-O3", "--enable-threads", "--enable-bulk-memory", "--enable-simd"]
            subprocess.run(["wasm-opt", str(wasm), *post_flags, "-o", str(temporary)], check=True)
            temporary.replace(wasm)
        subprocess.run(["wasm-validate", "--enable-threads", str(wasm)], check=True)
        subprocess.run(["wasm2wat", "--enable-threads", str(wasm), "-o", str(wasm.with_suffix('.wat'))], check=True)
        subprocess.run([compiler, *profile_common, *flags, "-S", "-emit-llvm", str(code), "-o", str(out / f"optimization-{name}.ll")], check=True)
        receipt["profiles"][name] = {"common": profile_common, "flags": flags, "link": link, "postFlags": post_flags,
                                     "bytes": wasm.stat().st_size, "sha256": hashlib.sha256(wasm.read_bytes()).hexdigest()}
    receipt["postOptimizer"] = subprocess.check_output(["wasm-opt", "--version"], text=True).strip()
    (out / "optimization-build.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
