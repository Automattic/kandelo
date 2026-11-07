# Focused native TTY output controls

These controls compile the actual production OutputHandle/WindowSize header
into a small native NAPI fixture and use genuine PTYs and the exact audited
Node26.13.0 Darwin-arm64 reference. No package resolver, global setup, guest
compiler, engine build or overall suite runs. Node supplies JSAPI and native
stream/error/readline dependencies; no guest/four-host result is implied.

From the repository root, with a fresh output directory:

```
WASM_POSIX_DEV_SHELL_ATTEMPTS=1 scripts/dev-shell.sh env \
  NODE26_REFERENCE=/absolute/path/to/pinned-reference/bin/node \
  TTY_OUTPUT_CONTROL_DIR=/absolute/path/to/new/evidence \
  bash third_party/node-core/tests/tty-output-owner/run-controls.sh
```

The twelve-group original slave-PTY comparison retains the unchanged HWM=1
assertion. Ownership controls additionally exercise real inherited OFD alias
isolation, offsets, public-fd reuse, extra-descriptor close and rejection of
invalid/nonterminal inputs. Children are bounded and reaped; the byte controller
waits for actual terminal bytes before acknowledging the last slave's exit.

The final real PTY-master comparison currently exits1: native returns true at
HWM=1 and the existing borrowed asynchronous fallback returns false. This is
an implementation nonpass. The script deliberately preserves the strict
comparison; expected failure does not count as passing compatibility.

Complete public TTY constructors, resource/async metadata, originally partial
try-write/queued completion, externally nonblocking continuation, private
SIGWINCH activation and guest/Node/Chromium/Firefox/WebKit validation remain
outside these focused controls.
