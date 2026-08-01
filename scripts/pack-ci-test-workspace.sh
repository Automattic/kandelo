#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PORTABLE_CACHE_REL=".ci-test-binary-cache"
PUBLICATION_BLOCKERS_REL=".ci-test-publication-blockers.json"
HOMEBREW_BROWSER_MIRROR_STATE_REL=".ci-homebrew-browser-mirror-state.json"
STAGING_SHELL_RECEIPT_REL=".ci-staging-shell-receipt.json"
STAGING_SHELL_REPORT_REL=".ci-staging-shell-report.json"
BROWSER_MEMORY64_FIXTURES_REPO_ROOT="$REPO_ROOT"
BROWSER_MEMORY64_FIXTURES_MANIFEST="$REPO_ROOT/scripts/browser-memory64-example-fixtures.txt"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/browser-memory64-example-fixtures.sh"

publication_blockers=""
homebrew_browser_mirror_state=""
staging_shell_handoff=""
out=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --publication-blockers)
            [ "$#" -ge 2 ] || {
                echo "pack-ci-test-workspace: --publication-blockers requires a path" >&2
                exit 2
            }
            publication_blockers="$2"
            shift 2
            ;;
        --homebrew-browser-mirror-state)
            [ "$#" -ge 2 ] || {
                echo "pack-ci-test-workspace: --homebrew-browser-mirror-state requires a path" >&2
                exit 2
            }
            homebrew_browser_mirror_state="$2"
            shift 2
            ;;
        --staging-shell-handoff)
            [ "$#" -ge 2 ] || {
                echo "pack-ci-test-workspace: --staging-shell-handoff requires a directory" >&2
                exit 2
            }
            staging_shell_handoff="$2"
            shift 2
            ;;
        -*)
            echo "pack-ci-test-workspace: unknown option: $1" >&2
            exit 2
            ;;
        *)
            [ -z "$out" ] || {
                echo "pack-ci-test-workspace: multiple output archives provided" >&2
                exit 2
            }
            out="$1"
            shift
            ;;
    esac
done
if [ -z "$out" ]; then
    echo "usage: $0 [--publication-blockers <report.json>] [--homebrew-browser-mirror-state <state.json>] [--staging-shell-handoff <dir>] <out.tar.zst>" >&2
    exit 2
fi

host_target="$(rustc -vV 2>/dev/null | awk '/^host/ {print $2}')"
if [ -z "$host_target" ]; then
    echo "pack-ci-test-workspace: rustc did not report a host target" >&2
    exit 1
fi
xtask_path="target/$host_target/release/xtask"
if [ ! -x "$xtask_path" ]; then
    echo "pack-ci-test-workspace: missing required package resolver: $xtask_path" >&2
    exit 1
fi

required_items=(
    local-binaries/kernel.wasm
    host/wasm/rootfs.vfs
    examples/gencat.wasm
    examples/pthread_channel_reuse_test.wasm
    examples/wait_lifecycle_test.wasm
    benchmarks/wasm/pipe-throughput.wasm
    benchmarks/wasm/file-throughput.wasm
    benchmarks/wasm/syscall-latency.wasm
    benchmarks/wasm/fork-bench.wasm
    benchmarks/wasm/clone-bench.wasm
    benchmarks/wasm/spawn-bench.wasm
    benchmarks/wasm/hello.wasm
)
memory64_example_outputs="$(browser_memory64_fixture_outputs)"
while IFS= read -r output; do
    required_items+=("$output")
done <<< "$memory64_example_outputs"

for required in "${required_items[@]}"; do
    if [ ! -f "$required" ]; then
        echo "pack-ci-test-workspace: missing required artifact: $required" >&2
        exit 1
    fi
done

items=("$xtask_path")
for item in host/wasm; do
    [ -e "$item" ] && items+=("$item")
