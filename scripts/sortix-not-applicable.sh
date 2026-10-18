#!/bin/bash
# Sourced by scripts/run-sortix-tests.sh and scripts/run-browser-sortix-tests.sh
# so Node and browser skip exactly the same tests for the same reasons.
#
# Upstream tests that do not test a POSIX requirement on Kandelo. They are
# reported as SKIP with the reason instead of running; an expected failure
# would wrongly claim a missing feature. Each entry needs a Kandelo-owned
# replacement that asserts the POSIX-specified behavior.
#
# signal/ppoll-block-raise, signal/ppoll-block-sleep-raise: the handler is
# installed with signal(), and POSIX leaves signal()'s sa_flags to the
# implementation. musl's signal() sets SA_RESTART, and POSIX sigaction()
# says an interrupted function "shall restart ... unless otherwise
# specified"; poll()/ppoll() specify EINTR only when SA_RESTART is clear
# (unlike select()/pselect(), where restart is implementation-defined). With
# nothing else to wake it, a conforming ppoll() therefore restarts and waits
# forever, while upstream expects Linux's EINTR. Replaced by
# os-test-local/signal/ppoll-{sarestart,norestart}-*.
not_applicable_reason() {
    case "$1/$2" in
        signal/ppoll-block-raise|signal/ppoll-block-sleep-raise)
            echo "relies on signal()'s implementation-defined SA_RESTART;" \
                "see os-test-local/signal/ppoll-{sarestart,norestart}-*"
            ;;
    esac
}
