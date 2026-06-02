#!/usr/bin/env bash

scope_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ci-scope-paths.sh
. "$scope_dir/ci-scope-paths.sh"

# Compatibility wrapper for existing callers: package staging means
# package archive/cache-key changes, not binary fetch or publish-flow
# changes.
package_staging_changed_files() {
  package_archive_changed_files
}
