#!/usr/bin/env bash
# Exact environment boundary for trusted native Homebrew API operations.

homebrew_native_bounded_run() {
  if [ "$#" -lt 5 ]; then
    echo "homebrew_native_bounded_run: expected BREW CACHE STATE MODE COMMAND..." >&2
    return 2
  fi
  local brew_bin="$1" cache_root="$2" state_root="$3" mode="$4"
  local current_user directory
  local -a clean_env
  shift 4

  [ -x "$brew_bin" ] || {
    echo "homebrew_native_bounded_run: Brew is not executable" >&2
    return 2
  }
  for directory in \
    "$cache_root" "$state_root" "$state_root/home" \
    "$state_root/tmp" "$state_root/config"; do
    [ -d "$directory" ] && [ ! -L "$directory" ] || {
      echo "homebrew_native_bounded_run: invalid state directory" >&2
      return 2
    }
  done
  case "$mode" in
    api-client|api-oracle) ;;
    *)
      echo "homebrew_native_bounded_run: mode must be api-client or api-oracle" >&2
      return 2
      ;;
  esac

  current_user="$(/usr/bin/id -un)"
  clean_env=(
    /usr/bin/env -i
    "HOME=$state_root/home"
    "USER=$current_user"
    "LOGNAME=$current_user"
    "TMPDIR=$state_root/tmp"
    "XDG_CONFIG_HOME=$state_root/config"
    "PATH=/usr/bin:/bin"
    "LANG=C.UTF-8"
    "LC_ALL=C.UTF-8"
    "TZ=UTC"
    "CI=1"
    "GITHUB_ACTIONS=true"
    "RUNNER_OS=Linux"
    "HOMEBREW_CACHE=$cache_root"
    "HOMEBREW_TEMP=$state_root/tmp"
    "HOMEBREW_API_UPDATED=1"
    "HOMEBREW_GIT_PATH=/usr/bin/git"
    "HOMEBREW_NO_AUTO_UPDATE=1"
    "HOMEBREW_NO_ANALYTICS=1"
    "HOMEBREW_NO_ENV_HINTS=1"
    "HOMEBREW_NO_INSTALL_CLEANUP=1"
  )
  if [ -f /etc/ssl/certs/ca-certificates.crt ] &&
     [ ! -L /etc/ssl/certs/ca-certificates.crt ]; then
    # The Linux publisher's host trust store is an explicit runner boundary.
    # Signed API records and bottle checksums remain the content authorities.
    clean_env+=(
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
      "NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
    )
  fi
  if [ "$mode" = api-oracle ]; then
    # The oracle reads the already verified cache directly. Dependency
    # resolution and installation deliberately omit this switch so exact cf5
    # continues to use the signed API rather than a Git checkout.
    clean_env+=("HOMEBREW_NO_INSTALL_FROM_API=1")
  fi

  # WHY: Homebrew behavior can be redirected by dozens of inherited
  # HOMEBREW_*, Git, Ruby, and Bundler variables. Admit only fixed Linux
  # runner tools and realm-owned state so the sealed signed cache is the sole
  # Formula authority.
  (
    cd "$state_root/tmp"
    exec "${clean_env[@]}" "$brew_bin" "$@"
  )
}
