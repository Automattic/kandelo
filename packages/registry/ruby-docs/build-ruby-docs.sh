#!/usr/bin/env bash
# Ship the `ruby` package's upstream manual pages as ruby-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (ruby, irb, gem, bundle, bundler) are shipped.
# `bundle help <command>` reads the bundle-*.1 pages. erb, ri, rake and
# goruby are not installed; gem has no manual page upstream.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages ruby-docs "$SRC" \
    man/ruby.1 \
    .bundle/gems/irb-1.16.0/man/irb.1 \
    lib/bundler/man/bundle.1 \
    bundler.1=bundle.1 \
    lib/bundler/man/bundle-add.1 \
    lib/bundler/man/bundle-binstubs.1 \
    lib/bundler/man/bundle-cache.1 \
    lib/bundler/man/bundle-check.1 \
    lib/bundler/man/bundle-clean.1 \
    lib/bundler/man/bundle-config.1 \
    lib/bundler/man/bundle-console.1 \
    lib/bundler/man/bundle-doctor.1 \
    lib/bundler/man/bundle-env.1 \
    lib/bundler/man/bundle-exec.1 \
    lib/bundler/man/bundle-fund.1 \
    lib/bundler/man/bundle-gem.1 \
    lib/bundler/man/bundle-help.1 \
    lib/bundler/man/bundle-info.1 \
    lib/bundler/man/bundle-init.1 \
    lib/bundler/man/bundle-install.1 \
    lib/bundler/man/bundle-issue.1 \
    lib/bundler/man/bundle-licenses.1 \
    lib/bundler/man/bundle-list.1 \
    lib/bundler/man/bundle-lock.1 \
    lib/bundler/man/bundle-open.1 \
    lib/bundler/man/bundle-outdated.1 \
    lib/bundler/man/bundle-platform.1 \
    lib/bundler/man/bundle-plugin.1 \
    lib/bundler/man/bundle-pristine.1 \
    lib/bundler/man/bundle-remove.1 \
    lib/bundler/man/bundle-show.1 \
    lib/bundler/man/bundle-update.1 \
    lib/bundler/man/bundle-version.1 \
    lib/bundler/man/gemfile.5
