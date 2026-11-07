#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 4 ]]; then
  echo 'usage: run-controls.sh NODE26 NODE26_SOURCE COMPONENT_NODE CANDIDATE_ROOT' >&2
  exit 2
fi
node26=$1
source26=$2
component=$3
candidate=$4
here=$(cd "$(dirname "$0")" && pwd)
for mode in orderly abrupt reentry; do
  "$node26" "$here/control.cjs" "$mode" "$component" "$source26"
done
"$node26" "$here/bridge-control.cjs" "$candidate"
