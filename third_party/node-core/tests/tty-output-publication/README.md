# Native PTY publication component

control.cjs requires TTY_OUTPUT_PUBLICATION_DIR naming an ordinary private
evidence directory with component/window.node and the exact source-backed
controls-before-core.js / controls-after-core.js projections. REPORT_FD and
RESTORE_FD are real inherited descriptors supplied by the capsule's run.py;
stdout must be a genuine PTY. The exact pinned Node26.13.0 native binary is
required. Use scripts/dev-shell.sh for commands; no global product setup.

The native addon is the existing tests/tty-output-owner/addon.cpp over the
current production terminal-operations.h. Its close/descriptor/replace calls
observe the same captured OutputHandle being tested. No synthetic metadata,
stat polling or different-resource failure injection is used. The authored
post-close throw case is only a boundary-failure-priority control: it closes
the genuine native owner first. It does not claim a reproduced guest OOM.

Native Writable, errors, VM compilation and NAPI are explicit substitutions;
new SpiderMonkey JSAPI/close-loop code and four hosts are not executed. See
the sealed capsule report for commands, source identities, compiler receipt,
raw initial/final runs and all remaining dependencies. The runner/projections
are private evidence artifacts; control.cjs is not an overall test launcher.
