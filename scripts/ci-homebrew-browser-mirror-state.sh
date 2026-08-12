#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

usage() {
    cat >&2 <<'EOF'
usage:
  ci-homebrew-browser-mirror-state.sh create <expected-ledger.json> <publication-blockers.json> <canonical-index.toml> <canonical-index-url> <shell.vfs.zst|-> <out.json> [staging-receipt.json]
  ci-homebrew-browser-mirror-state.sh validate <producer|consumer> <state.json> <publication-blockers.json> <shell.vfs.zst|-> [staging-receipt.json]
EOF
    exit 2
}

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

require_regular_file() {
    local label="$1"
    local path="$2"
    if [ ! -f "$path" ] || [ -L "$path" ]; then
        echo "ci-homebrew-browser-mirror-state: $label must be one regular file: $path" >&2
        exit 1
    fi
}

current_source_commit() {
    local commit
    commit="$(git rev-parse HEAD 2>/dev/null)" || {
        echo "ci-homebrew-browser-mirror-state: cannot identify the current source commit" >&2
        exit 1
    }
    if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
        echo "ci-homebrew-browser-mirror-state: current source commit is not a full lowercase SHA" >&2
        exit 1
    fi
    printf '%s\n' "$commit"
}

canonical_flat_shell_report_json() {
    local image="$1"
    local selection_path="${KANDELO_CANONICAL_FLAT_SELECTION:-$REPO_ROOT/homebrew/main-shell-flat-selection.json}"
    local report_root
    local report
    local status
    report_root="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-flat-shell-state.XXXXXX")"
    report="$report_root/report.json"
    npx tsx "$SCRIPT_DIR/inspect-canonical-flat-shell.ts" \
        --image "$image" \
        --selection "$selection_path" \
        --shell-config "$REPO_ROOT/homebrew/main-shell-default.json" \
        --demo-config "$REPO_ROOT/homebrew/main-shell-flat-demo.json" \
        --out "$report" || {
        status=$?
        rm -f -- "$report"
        rmdir "$report_root" 2>/dev/null || true
        return "$status"
    }
    jq -Sce . "$report"
    status=$?
    rm -f -- "$report"
    rmdir "$report_root" 2>/dev/null || true
    return "$status"
}