done
# `prepare-browser` uses xtask to map package outputs to their resolver paths.
# The producer already built this exact binary while fetching packages, so keep
# it with the prepared workspace instead of rebuilding it in the consumer.
# The browser consumer reruns `prepare-browser` against this archive. Its
# `has_programs` guard checks both example and benchmark outputs, so retain the
# complete build-programs fixture set to prevent an unintended source rebuild.
for wasm in examples/*.wasm benchmarks/wasm/*.wasm; do
    [ -f "$wasm" ] && items+=("$wasm")
done

stage="$(realpath "$(mktemp -d)")"
cleanup() {
    local status="$?"
    trap - EXIT
    rm -rf "$stage"
    exit "$status"
}
trap cleanup EXIT

relative_root_link() {
    local mirror_relative="$1"
    local target_relative="$2"
    local parent=""
    case "$mirror_relative" in
        */*) parent="${mirror_relative%/*}" ;;
    esac
    local prefix=""
    while [ -n "$parent" ]; do
        prefix="../$prefix"
        case "$parent" in
            */*) parent="${parent%/*}" ;;
            *) parent="" ;;
        esac
    done
    printf '%s%s\n' "$prefix" "$target_relative"
}

local_member_contract() {
    local package="$1"
    local member="$2"
    local metadata=""
    local source_field=""
    if metadata="$("$xtask_path" build-deps output-metadata \
        "$package" "$member" 2>/dev/null)"; then
        source_field="source_artifact"
    elif metadata="$("$xtask_path" build-deps runtime-file-metadata \
        "$package" "$member" 2>/dev/null)"; then
        source_field="artifact"
    else
        return 1
    fi
    node -e '
        const value = JSON.parse(process.argv[1]);
        const sourceField = process.argv[2];
        for (const key of [sourceField, "mirror_path"]) {
          if (typeof value[key] !== "string" || value[key].length === 0 ||
              value[key].includes("\t") || value[key].includes("\n")) {
            throw new Error(`invalid local-generation metadata field ${key}`);
          }
        }
        process.stdout.write(`${value[sourceField]}\t${value.mirror_path}`);
      ' "$metadata" "$source_field"
}

if [ -e binaries ] || [ -L binaries ]; then
    source_cache_root="$("$xtask_path" build-deps cache-root)"
    case "$source_cache_root" in
        /*) ;;
        *)
            echo "pack-ci-test-workspace: package resolver returned a non-absolute cache root: $source_cache_root" >&2
            exit 1
            ;;
    esac
    # WHY: prepared conformance workspaces and isolated Homebrew Formula tests
    # must transport package generations identically. A shared staging helper
    # prevents either path from flattening package mirrors into ordinary files
    # and silently discarding the resolver's single-generation identity.
    bash scripts/stage-portable-resolver-binaries.sh \
        "$REPO_ROOT/binaries" "$source_cache_root" "$stage"
fi

if [ -e local-binaries ] || [ -L local-binaries ]; then
    if [ ! -d local-binaries ] || [ -L local-binaries ]; then
        echo "pack-ci-test-workspace: local-binaries must be a real directory" >&2
        exit 1
    fi
    source_local_root="$(realpath local-binaries)"
    cp -a local-binaries "$stage/local-binaries"
    staged_local_root="$(realpath "$stage/local-binaries")"
    local_generations_rel=".kandelo-local-generations"
    for package_owned_root in kernel.wasm userspace.wasm; do
        root_mirror="$stage/local-binaries/$package_owned_root"
        if { [ -e "$root_mirror" ] || [ -L "$root_mirror" ]; } &&
           [ ! -L "$root_mirror" ]; then
            # WHY: these compatibility paths are package-owned mirrors, not
            # anonymous scalar byte slots. Accepting a regular file would let
            # a stale or concurrently replaced kernel/userspace artifact enter
            # the portable workspace without a cache identity or publication
            # claim.
            echo "pack-ci-test-workspace: package-owned root mirror must remain a local-generation symlink: $root_mirror" >&2
            exit 1
        fi
    done
    while IFS= read -r -d '' mirror; do
        mirror_relative="${mirror#"$stage/local-binaries/"}"
        if [ "$mirror_relative" = "$mirror" ]; then
            echo "pack-ci-test-workspace: staged local resolver link escaped local-binaries/: $mirror" >&2
            exit 1
        fi
        link_target="$(readlink "$mirror")"
        case "$link_target" in
            /*)
                case "$link_target" in
                    *"/$local_generations_rel/"*)
                        namespace_root="${link_target%%"/$local_generations_rel/"*}"
                        canonical_namespace_root="$(
                            realpath "$namespace_root" 2>/dev/null || true
                        )"
                        # WHY: `/tmp` and its canonical spelling may differ on
                        # macOS, but a matching generation-shaped suffix alone
                        # does not prove that the live mirror selected this
                        # workspace's package namespace. Authenticate only the
                        # namespace root, then validate members exclusively in
                        # the frozen copy so a concurrent source mutation
                        # cannot change the bytes entering the archive.
                        case "$canonical_namespace_root" in
                            "$source_local_root" | "$staged_local_root") ;;
                            *)
                                echo "pack-ci-test-workspace: staged local resolver link has an untrusted generation namespace root: $mirror -> $link_target" >&2
                                exit 1
                                ;;
                        esac
                        target_relative="$local_generations_rel/${link_target#*"/$local_generations_rel/"}"
                        ;;
                    "$source_local_root"/*)
                        target_relative="${link_target#"$source_local_root"/}"
                        ;;
                    "$staged_local_root"/*)
                        target_relative="${link_target#"$staged_local_root"/}"
                        ;;
                    *)
                        echo "pack-ci-test-workspace: staged local resolver link retains an external absolute target: $mirror -> $link_target" >&2
                        exit 1
                        ;;
                esac
                ;;
            *)
                target="$(realpath "$(dirname "$mirror")/$link_target" 2>/dev/null || true)"
                case "$target" in
                    "$staged_local_root"/*)
                        target_relative="${target#"$staged_local_root"/}"
                        ;;
                    *)
                        echo "pack-ci-test-workspace: staged local resolver link is dangling or escapes its frozen snapshot: $mirror -> $link_target" >&2
                        exit 1
                        ;;
                esac
                ;;
        esac
        staged_target="$staged_local_root/$target_relative"
        target="$(realpath "$staged_target" 2>/dev/null || true)"
        if [ ! -f "$target" ] || [ -L "$staged_target" ]; then
            echo "pack-ci-test-workspace: staged local resolver link does not select a regular snapshot member: $mirror -> $target_relative" >&2
            exit 1
        fi
        case "$target" in
            "$staged_local_root"/*) ;;
            *)
                echo "pack-ci-test-workspace: staged local resolver member escapes its frozen snapshot: $mirror -> $target" >&2
                exit 1
                ;;
        esac
        target_relative="${target#"$staged_local_root"/}"

        case "$target_relative" in
            "$local_generations_rel"/*)
                # WHY: package identity belongs to the generation, not to the
                # mirror's directory depth. Root boot artifacts such as
                # kernel.wasm and ordinary programs/<arch> scalars must both
                # remain generation-backed after this workspace is relocated.
                # Validate only the private snapshot: consulting the mutable
                # source after cp could classify bytes other than those that
                # will actually enter the archive.
                identity="${target_relative#"$local_generations_rel"/}"
                arch="${identity%%/*}"
                [ "$identity" != "$arch" ] || {
                    echo "pack-ci-test-workspace: local generation lacks package identity: $target_relative" >&2
                    exit 1
                }
                identity="${identity#*/}"
                package="${identity%%/*}"
                [ "$identity" != "$package" ] || {
                    echo "pack-ci-test-workspace: local generation lacks cache identity: $target_relative" >&2
                    exit 1
                }
                identity="${identity#*/}"
                cache_key="${identity%%/*}"
                [ "$identity" != "$cache_key" ] || {
                    echo "pack-ci-test-workspace: local generation lacks install session: $target_relative" >&2
                    exit 1
                }
                identity="${identity#*/}"
                session="${identity%%/*}"
                member="${identity#*/}"
                if [ "$member" = "$identity" ] || [ -z "$member" ]; then
                    echo "pack-ci-test-workspace: local generation lacks a declared member: $target_relative" >&2
                    exit 1
                fi
                case "$arch" in
                    wasm32|wasm64) ;;
                    *)
                        echo "pack-ci-test-workspace: unsupported local-generation architecture: $arch" >&2
                        exit 1
                        ;;
                esac
                if ! [[ "$cache_key" =~ ^[0-9a-f]{64}$ ]]; then
                    echo "pack-ci-test-workspace: invalid local-generation cache identity: $cache_key" >&2
                    exit 1
                fi
                if [ "${#session}" -gt 128 ] ||
                   ! [[ "$session" =~ ^[[:alnum:]][[:alnum:]_.-]*$ ]]; then
                    echo "pack-ci-test-workspace: invalid local-generation install session: $session" >&2
                    exit 1
                fi
                identity_root="$staged_local_root/$local_generations_rel/$arch/$package/$cache_key"
                generation_root="$identity_root/$session"
                for generation_dir in \
                    "$staged_local_root/$local_generations_rel" \
                    "$staged_local_root/$local_generations_rel/$arch" \
                    "$staged_local_root/$local_generations_rel/$arch/$package" \
                    "$identity_root" \
                    "$generation_root"; do
                    if [ ! -d "$generation_dir" ] || [ -L "$generation_dir" ]; then
                        echo "pack-ci-test-workspace: local-generation ownership path is not a real directory: $generation_dir" >&2
                        exit 1
                    fi
                done
                claim="$identity_root/.$session.publication-claimed"
                if [ ! -f "$claim" ] || [ -L "$claim" ]; then
                    echo "pack-ci-test-workspace: local generation lacks its regular publication claim: $claim" >&2
                    exit 1
                fi
                expected_cache_key="$("$xtask_path" build-deps --arch "$arch" sha "$package")"
                if [ "$cache_key" != "$expected_cache_key" ]; then
                    echo "pack-ci-test-workspace: local generation for $package has stale cache identity $cache_key; current identity is $expected_cache_key" >&2
                    exit 1
                fi
                contract="$(local_member_contract "$package" "$member" || true)"
                if [ -z "$contract" ]; then
                    echo "pack-ci-test-workspace: local generation member is not declared by $package: $member" >&2
                    exit 1
                fi
                IFS=$'\t' read -r declared_member declared_mirror <<<"$contract"
                if [ "$declared_member" != "$member" ]; then
                    echo "pack-ci-test-workspace: local generation member drift for $package: $member != $declared_member" >&2
                    exit 1
                fi
                expected_program_mirror="programs/$arch/$declared_mirror"
                if [ "$mirror_relative" != "$expected_program_mirror" ]; then
                    case "$package:$mirror_relative:$declared_mirror" in
                        "kernel:kernel.wasm:kernel.wasm" | \
                        "userspace:userspace.wasm:userspace.wasm")
                            ;;
                        *)
                            echo "pack-ci-test-workspace: local generation member $package:$member does not own mirror $mirror_relative" >&2
                            exit 1
                            ;;
                    esac
                fi
                rm "$mirror"
                ln -s \
                    "$(relative_root_link "$mirror_relative" "$target_relative")" \
                    "$mirror"
                ;;
            *)
                case "$mirror_relative" in
                    kernel.wasm | userspace.wasm)
                        echo "pack-ci-test-workspace: package-owned root mirror must select a declared local generation: $mirror -> $target_relative" >&2
                        exit 1
                        ;;
                    programs/*)
                        echo "pack-ci-test-workspace: local program resolver link targets a noncanonical generation: $mirror -> $target_relative" >&2
                        exit 1
                        ;;
                    *)
                        # Non-package scalar aliases may point at another
                        # file in the frozen snapshot. Stage verified bytes
                        # beside the live link before replacing it so cp cannot
                        # follow and overwrite the link target.
                        materialized="$(mktemp "${mirror}.materialized.XXXXXX")"
                        cp -p "$target" "$materialized"
                        rm "$mirror"
                        mv "$materialized" "$mirror"
                        ;;
                esac
                ;;
        esac
    done < <(find "$stage/local-binaries" -type l -print0)

    unsafe_local_link="$(
        find "$stage/local-binaries" -type l -print0 |
        while IFS= read -r -d '' link; do
            # WHY: macOS Bash 3.2 misparses case patterns inside this outer
            # command substitution. Prefix removal preserves the same
            # absolute/escape checks in prepared workspaces on every host.
            link_target="$(readlink "$link")"
            if [ "${link_target#/}" != "$link_target" ]; then
                printf '%s\n' "$link"
                break
            fi
            resolved="$(realpath "$link" 2>/dev/null || true)"
            if [ "${resolved#"$stage/local-binaries"/}" = "$resolved" ]; then
                printf '%s\n' "$link"
                break
            fi
        done
    )"
    if [ -n "$unsafe_local_link" ]; then
        echo "pack-ci-test-workspace: portable local resolver closure contains an absolute, dangling, or escaping link: $unsafe_local_link" >&2
        exit 1
    fi
fi

if [ -n "$publication_blockers" ]; then
    if [ ! -f "$publication_blockers" ] || [ -L "$publication_blockers" ]; then
        echo "pack-ci-test-workspace: publication blocker report must be a regular non-symlink file: $publication_blockers" >&2
        exit 1
    fi
    cp -p -- "$publication_blockers" "$stage/$PUBLICATION_BLOCKERS_REL"
fi
if [ -n "$homebrew_browser_mirror_state" ]; then
    if [ ! -f "$homebrew_browser_mirror_state" ] ||
       [ -L "$homebrew_browser_mirror_state" ]; then
        echo "pack-ci-test-workspace: Homebrew browser mirror state must be a regular non-symlink file: $homebrew_browser_mirror_state" >&2
        exit 1
    fi
    if [ -z "$publication_blockers" ]; then
        echo "pack-ci-test-workspace: Homebrew browser mirror state requires its publication blocker report" >&2
        exit 1
    fi
    cp -p -- \
        "$homebrew_browser_mirror_state" \
        "$stage/$HOMEBREW_BROWSER_MIRROR_STATE_REL"
    staged_publication_blockers="$stage/$PUBLICATION_BLOCKERS_REL"
    staged_homebrew_browser_mirror_state="$stage/$HOMEBREW_BROWSER_MIRROR_STATE_REL"
    # WHY: validate the report, state, and resolved shell snapshots that will
    # enter the archive. Validating the caller's live paths would leave a
    # mutation window in which different bytes could be transported unverified.
    mirror_state_mode="$(jq -er '.mode' "$staged_homebrew_browser_mirror_state")" || {
        echo "pack-ci-test-workspace: Homebrew browser mirror state lacks its mode" >&2
        exit 1
    }
    state_receipt=""
    case "$mirror_state_mode" in
        resolved)
            staged_shell="$stage/binaries/programs/wasm32/shell.vfs.zst"
            shell_image="$(realpath "$staged_shell" 2>/dev/null || true)"
            case "$shell_image" in
                "$stage"/*) ;;
                *)
                    echo "pack-ci-test-workspace: staged resolved shell image escapes its snapshot" >&2
                    exit 1
                    ;;
            esac
            if [ ! -f "$shell_image" ] || [ -L "$shell_image" ]; then
                echo "pack-ci-test-workspace: staged resolved shell image is missing" >&2
                exit 1
            fi
            ;;
        publication-blocked-candidate)
            [ -n "$staging_shell_handoff" ] || {
                echo "pack-ci-test-workspace: candidate mirror state lacks its staging handoff" >&2
                exit 1
            }
            staged_shell="$stage/local-binaries/programs/wasm32/shell.vfs.zst"
            shell_image="$(realpath "$staged_shell" 2>/dev/null || true)"
            case "$shell_image" in
                "$stage/local-binaries"/*) ;;
                *)
                    echo "pack-ci-test-workspace: staged candidate shell image escapes its snapshot" >&2
                    exit 1
                    ;;
            esac
            if [ ! -f "$shell_image" ] || [ -L "$shell_image" ]; then
                echo "pack-ci-test-workspace: staged candidate shell image is missing" >&2
                exit 1
            fi
            state_receipt="$staging_shell_handoff/receipt.json"
            ;;
        publication-blocked)
            # WHY: source-materialized shell bytes do not exist on the producer
            # runner. Transport only checkout+blocker authority; the browser
            # consumer must materialize and resolver-select the image before
            # testing it through ordinary lazy transport. This source-owned
            # bridge intentionally has no closed Homebrew mirror to recover.
            shell_image="-"
            ;;
        *)
            echo "pack-ci-test-workspace: unknown Homebrew browser mirror state mode: $mirror_state_mode" >&2
            exit 1
            ;;
    esac
    state_args=(
        validate producer
        "$staged_homebrew_browser_mirror_state"
        "$staged_publication_blockers"
        "$shell_image"
    )
    if [ -n "$state_receipt" ]; then
        state_args+=("$state_receipt")
    fi
    bash scripts/ci-homebrew-browser-mirror-state.sh "${state_args[@]}"
fi

if [ -n "$staging_shell_handoff" ]; then
    receipt="$staging_shell_handoff/receipt.json"
    report="$staging_shell_handoff/main-shell-report.json"
    image="$staging_shell_handoff/main-shell.vfs.zst"
    if [ -z "$publication_blockers" ] ||
       ! jq -e 'any(.entries[]; .package == "shell")' \
           "$publication_blockers" >/dev/null; then
        echo "pack-ci-test-workspace: staging shell handoff requires one publication-blocked shell" >&2
        exit 1
    fi
    if [ -z "$homebrew_browser_mirror_state" ] ||
       [ "$(jq -er '.mode' "$homebrew_browser_mirror_state")" != \
         publication-blocked-candidate ]; then
        echo "pack-ci-test-workspace: staging handoff requires candidate mirror state" >&2
        exit 1
    fi
    parents="$(git show --no-patch --format=%P HEAD)"
    expected_base="$(printf '%s\n' "$parents" | awk '{print $1}')"
    expected_head="$(printf '%s\n' "$parents" | awk '{print $2}')"
    expected_tree="$(git rev-parse 'HEAD^{tree}')"
    unexpected_parent="$(printf '%s\n' "$parents" | awk '{print $3}')"
    if ! [[ "$expected_base" =~ ^[0-9a-f]{40}$ ]] ||
       ! [[ "$expected_head" =~ ^[0-9a-f]{40}$ ]] ||
       [ -n "$unexpected_parent" ]; then
        echo "pack-ci-test-workspace: staging shell handoff requires the exact two-parent synthetic merge" >&2
        exit 1
    fi
    expected_run_id="$(jq -er '.run_id' "$receipt")" || {
        echo "pack-ci-test-workspace: staging shell receipt lacks its run ID" >&2
        exit 1
    }
    bash scripts/verify-ci-staging-shell-handoff.sh \
        "$receipt" "$image" "$report" \
        "$expected_base" "$expected_head" "$expected_tree" \
        "$expected_run_id"
    staged_shell_link="$stage/local-binaries/programs/wasm32/shell.vfs.zst"
    staged_shell="$(realpath "$staged_shell_link" 2>/dev/null || true)"
    case "$staged_shell" in
        "$stage/local-binaries"/*) ;;
        *)
            echo "pack-ci-test-workspace: staged handoff shell escapes local-binaries" >&2
            exit 1
            ;;
    esac
    if [ ! -f "$staged_shell" ] || [ -L "$staged_shell" ] ||
       ! cmp -s "$image" "$staged_shell"; then
        echo "pack-ci-test-workspace: local shell generation differs from the staging handoff" >&2
        exit 1
    fi
    cp -p -- "$receipt" "$stage/$STAGING_SHELL_RECEIPT_REL"
    cp -p -- "$report" "$stage/$STAGING_SHELL_REPORT_REL"
fi

mkdir -p "$(dirname "$out")"
tar_args=(--zstd -cf "$out")
if [ -d "$stage/binaries" ]; then
    tar_args+=(-C "$stage" binaries)
fi
if [ -d "$stage/$PORTABLE_CACHE_REL" ]; then
    tar_args+=(-C "$stage" "$PORTABLE_CACHE_REL")
fi
if [ -d "$stage/local-binaries" ]; then
    tar_args+=(-C "$stage" local-binaries)
fi
if [ -f "$stage/$PUBLICATION_BLOCKERS_REL" ]; then
    tar_args+=(-C "$stage" "$PUBLICATION_BLOCKERS_REL")
fi
if [ -f "$stage/$HOMEBREW_BROWSER_MIRROR_STATE_REL" ]; then
    tar_args+=(-C "$stage" "$HOMEBREW_BROWSER_MIRROR_STATE_REL")
fi
if [ -f "$stage/$STAGING_SHELL_RECEIPT_REL" ]; then
    tar_args+=(
        -C "$stage"
        "$STAGING_SHELL_RECEIPT_REL"
        "$STAGING_SHELL_REPORT_REL"
    )
fi
tar_args+=(-C "$REPO_ROOT" "${items[@]}")
tar "${tar_args[@]}"

trap - EXIT
rm -rf "$stage"
