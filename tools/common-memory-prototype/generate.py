#!/usr/bin/env python3
"""Generate matched, trusted Wasm mechanisms, not a general C/Wasm rewriter."""
import argparse
import json
from pathlib import Path
import subprocess

LIMIT = 64 * 1024 * 1024
PAGE = 65536


def address(p, width, rights):
    # The page table stores physical page bases with R/W bits in the low bits.
    # Metadata is stable while a guest call runs. This is not an unmap protocol.
    return f"""(block (result i32)
      (local.set $va {p})
      (if (i32.gt_u (local.get $va) (i32.const {LIMIT-width})) (then unreachable))
      (local.set $entry (i32.load (i32.add (global.get $root)
        (i32.shl (i32.shr_u (local.get $va) (i32.const 16)) (i32.const 2)))))
      (if (i32.ne (i32.and (local.get $entry) (i32.const {rights})) (i32.const {rights}))
        (then unreachable))
      (i32.or (i32.and (local.get $entry) (i32.const -65536))
              (i32.and (local.get $va) (i32.const 65535))))"""


LOCALS = "(local $va i32) (local $entry i32) (local $first i32) (local $last i32)"
IMPORTS = """(import "env" "memory" (memory 1024 2048 shared))
 (import "env" "root" (global $root i32))
 (import "env" "scratch" (global $scratch i32))"""


def load(p, mode):
    if mode == "native":
        return f"(i32.load {p})"
    if mode == "helper":
        return f"(call $load {p})"
    return f"""(block (result i32)
      (local.set $first {address(p, 4, 1)})
      (if (result i32) (i32.gt_u (i32.and (local.get $va) (i32.const 65535)) (i32.const 65532))
       (then (call $slow_load {p})) (else (i32.load (local.get $first)))))"""


def store(p, v, mode):
    if mode == "native":
        return f"(i32.store {p} {v})"
    if mode == "helper":
        return f"(call $store {p} {v})"
    return f"""(block
      (local.set $first {address(p, 4, 2)})
      (if (i32.gt_u (i32.and (local.get $va) (i32.const 65535)) (i32.const 65532))
       (then (call $slow_store {p} {v})) (else (i32.store (local.get $first) {v}))))"""


def atomic(p, v, mode, cas=False):
    if mode == "helper":
        return f"(call ${'cas' if cas else 'add'} {p} {v})"
    a = p if mode == "native" else address(p, 4, 3)
    op = f"(i32.atomic.rmw.cmpxchg {a} (i32.const 0) {v})" if cas else f"(i32.atomic.rmw.add {a} {v})"
    # Physical pages preserve low address bits, including atomic alignment.
    return op