validate_state() {
    local phase="$1"
    local state="$2"
    local blockers="$3"
    local image="$4"
    local receipt="${5:-}"
    local abi
    local expected_commit
    local actual_commit
    local expected_report_sha
    local actual_report_sha
    local mode
    local expected_sha
    local expected_bytes
    local actual_sha
    local actual_bytes
    local report_chain
    local state_chain
    local selected
    local expected_receipt_sha
    local expected_receipt_bytes
    local actual_receipt_sha
    local actual_receipt_bytes
    local receipt_candidate
    local state_candidate
    local expected_inspection
    local actual_inspection

    case "$phase" in
        producer|consumer) ;;
        *)
            echo "ci-homebrew-browser-mirror-state: validation phase must be producer or consumer" >&2
            exit 2
            ;;
    esac
    require_regular_file state "$state"
    require_regular_file "publication blocker report" "$blockers"
    abi="$(jq -er '
      if (
        type == "object" and
        (.abi_version | type == "number" and . >= 0 and floor == .)
      ) then
        .abi_version
      else
        error("invalid ABI")
      end
    ' "$state")" || {
        echo "ci-homebrew-browser-mirror-state: invalid state ABI: $state" >&2
        exit 1
    }
    bash "$(dirname "$0")/validate-publication-blocker-report.sh" \
        "$blockers" "$abi"

    expected_commit="$(jq -er '.source_commit' "$state")" || {
        echo "ci-homebrew-browser-mirror-state: state lacks its source commit" >&2
        exit 1
    }
    actual_commit="$(current_source_commit)"
    if [ "$actual_commit" != "$expected_commit" ]; then
        echo "ci-homebrew-browser-mirror-state: state belongs to source commit $expected_commit, not $actual_commit" >&2
        exit 1
    fi
    expected_report_sha="$(jq -er '.publication_blockers_sha256' "$state")" || {
        echo "ci-homebrew-browser-mirror-state: state lacks its blocker report digest" >&2
        exit 1
    }
    actual_report_sha="$(sha256_file "$blockers")"
    if [ "$actual_report_sha" != "$expected_report_sha" ]; then
        echo "ci-homebrew-browser-mirror-state: publication blocker report does not match state" >&2
        exit 1
    fi

    mode="$(jq -er '.mode' "$state")" || {
        echo "ci-homebrew-browser-mirror-state: state lacks its mode" >&2
        exit 1
    }
    case "$mode" in
        resolved)
            jq -e '
              type == "object" and
              (keys | sort) == ([
                "abi_version", "arch", "cache_key_sha", "image",
                "inspection", "mirror_required", "mode", "package",
                "publication_blockers_sha256", "revision", "schema",
                "source_commit", "transport"
              ] | sort) and
              .schema == 3 and
              .mode == "resolved" and
              (.abi_version | type == "number" and . >= 0 and floor == .) and
              .package == "shell" and
              .arch == "wasm32" and
              (.source_commit | type == "string" and test("^[0-9a-f]{40}$")) and
              (.publication_blockers_sha256 |
                type == "string" and test("^[0-9a-f]{64}$")) and
              (.revision | type == "number" and . >= 0 and floor == .) and
              (.cache_key_sha |
                type == "string" and test("^[0-9a-f]{64}$")) and
              .transport == "flat-self-contained" and
              .mirror_required == false and
              (.image | type == "object") and
              (.image | keys | sort) == ["bytes", "sha256"] and
              (.image.sha256 |
                type == "string" and test("^[0-9a-f]{64}$")) and
              (.image.bytes | type == "number" and . > 0 and floor == .) and
              (.inspection | type == "object") and
              .inspection.schema == 1 and
              .inspection.kind == "kandelo-canonical-flat-shell" and
              .inspection.transport == {
                kind: "flat-self-contained",
                mirror_required: false
              } and
              .inspection.image.sha256 == .image.sha256 and
              .inspection.image.bytes == .image.bytes and
              .inspection.image.kernel_abi == .abi_version and
              .inspection.selection.arch == .arch and
              .inspection.selection.requested_vfs_filename ==
                "shell.vfs.zst" and
              .inspection.selection.resource_policy ==
                "kandelo-homebrew-vfs-main-shell-v1"
            ' "$state" >/dev/null || {
                echo "ci-homebrew-browser-mirror-state: invalid resolved state contract: $state" >&2
                exit 1
            }
            if jq -e \
                'any(.entries[]; .package == "shell")' \
                "$blockers" >/dev/null; then
                echo "ci-homebrew-browser-mirror-state: resolved shell is also publication-blocked" >&2
                exit 1
            fi
            [ "$image" != "-" ] || {
                echo "ci-homebrew-browser-mirror-state: resolved state requires shell bytes" >&2
                exit 1
            }
            require_regular_file "resolved shell image" "$image"
            expected_sha="$(jq -er '.image.sha256' "$state")"
            expected_bytes="$(jq -er '.image.bytes' "$state")"
            actual_sha="$(sha256_file "$image")"
            actual_bytes="$(wc -c < "$image" | tr -d '[:space:]')"
            if [ "$actual_sha" != "$expected_sha" ] ||
               [ "$actual_bytes" != "$expected_bytes" ]; then
                echo "ci-homebrew-browser-mirror-state: resolved shell bytes do not match state" >&2
                exit 1
            fi
            expected_inspection="$(jq -Sce '.inspection' "$state")"
            actual_inspection="$(canonical_flat_shell_report_json "$image")" || {
                echo "ci-homebrew-browser-mirror-state: resolved shell failed canonical flat inspection" >&2
                exit 1
            }
            if [ "$actual_inspection" != "$expected_inspection" ]; then
                echo "ci-homebrew-browser-mirror-state: resolved shell inspection does not match state" >&2
                exit 1
            fi
            if [ "$phase" = consumer ]; then
                selected="$(
                    bash "$SCRIPT_DIR/resolve-binary.sh" \
                        programs/shell.vfs.zst
                )" || {
                    echo "ci-homebrew-browser-mirror-state: resolved shell is not resolver-selected" >&2
                    exit 1
                }
                require_regular_file "resolver-selected resolved shell" "$selected"
                if [ "$(realpath "$selected")" != "$(realpath "$image")" ]; then
                    echo "ci-homebrew-browser-mirror-state: resolved shell is not the selected local generation" >&2
                    exit 1
                fi
            fi
            ;;
        publication-blocked-candidate)
            jq -e '
              type == "object" and
              (keys | sort) == ([
                "abi_version", "arch", "blocker_chain", "candidate",
                "image", "mirror_required", "mode", "package",
                "publication_blockers_sha256", "schema", "source_commit"
              ] | sort) and
              .schema == 3 and
              .mode == "publication-blocked-candidate" and
              (.abi_version | type == "number" and . >= 0 and floor == .) and
              .package == "shell" and
              .arch == "wasm32" and
              (.source_commit | type == "string" and test("^[0-9a-f]{40}$")) and
              (.publication_blockers_sha256 |
                type == "string" and test("^[0-9a-f]{64}$")) and
              (.blocker_chain | type == "array" and length > 0) and
              all(.blocker_chain[];
                type == "string" and test("^[a-z0-9][a-z0-9+._-]*$")
              ) and
              .mirror_required == true and
              (.image | type == "object") and
              (.image | keys | sort) == ["bytes", "sha256"] and
              (.image.sha256 |
                type == "string" and test("^[0-9a-f]{64}$")) and
              (.image.bytes | type == "number" and . > 0 and floor == .) and
              (.candidate | type == "object") and
              (.candidate | keys | sort) == ([
                "artifact_archive_sha256", "artifact_id",
                "producer_head_sha", "producer_tree_sha", "receipt_bytes",
                "receipt_sha256", "run_id", "validation_base_sha",
                "validation_pull_request_number"
              ] | sort) and
              (.candidate.validation_pull_request_number |
                type == "number" and . >= 1 and floor == .) and
              (.candidate.run_id |
                type == "number" and . >= 1 and floor == .) and
              (.candidate.artifact_id |
                type == "number" and . >= 1 and floor == .) and
              (.candidate.validation_base_sha |
                type == "string" and test("^[0-9a-f]{40}$")) and
              (.candidate.producer_head_sha |
                type == "string" and test("^[0-9a-f]{40}$")) and
              (.candidate.producer_tree_sha |
                type == "string" and test("^[0-9a-f]{40}$")) and
              (.candidate.artifact_archive_sha256 |
                type == "string" and test("^[0-9a-f]{64}$")) and
              (.candidate.receipt_sha256 |
                type == "string" and test("^[0-9a-f]{64}$")) and
              (.candidate.receipt_bytes |
                type == "number" and . > 0 and floor == .)
            ' "$state" >/dev/null || {
                echo "ci-homebrew-browser-mirror-state: invalid candidate state contract: $state" >&2
                exit 1
            }
            report_chain="$(
                jq -ce '
                  [.entries[] | select(.package == "shell")] |
                  if length == 1 then
                    .[0].blocker_chain
                  else
                    error("expected exactly one shell blocker")
                  end
                ' "$blockers"
            )" || {
                echo "ci-homebrew-browser-mirror-state: candidate state lacks one shell blocker" >&2
                exit 1
            }
            state_chain="$(jq -ce '.blocker_chain' "$state")"
            if [ "$state_chain" != "$report_chain" ]; then
                echo "ci-homebrew-browser-mirror-state: candidate blocker chain does not match state" >&2
                exit 1
            fi
            require_regular_file "candidate shell image" "$image"
            require_regular_file "candidate shell receipt" "$receipt"
            expected_sha="$(jq -er '.image.sha256' "$state")"
            expected_bytes="$(jq -er '.image.bytes' "$state")"
            actual_sha="$(sha256_file "$image")"
            actual_bytes="$(wc -c < "$image" | tr -d '[:space:]')"
            if [ "$actual_sha" != "$expected_sha" ] ||
               [ "$actual_bytes" != "$expected_bytes" ]; then
                echo "ci-homebrew-browser-mirror-state: candidate shell bytes do not match state" >&2
                exit 1
            fi
            expected_receipt_sha="$(jq -er '.candidate.receipt_sha256' "$state")"
            expected_receipt_bytes="$(jq -er '.candidate.receipt_bytes' "$state")"
            actual_receipt_sha="$(sha256_file "$receipt")"
            actual_receipt_bytes="$(wc -c < "$receipt" | tr -d '[:space:]')"
            if [ "$actual_receipt_sha" != "$expected_receipt_sha" ] ||
               [ "$actual_receipt_bytes" != "$expected_receipt_bytes" ]; then
                echo "ci-homebrew-browser-mirror-state: staging receipt does not match state" >&2
                exit 1
            fi
            receipt_candidate="$(jq -Sce '
              {
                validation_pull_request_number,
                validation_base_sha,
                producer_head_sha,
                producer_tree_sha,
                run_id,
                artifact_id: .artifact.id,
                artifact_archive_sha256: .artifact.archive_sha256
              }
            ' "$receipt")" || {
                echo "ci-homebrew-browser-mirror-state: invalid staging receipt identity" >&2
                exit 1
            }
            state_candidate="$(jq -Sce '
              .candidate | del(.receipt_sha256, .receipt_bytes)
            ' "$state")"
            if [ "$receipt_candidate" != "$state_candidate" ]; then
                echo "ci-homebrew-browser-mirror-state: staging receipt identity does not match state" >&2
                exit 1
            fi
            if [ "$phase" = consumer ]; then
                selected="$(
                    bash "$(dirname "$0")/resolve-binary.sh" \
                        programs/shell.vfs.zst
                )" || {
                    echo "ci-homebrew-browser-mirror-state: candidate shell is not resolver-selected" >&2
                    exit 1
                }
                require_regular_file \
                    "resolver-selected candidate shell" "$selected"
                if [ "$(realpath "$selected")" != \
                     "$(realpath "$image")" ]; then
                    echo "ci-homebrew-browser-mirror-state: candidate shell is not the selected local generation" >&2
                    exit 1
                fi
            fi
            ;;
        publication-blocked)
            jq -e '
              type == "object" and
              (keys | sort) == ([
                "abi_version", "arch", "blocker_chain",
                "mirror_required", "mode", "package",
                "publication_blockers_sha256", "schema", "source_commit"
              ] | sort) and
              .schema == 2 and
              .mode == "publication-blocked" and
              (.abi_version | type == "number" and . >= 0 and floor == .) and
              .package == "shell" and
              .arch == "wasm32" and
              .mirror_required == false and
              (.source_commit | type == "string" and test("^[0-9a-f]{40}$")) and
              (.publication_blockers_sha256 |
                type == "string" and test("^[0-9a-f]{64}$")) and
              (.blocker_chain | type == "array" and length > 0) and
              all(.blocker_chain[];
                type == "string" and
                test("^[a-z0-9][a-z0-9+._-]*$")
              )
            ' "$state" >/dev/null || {
                echo "ci-homebrew-browser-mirror-state: invalid publication-blocked state contract: $state" >&2
                exit 1
            }
            report_chain="$(
                jq -ce '
                  [.entries[] | select(.package == "shell")] |
                  if length == 1 then
                    .[0].blocker_chain
                  else
                    error("expected exactly one shell blocker")
                  end
                ' "$blockers"
            )" || {
                echo "ci-homebrew-browser-mirror-state: publication-blocked state lacks one shell blocker" >&2
                exit 1
            }
            state_chain="$(jq -ce '.blocker_chain' "$state")"
            if [ "$state_chain" != "$report_chain" ]; then
                echo "ci-homebrew-browser-mirror-state: shell blocker chain does not match state" >&2
                exit 1
            fi
            if [ "$phase" = producer ]; then
                [ "$image" = "-" ] || {
                    echo "ci-homebrew-browser-mirror-state: producer must not pre-authorize publication-blocked shell bytes" >&2
                    exit 1
                }
            else
                [ "$image" != "-" ] || {
                    echo "ci-homebrew-browser-mirror-state: consumer requires materialized shell bytes" >&2
                    exit 1
                }
                require_regular_file "materialized shell image" "$image"
                selected="$(
                    bash "$(dirname "$0")/resolve-binary.sh" \
                        programs/shell.vfs.zst
                )" || {
                    echo "ci-homebrew-browser-mirror-state: materialized shell is not resolver-selected" >&2
                    exit 1
                }
                require_regular_file "resolver-selected shell image" "$selected"
                if [ "$(realpath "$selected")" != "$(realpath "$image")" ]; then
                    echo "ci-homebrew-browser-mirror-state: consumer shell is not the selected local generation" >&2
                    exit 1
                fi
                # WHY: only the explicit source bridge may omit the closed
                # bottle mirror. Prove the selected image owns the exact
                # source marker and carries no Homebrew composition claims;
                # blocker state alone cannot describe the image's contents.
                npx tsx \
                    "$(dirname "$0")/assert-source-rootfs-shell-composition.ts" \
                    "$image"
            fi
            ;;
        *)
            echo "ci-homebrew-browser-mirror-state: unknown state mode: $mode" >&2
            exit 1
            ;;
    esac
}

