#!/bin/bash
# A stand-in for a long Kandelo build, for evals/build-waiting/run.py.
# FAKE_BUILD_SECONDS sets the duration; FAKE_BUILD_QUIET=1 prints nothing
# until the end (a build that looks stuck but is not).
seconds="${FAKE_BUILD_SECONDS:-150}"
for ((i = 1; i <= seconds; i++)); do
    if [ "${FAKE_BUILD_QUIET:-0}" != 1 ] && [ $((i % 10)) -eq 0 ]; then
        echo "[$i/${seconds}s] compiling target $((i / 10)) of $((seconds / 10))"
    fi
    sleep 1
done
if [ "${FAKE_BUILD_QUIET:-0}" = 1 ]; then
    echo "OK: 12 targets built"
    exit 0
fi
echo "widget.c:42: error: undefined reference to 'frob_widget'"
echo "build failed"
exit 3
