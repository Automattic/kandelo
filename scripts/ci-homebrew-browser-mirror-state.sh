#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat >&2 <<'EOF'
usage:
  ci-homebrew-browser-mirror-state.sh create <expected-ledger.json> <publication-blockers.json> <canonical-index.toml> <canonical-index-url> <shell.vfs.zst|-> <out.json>
  ci-homebrew-browser-mirror-state.sh validate <producer|consumer> <state.json> <publication-blockers.json> <shell.vfs.zst|->
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

validate_state() {
    local phase="$1"
    local state="$2"
    local blockers="$3"
    local image="$4"
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
                "mirror_required", "mode", "package",
                "publication_blockers_sha256", "revision", "schema",
                "source_commit"
              ] | sort) and
              .schema == 2 and
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
              .mirror_required == true and
              (.image | type == "object") and
              (.image | keys | sort) == ["bytes", "sha256"] and
              (.image.sha256 |
                type == "string" and test("^[0-9a-f]{64}$")) and
              (.image.bytes | type == "number" and . > 0 and floor == .)
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
              .mirror_required == true and
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
        [ "$#" -eq 7 ] || usage
        expected="$2"
        blockers="$3"
        canonical_index="$4"
        canonical_index_url="$5"
        image="$6"
        out="$7"
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
            1:0) mode=resolved ;;
            0:1) mode=publication-blocked ;;
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
            # WHY: the canonical package index and the immutable bottle-mirror
            # release are independent publication authorities. A later PR can
            # correctly resolve an unchanged canonical shell while that
            # shell's content-addressed mirror is still unpublished. Generic
            # browser staging is therefore always a closed-acceptance lane:
            # recover the image-authenticated bottle bytes locally and leave
            # anonymous public transport to the dedicated publication proof.
            mirror_required=true
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
            image_sha="$(sha256_file "$image")"
            image_bytes="$(wc -c < "$image" | tr -d '[:space:]')"
            jq -n \
                --argjson abi_version "$abi" \
                --arg source_commit "$source_commit" \
                --arg blocker_report_sha "$blocker_report_sha" \
                --argjson revision "$revision" \
                --arg cache_key_sha "$cache_key_sha" \
                --arg image_sha "$image_sha" \
                --argjson image_bytes "$image_bytes" \
                --argjson mirror_required "$mirror_required" '
                  {
                    schema: 2,
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
                    mirror_required: $mirror_required
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
                    mirror_required: true
                  }
                ' > "$staged_out"
        fi
        validate_state producer "$staged_out" "$blockers" "$image"
        mv "$staged_out" "$out"
        trap - EXIT
        ;;
    validate)
        [ "$#" -eq 5 ] || usage
        validate_state "$2" "$3" "$4" "$5"
        ;;
    *)
        usage
        ;;
esac