command="${1:-}"
case "$command" in
    create)
        { [ "$#" -eq 7 ] || [ "$#" -eq 8 ]; } || usage
        expected="$2"
        blockers="$3"
        canonical_index="$4"
        canonical_index_url="$5"
        image="$6"
        out="$7"
        receipt="${8:-}"
        require_regular_file "expected package ledger" "$expected"
        require_regular_file "publication blocker report" "$blockers"
        require_regular_file "canonical package index" "$canonical_index"
        [ ! -L "$out" ] || {
            echo "ci-homebrew-browser-mirror-state: output must not be a symlink: $out" >&2
            exit 1
        }

        abi="$(jq -er '
          if (
            type == "object" and
            (.abi_version | type == "number" and . >= 0 and floor == .) and
            (.entries | type) == "array"
          ) then
            .abi_version
          else
            error("invalid expected ledger")
          end
        ' "$expected")" || {
            echo "ci-homebrew-browser-mirror-state: invalid expected package ledger" >&2
            exit 1
        }
        bash "$(dirname "$0")/validate-publication-blocker-report.sh" \
            "$blockers" "$abi"
        expected_shell_count="$(
            jq '[.entries[] |
              select(.package == "shell" and .arch == "wasm32")] |
              length' "$expected"
        )"
        blocked_shell_count="$(
            jq '[.entries[] | select(.package == "shell")] | length' \
                "$blockers"
        )"
        case "$expected_shell_count:$blocked_shell_count" in
            1:0)
                [ -z "$receipt" ] || {
                    echo "ci-homebrew-browser-mirror-state: resolved shell cannot carry a staging receipt" >&2
                    exit 1
                }
                mode=resolved
                ;;
            0:1)
                if [ -n "$receipt" ]; then
                    mode=publication-blocked-candidate
                else
                    mode=publication-blocked
                fi
                ;;
            *)
                echo "ci-homebrew-browser-mirror-state: shell must be exactly resolved or publication-blocked" >&2
                exit 1
                ;;
        esac

        canonical_abi="$(
            awk '
              $1 == "abi_version" && $2 == "=" {
                value = $3
                count += 1
              }
              END {
                if (count != 1) {
                  exit 1
                }
                print value
              }
            ' "$canonical_index"
        )" || {
            echo "ci-homebrew-browser-mirror-state: canonical index has no unique ABI" >&2
            exit 1
        }
        if [ "$canonical_abi" != "$abi" ]; then
            echo "ci-homebrew-browser-mirror-state: canonical index ABI $canonical_abi does not match $abi" >&2
            exit 1
        fi

        source_commit="$(current_source_commit)"
        blocker_report_sha="$(sha256_file "$blockers")"
        mkdir -p "$(dirname "$out")"
        staged_out="$(mktemp "$(dirname "$out")/.homebrew-browser-mirror-state.XXXXXX")"
        cleanup_staged_out() {
            rm -f -- "$staged_out"
        }
        trap cleanup_staged_out EXIT
        if [ "$mode" = resolved ]; then
            require_regular_file "resolved shell image" "$image"
            shell_entry="$(
                jq -ce '
                  [.entries[] |
                    select(.package == "shell" and .arch == "wasm32")][0] |
                  {
                    kind,
                    version,
                    revision,
                    cache_key_sha
                  }
                ' "$expected"
            )"
            jq -e '
              .kind == "program" and
              (.version | type == "string" and length > 0) and
              (.revision | type == "number" and . >= 0 and floor == .) and
              (.cache_key_sha |
                type == "string" and test("^[0-9a-f]{64}$"))
            ' <<<"$shell_entry" >/dev/null || {
                echo "ci-homebrew-browser-mirror-state: invalid expected shell identity" >&2
                exit 1
            }
            version="$(jq -er '.version' <<<"$shell_entry")"
            revision="$(jq -er '.revision' <<<"$shell_entry")"
            cache_key_sha="$(jq -er '.cache_key_sha' <<<"$shell_entry")"
            host_target="$(rustc -vV 2>/dev/null | awk '/^host/ {print $2}')"
            repo_root="$(git rev-parse --show-toplevel)"
            xtask="${WASM_POSIX_XTASK_BIN:-$repo_root/target/$host_target/release/xtask}"
            if [ -z "$host_target" ] || [ ! -f "$xtask" ] || [ ! -x "$xtask" ]; then
                echo "ci-homebrew-browser-mirror-state: missing executable package index validator: $xtask" >&2
                exit 1
            fi
            canonical_current="$(
                "$xtask" index-candidate current-entry \
                    --canonical-index "$canonical_index" \
                    --canonical-index-url "$canonical_index_url" \
                    --expected-abi "$abi" \
                    --package shell \
                    --version "$version" \
                    --revision "$revision" \
                    --arch wasm32 \
                    --cache-key-sha "$cache_key_sha"
            )" || {
                echo "ci-homebrew-browser-mirror-state: canonical shell entry is invalid" >&2
                exit 1
            }
            case "$canonical_current" in
                true|false) ;;
                *)
                    echo "ci-homebrew-browser-mirror-state: package index validator returned invalid state" >&2
                    exit 1
                    ;;
            esac
            inspection="$(canonical_flat_shell_report_json "$image")" || {
                echo "ci-homebrew-browser-mirror-state: resolved shell failed canonical flat inspection" >&2
                exit 1
            }
            image_sha="$(jq -er '.image.sha256' <<<"$inspection")"
            image_bytes="$(jq -er '.image.bytes' <<<"$inspection")"
            jq -n \
                --argjson abi_version "$abi" \
                --arg source_commit "$source_commit" \
                --arg blocker_report_sha "$blocker_report_sha" \
                --argjson revision "$revision" \
                --arg cache_key_sha "$cache_key_sha" \
                --arg image_sha "$image_sha" \
                --argjson image_bytes "$image_bytes" \
                --argjson inspection "$inspection" '
                  {
                    schema: 3,
                    mode: "resolved",
                    abi_version: $abi_version,
                    package: "shell",
                    arch: "wasm32",
                    source_commit: $source_commit,
                    publication_blockers_sha256: $blocker_report_sha,
                    revision: $revision,
                    cache_key_sha: $cache_key_sha,
                    image: {
                      sha256: $image_sha,
                      bytes: $image_bytes
                    },
                    inspection: $inspection,
                    transport: "flat-self-contained",
                    mirror_required: false
                  }
                ' > "$staged_out"
        elif [ "$mode" = publication-blocked-candidate ]; then
            require_regular_file "candidate shell image" "$image"
            require_regular_file "candidate shell receipt" "$receipt"
            blocker_chain="$(
                jq -ce '
                  [.entries[] | select(.package == "shell")][0].blocker_chain
                ' "$blockers"
            )"
            image_sha="$(sha256_file "$image")"
            image_bytes="$(wc -c < "$image" | tr -d '[:space:]')"
            receipt_sha="$(sha256_file "$receipt")"
            receipt_bytes="$(wc -c < "$receipt" | tr -d '[:space:]')"
            candidate="$(jq -ce '
              {
                validation_pull_request_number,
                validation_base_sha,
                producer_head_sha,
                producer_tree_sha,
                run_id,
                artifact_id: .artifact.id,
                artifact_archive_sha256: .artifact.archive_sha256
              }
            ' "$receipt")" || {
                echo "ci-homebrew-browser-mirror-state: candidate receipt lacks its exact identity" >&2
                exit 1
            }
            jq -n \
                --argjson abi_version "$abi" \
                --arg source_commit "$source_commit" \
                --arg blocker_report_sha "$blocker_report_sha" \
                --argjson blocker_chain "$blocker_chain" \
                --arg image_sha "$image_sha" \
                --argjson image_bytes "$image_bytes" \
                --argjson candidate "$candidate" \
                --arg receipt_sha "$receipt_sha" \
                --argjson receipt_bytes "$receipt_bytes" '
                  {
                    schema: 3,
                    mode: "publication-blocked-candidate",
                    abi_version: $abi_version,
                    package: "shell",
                    arch: "wasm32",
                    source_commit: $source_commit,
                    publication_blockers_sha256: $blocker_report_sha,
                    blocker_chain: $blocker_chain,
                    image: {
                      sha256: $image_sha,
                      bytes: $image_bytes
                    },
                    candidate: ($candidate + {
                      receipt_sha256: $receipt_sha,
                      receipt_bytes: $receipt_bytes
                    }),
                    mirror_required: true
                  }
                ' > "$staged_out"
        else
            [ "$image" = "-" ] || {
                echo "ci-homebrew-browser-mirror-state: publication-blocked shell must not supply producer bytes" >&2
                exit 1
            }
            blocker_chain="$(
                jq -ce '
                  [.entries[] | select(.package == "shell")][0].blocker_chain
                ' "$blockers"
            )"
            # WHY: without a transported staging receipt, the consumer builds
            # the explicitly source-owned bridge. That image has ordinary lazy
            # URLs but deliberately carries no Homebrew package or closed
            # bottle-mirror authority. Requiring recovery here would ask a
            # truthful source image for metadata it must not contain.
            jq -n \
                --argjson abi_version "$abi" \
                --arg source_commit "$source_commit" \
                --arg blocker_report_sha "$blocker_report_sha" \
                --argjson blocker_chain "$blocker_chain" '
                  {
                    schema: 2,
                    mode: "publication-blocked",
                    abi_version: $abi_version,
                    package: "shell",
                    arch: "wasm32",
                    source_commit: $source_commit,
                    publication_blockers_sha256: $blocker_report_sha,
                    blocker_chain: $blocker_chain,
                    mirror_required: false
                  }
                ' > "$staged_out"
        fi
        validate_state producer "$staged_out" "$blockers" "$image" "$receipt"
        mv "$staged_out" "$out"
        trap - EXIT
        ;;
    validate)
        { [ "$#" -eq 5 ] || [ "$#" -eq 6 ]; } || usage
        validate_state "$2" "$3" "$4" "$5" "${6:-}"
        ;;
    *)
        usage
        ;;
esac
