#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
guard="$HERE/check-sdk-link-contract.py"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
git -C "$fixture" init -q
mkdir -p "$fixture"/{sdk,crates/kandelo-cc,.cargo,docs,host/test,tools/xtask/src}

# Split the fixture strings so this tracked test does not itself spell out
# the flags it asks the guard to catch.
link_flags=(
    "allow-""undefined"
    "table-""base=3"
    "global-""base=1114112"
    "export-""table"
    "growable-""table"
    "export=__""heap_base"
    "export=__""wasm_thread_init"
    "export=__""wasm_init_tls"
)
bootstrap="lib/""crt1.o"
host_allowance="kandelo-host-""imports.txt"
sdk_allowance="kandelo-link-""imports.txt"
for directory in sdk crates/kandelo-cc .cargo docs; do
    printf 'ld --%s\n' "${link_flags[0]}" >"$fixture/$directory/excluded"
done
printf '  # --%s\n  // --%s\n  * %s\n' \
    "${link_flags[0]}" "${link_flags[1]}" "$host_allowance" \
    >"$fixture/host/test/comments.ts"
printf 'generate "%s"\n' "$host_allowance" >"$fixture/tools/xtask/src/dump_abi.rs"
git -C "$fixture" add .

reintroduced="$fixture/host/test/copied-link.ts"
printf 'cc -Wl,--%s\n' "${link_flags[0]}" >"$reintroduced"
python3 "$guard" "$fixture" # The copy is still untracked.
git -C "$fixture" add host/test/copied-link.ts
for arg in "${link_flags[@]/#/--}" "$bootstrap" \
    "--allow-undefined-file=$host_allowance" "--allow-undefined-file=$sdk_allowance"; do
    printf 'cc -Wl,%s\n' "$arg" >"$reintroduced"
    if python3 "$guard" "$fixture" >"$fixture/guard.log" 2>&1; then
        echo "guard accepted copy in tracked test: $arg" >&2
        exit 1
    fi
    grep -F "host/test/copied-link.ts:1: cc -Wl,$arg" "$fixture/guard.log"
done
printf 'cc -Wl,--%s\n' "${link_flags[1]}" >>"$fixture/tools/xtask/src/dump_abi.rs"
printf 'cc -Wl,--allow-undefined-file=%s\n' "$host_allowance" >>"$fixture/tools/xtask/src/dump_abi.rs"
rm "$reintroduced"
if python3 "$guard" "$fixture" >"$fixture/guard.log" 2>&1; then
    echo "guard accepted a contract flag in an allowance generator" >&2
    exit 1
fi
grep -F 'tools/xtask/src/dump_abi.rs:2:' "$fixture/guard.log"
grep -F 'tools/xtask/src/dump_abi.rs:3:' "$fixture/guard.log"
sed '/^cc /d' "$fixture/tools/xtask/src/dump_abi.rs" >"$fixture/reader"
mv "$fixture/reader" "$fixture/tools/xtask/src/dump_abi.rs"
python3 "$guard" "$fixture"
echo "check-sdk-link-contract: all tests passed"
