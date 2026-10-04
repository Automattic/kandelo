#!/usr/bin/env bash
# git-workload.sh <git.wasm> <label>: run a fork-heavy git session (one dash
# process, so repository state persists) with <git.wasm> as every git.
# Output: .context/real/<label>.out (stdout+stderr) and the exit status.
set -u
ROOT=$(git rev-parse --show-toplevel); GIT=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); L=$2
B=$ROOT/local-binaries/source-only-v1/programs/wasm32
S='set -e
cd /tmp
git init -q r && cd r
git config user.email a@b.c && git config user.name A && git config core.logAllRefUpdates false
echo one > f && git add f && git commit -q -m one
git -c core.pager=cat log --oneline | cat
git checkout -q -b topic && echo two >> f && git commit -q -am two
git checkout -q master 2>/dev/null || git checkout -q main
git merge -q --no-edit topic
git -c core.pager=cat log --oneline | wc -l
git gc -q
git archive --format=tar HEAD | wc -c
git -c core.pager=cat show --stat HEAD | head -3
git -c alias.lst="!git log --oneline" lst | wc -l
echo WORKLOAD-OK'
ORACLE_EXEC="/usr/bin/git=$GIT,/bin/git=$GIT,/usr/libexec/git-core/git=$GIT" TIMEOUT=600000 \
  npx tsx "$ROOT/tools/fork-sink-research/fpr/oracle/run-workload.ts" "$B/dash.wasm" dash -c "$S" > "$ROOT/.context/real/$L.out" 2>&1
echo "$L exit=$? $(grep -c WORKLOAD-OK "$ROOT/.context/real/$L.out") ok-marker"