def slow_functions():
    src = ""
    for name, rights in [("slow_load", 1), ("slow_store", 2)]:
        writing = name == "slow_store"
        body = f"(local.set $last {address('(i32.add (local.get $p) (i32.const 3))', 1, rights)})"
        # Preflight both pages before a split store changes either page.
        for i in range(4):
            a = address(f"(i32.add (local.get $p) (i32.const {i}))", 1, rights)
            if writing:
                body += f"(i32.store8 {a} (i32.shr_u (local.get $v) (i32.const {8*i})))"
            else:
                body += f"(local.set $v (i32.or (local.get $v) (i32.shl (i32.load8_u {a}) (i32.const {8*i}))))"
        src += f"""(func ${name} (param $p i32) {'(param $v i32)' if writing else '(result i32) (local $v i32)'}
          {LOCALS} {body} {'' if writing else '(local.get $v)'})"""
    # span returns -1 for noncontiguous physical pages; permissions are checked
    # for every page even in that case. It never treats adjacent VAs as proof.
    src += f"""(func $span (param $p i32) (param $n i32) (param $rights i32) (result i32)
      {LOCALS} (local $end i32) (local $cur i32) (local $base i32) (local $ok i32)
      (if (i32.or (i32.gt_u (local.get $p) (i32.const {LIMIT}))
          (i32.gt_u (local.get $n) (i32.sub (i32.const {LIMIT}) (local.get $p)))) (then unreachable))
      (if (i32.eqz (local.get $n)) (then (return (i32.const 0))))
      (local.set $base (call $one (local.get $p) (local.get $rights)))
      (local.set $ok (i32.const 1))
      (local.set $cur (i32.and (i32.add (local.get $p) (i32.const 65536)) (i32.const -65536)))
      (local.set $end (i32.add (local.get $p) (local.get $n)))
      (block $done (loop $pages
        (br_if $done (i32.ge_u (local.get $cur) (local.get $end)))
        (if (i32.ne (call $one (local.get $cur) (local.get $rights))
             (i32.add (local.get $base) (i32.sub (local.get $cur) (local.get $p))))
          (then (local.set $ok (i32.const 0))))
        (local.set $cur (i32.add (local.get $cur) (i32.const 65536))) (br $pages)))
      (if (result i32) (local.get $ok) (then (local.get $base)) (else (i32.const -1))))
    (func $one (param $p i32) (param $rights i32) (result i32) {LOCALS}
      (if (i32.ge_u (local.get $p) (i32.const {LIMIT})) (then unreachable))
      (local.set $entry (i32.load (i32.add (global.get $root)
        (i32.shl (i32.shr_u (local.get $p) (i32.const 16)) (i32.const 2)))))
      (if (i32.ne (i32.and (local.get $entry) (local.get $rights)) (local.get $rights)) (then unreachable))
      (i32.or (i32.and (local.get $entry) (i32.const -65536)) (i32.and (local.get $p) (i32.const 65535))))
    (func $copy (export "copy") (param $d i32) (param $s i32) (param $n i32)
      (local $dp i32) (local $sp i32) (local $i i32)
      (local.set $sp (call $span (local.get $s) (local.get $n) (i32.const 1)))
      (local.set $dp (call $span (local.get $d) (local.get $n) (i32.const 2)))
      (if (i32.and (i32.ne (local.get $sp) (i32.const -1)) (i32.ne (local.get $dp) (i32.const -1)))
       (then (memory.copy (local.get $dp) (local.get $sp) (local.get $n)))
       (else
        (if (i32.gt_u (local.get $n) (i32.const 65536)) (then unreachable))
        (block $read_done (loop $read
          (br_if $read_done (i32.ge_u (local.get $i) (local.get $n)))
          (i32.store8 (i32.add (global.get $scratch) (local.get $i))
            (i32.load8_u (call $one (i32.add (local.get $s) (local.get $i)) (i32.const 1))))
          (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $read)))
        (local.set $i (i32.const 0))
        (block $write_done (loop $write
          (br_if $write_done (i32.ge_u (local.get $i) (local.get $n)))
          (i32.store8 (call $one (i32.add (local.get $d) (local.get $i)) (i32.const 2))
            (i32.load8_u (i32.add (global.get $scratch) (local.get $i))))
          (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $write))))))"""
    return src


