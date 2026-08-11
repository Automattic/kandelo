# Kandelo Default Bash Prompt Design

## Why

Kandelo's default browser shell currently presents the fixed prompt
`kandelo$ `. It does not identify the active account or working directory,
which makes shell state harder to read and will become misleading when real
login sessions can select different users.

The surrounding system identity is also inconsistent. The kernel reports
`localhost` as the `uname(2)` nodename, while `/etc/hostname` contains
`wasm-posix`. Hardcoding `kandelo` in a prompt shaped like `user@host` would
add a third value and make presentation look more correct than the underlying
platform state.

The new default should be attractive but restrained, derive its identity from
real process and kernel state, work through normal login-shell startup, and
preserve Kandelo's reliable PTY-backed command automation.

## User-visible behavior

An interactive Kandelo Bash login shell displays a compact one-line prompt:

```text
user@kandelo ~/src/project ❯
```

- The account name comes from Bash's `\u` prompt escape, which resolves the
  current account rather than trusting the possibly stale `$USER` environment
  variable.
- The host name comes from Bash's `\h` prompt escape and therefore from
  Kandelo's `gethostname`/`uname` state.
- The working directory comes from `\w`, including Bash's normal `$HOME` to
  `~` abbreviation.
- The identity, path, and prompt glyph use restrained ANSI colors when the
  terminal supports them. The root prompt glyph is red; an ordinary user's is
  green.
- `TERM=dumb` receives the same identity and path without terminal styling and
  uses Bash's conventional privilege-aware `$`/`#` glyph.

The default does not run Git, `id`, or any other subprocess while drawing a
prompt. It does not add a clock, branch name, or success decoration. Those
features add latency and noise to a WebAssembly shell and can trigger package
materialization merely by showing an idle prompt.

## Authoritative system identity

Kandelo's default kernel nodename changes from `localhost` to `kandelo`.
`images/rootfs/etc/hostname` changes from `wasm-posix` to the same value.
`uname`, `gethostname`, the rootfs file, and Bash's `\h` consequently agree.

This work changes the default hostname value, not the syscall interface:
`uname` keeps its existing layout and behavior, and `sethostname` remains an
honest `EPERM` stub. The change therefore does not require an ABI version bump
or structural ABI snapshot update. Future mutable or per-machine hostnames
will require a separate design for authoritative UTS state and
`sethostname` semantics.

## Shell configuration ownership

The visible prompt belongs to the guest image, not the browser loader. A
tracked `/etc/profile.d` fragment supplies the default for interactive Bash
login shells, and `/etc/profile` continues to source readable fragments
through its existing POSIX-shell path.

The fragment is guarded by both Bash identity and interactive-shell state so
Dash, service processes, and noninteractive login commands do not receive
Bash-only prompt escapes. Rootfs and rootfs-derived shell images carry the
same tracked fragment through the ordinary manifest and VFS composition path.
Package revisions and derived image inputs are updated wherever these changed
bytes invalidate a published artifact.

The browser's hardcoded visible `PS1` values stop being the authority for Bash
sessions. Consequently, every Bash login shell using the Kandelo rootfs,
including specialized demo sessions, follows the same real user, hostname,
and working-directory convention. A custom image that selects another shell
retains that shell's own prompt behavior.

## PTY readiness protocol

Kandelo currently recognizes the exact browser-supplied `PS1` string to decide
when a persistent shell has completed a guided command. A prompt containing
`\u`, `\h`, or `\w` cannot be compared as one fixed visible string, and
falling back to a trailing `$ ` heuristic can mistake ordinary command output
for readiness.

The Bash prompt therefore brackets its visible text with the standard
invisible OSC 133 prompt-start (`A`) and command-start (`B`) markers.
`LiveKernelHost` recognizes the trailing `B` marker—the boundary after prompt
rendering and immediately before input—as the readiness signal. The terminal
renders only the dynamic prompt. Readiness remains separate from presentation:
changing directory, changing users through a real login, or restyling visible
colors does not change the machine-readable boundary.

Existing exact-prompt and conservative fallback detection remain available
for custom shells that do not emit the marker. The marker is not emitted for
`TERM=dumb`; its conventional `$`/`#` ending remains compatible with the
existing conservative fallback. Marker-based Bash detection waits for the
trailing `B` boundary and does not treat the leading `A` marker, shell
continuation prompts, or output that merely ends in a prompt-like glyph as
completion.

## Failure behavior

- If account lookup fails, Bash's native prompt expansion owns the visible
  fallback; browser code does not synthesize a username.
- If a custom image does not include the prompt fragment, its shell remains
  usable through the existing readiness paths.
- If a terminal does not interpret ANSI/OSC controls, `TERM=dumb` selects the
  unstyled `$`/`#` prompt and no hidden control marker.
- A missing or stale rootfs artifact remains an artifact/build failure. The
  browser does not patch `/etc/profile`, `/etc/hostname`, or the prompt at
  runtime to disguise it.

## Documentation and validation

Implementation updates the current browser and POSIX documentation to state
that the default hostname is `kandelo`, explain the image-owned Bash prompt,
and distinguish the fixed default nodename from the still-unsupported mutable
hostname operation.

Validation covers the exact claims made by the change:

1. Kernel unit coverage verifies that `uname` returns `kandelo` as its
   nodename without changing the surrounding struct fields.
2. Rootfs and shell-image tests verify `/etc/hostname`, the tracked prompt
   fragment, manifest ownership, and derived-image preservation.
3. Session tests verify OSC-marker readiness across changing directories and
   ensure prompt-looking command output and Bash continuation prompts do not
   complete commands early.
4. Node-side shell/image validation verifies the composed guest state through
   the normal VFS path.
5. Browser tests and a manual `./run.sh browser` check verify the rendered
   `user@kandelo` prompt, `~`/working-directory updates, colors, and guided
   command completion in the real terminal.
6. The ABI snapshot check verifies that no structural ABI surface changed.
   Relevant `uname`/`gethostname` conformance coverage is considered because
   the kernel's observable system identity changed.

Performance is not claimed. Avoiding per-prompt subprocesses is a design
constraint, not benchmark evidence.