def module(mode):
    src = f"(module {IMPORTS}"
    if mode == "helper":
        for name, sig in [("load", "(param i32) (result i32)"), ("store", "(param i32 i32)"),
                          ("add", "(param i32 i32) (result i32)"), ("cas", "(param i32 i32) (result i32)"),
                          ("copy", "(param i32 i32 i32)")]:
            src += f'(import "ops" "{name}" (func ${name} {sig}))'
    elif mode == "native":
        src += '(func $copy (export "copy") (param i32 i32 i32) (memory.copy (local.get 0) (local.get 1) (local.get 2)))'
    else:
        src += slow_functions()
    src += '(export "memory" (memory 0))'
    if mode == "inline":
        src += f'''(func (export "wait") (param $p i32) (result i32) {LOCALS}
          (memory.atomic.wait32 {address('(local.get $p)', 4, 1)} (i32.const 0) (i64.const 5000000000)))
        (func (export "notify") (param $p i32) (result i32) {LOCALS}
          (memory.atomic.notify {address('(local.get $p)', 4, 1)} (i32.const 1)))'''
    for name, expr, params, result in [
        ("load", load('(local.get $p)', mode), "(param $p i32)", "(result i32)"),
        ("store", store('(local.get $p)', '(local.get $v)', mode), "(param $p i32) (param $v i32)", ""),
        ("add", atomic('(local.get $p)', '(local.get $v)', mode), "(param $p i32) (param $v i32)", "(result i32)"),
        ("cas", atomic('(local.get $p)', '(local.get $v)', mode, True), "(param $p i32) (param $v i32)", "(result i32)"),
    ]:
        src += f'(func (export "{name}") {params} {result} {LOCALS} {expr})'
    if mode == "helper":
        src += '(export "copy" (func $copy))'
    for workload in ["read", "chase", "write", "atomic", "copy64k"]:
        p = '(local.get $p)'
        if workload == "chase":
            body = f'(local.set $p {load(p, mode)}) (local.set $sum (i32.xor (local.get $sum) (i32.sub (local.get $p) (local.get $base))))'
        elif workload == "read":
            body = f'(local.set $p (i32.add (local.get $base) (i32.and (i32.shl (local.get $i) (i32.const 2)) (local.get $mask)))) (local.set $sum (i32.add (local.get $sum) {load(p, mode)}))'
        elif workload == "write":
            body = f'(local.set $p (i32.add (local.get $base) (i32.and (i32.shl (local.get $i) (i32.const 2)) (local.get $mask)))) {store(p, "(local.get $i)", mode)}'
        elif workload == "atomic":
            body = f'(local.set $sum (i32.add (local.get $sum) {atomic("(local.get $base)", "(i32.const 1)", mode)}))'
        else:
            body = '(call $copy (local.get $base) (local.get $mask) (i32.const 65536))'
        src += f"""(func (export "{workload}") (param $n i32) (param $base i32) (param $mask i32) (result i32)
         {LOCALS} (local $i i32) (local $sum i32) (local $p i32)
         (local.set $p (local.get $base))
         (block $done (loop $loop
          (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
          {body}
          (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $loop)))
         (local.get $sum))"""
    return src + ")"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("output", type=Path)
    p.add_argument("--opt-level", choices=["none", "O2", "O3", "Oz"], default="none")
    a = p.parse_args()
    a.output.mkdir(parents=True, exist_ok=True)
    for mode in ["native", "inline", "helper"]:
        wat = a.output / f"{mode}.wat"
        wasm = wat.with_suffix(".wasm")
        wat.write_text(module(mode))
        subprocess.run(["wat2wasm", "--enable-threads", str(wat), "-o", str(wasm)], check=True)
        if a.opt_level != "none":
            optimized = wasm.with_suffix(".optimized.wasm")
            subprocess.run(["wasm-opt", str(wasm), f"-{a.opt_level}", "--enable-threads",
                            "--enable-bulk-memory", "-o", str(optimized)], check=True)
            optimized.replace(wasm)
        subprocess.run(["wasm-validate", "--enable-threads", str(wasm)], check=True)
    build = {"optLevel": a.opt_level,
             "assembler": subprocess.check_output(["wat2wasm", "--version"], text=True).strip(),
             "optimizer": None, "optimizerFlags": []}
    if a.opt_level != "none":
        build.update(optimizer=subprocess.check_output(["wasm-opt", "--version"], text=True).strip(),
                     optimizerFlags=[f"-{a.opt_level}", "--enable-threads", "--enable-bulk-memory"])
    (a.output / "build.json").write_text(json.dumps(build, indent=2) + "\n")
    # The helper control imports actual Wasm functions exported by inline.wasm.
    # It is a minimal call control, not a reproduction of Madison's lease costs.


if __name__ == "__main__":
    main()
