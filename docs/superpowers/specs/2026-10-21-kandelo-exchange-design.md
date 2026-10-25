# Kandelo exchange: moving files into and out of a running machine

Date: 2026-10-21
Status: Design agreed for v1 planning; not implemented. Revised
2026-10-22: kernel-owned activation replaces service-manager start-up.

## Why

A person using a Kandelo machine has no general way to hand it a file,
and a program inside the machine has no general way to hand a file back.

Today one narrow facility exists. A machine profile in
`/etc/kandelo/demo.json` can declare an `ingest` block: a list of
accepted extensions, one fixed destination path, a size cap, and an
optional restart command. The framebuffer pane then offers a file
picker and a drop target. Three profiles use it (doom, quake, scummvm in
`packages/registry/shell/source-rootfs-shell-demo-profiles.json`).
It has real limits:

- It works on the framebuffer pane only, one file at a time, always to
  the same path. Folders, several files, and the original filename are
  not supported.
- The "reaction" to a file is the host signalling the program that
  holds `/dev/fb0` and then typing the image's restart command into the
  terminal (`web-libs/kandelo-session/src/demo-ingest.ts`). Nothing
  inside the machine receives an event, and the host is driving process
  control that belongs to the guest.
- Nothing comes back out. A program that renders an image, exports a
  project, or records audio cannot offer the result to the user.
- It is tied to a browser gesture. A Node.js embedder, or code that wants
  to feed a stream into a machine, has no equivalent.

The result is that every program wanting input from outside needs a
bespoke path, and every program wanting to produce output has none. This
design replaces `ingest` with one platform facility, *Kandelo
exchange*. It moves files in both directions through the normal
platform path (VFS, syscalls, kernel, host runtime). It works the same
way on the Node.js and browser hosts, and it is independent of drag and
drop.

## Terms

- **Host**: the JavaScript side that embeds a Kandelo machine. That is
  the browser app or a Node.js program, through `KernelHost`.
- **Guest**: programs running inside the machine.
- **Exchange filesystem**: a kernel-provided filesystem mounted at
  `/run/kandelo/exchange` on every machine.
- **Batch**: a set of input files the host offers together. One drop of
  three files is one batch; three drops are three batches.
- **Consumer**: the one guest process that holds the exchange `events`
  file open. Normally this is the agent.
- **Agent**: the image's program at `/usr/libexec/kandelo/exchange-agent`.
  The base rootfs installs `kxchgd` there.
- **Activation**: the kernel starting the agent on demand, when a batch
  arrives and no consumer exists.
- **Handler**: a program the agent runs to process one batch.
- **Work session**: a private staging directory whose lifetime is tied
  to an open file descriptor.
- **Output**: a file a guest publishes to the host.
- **Lease**: the host's ownership of a published output. Every lease
  ends deterministically; see "Ownership".
- **Item**: anything that has an exchange ID. That is a batch, an entry
  inside a batch, or a published output.
- **xattr**: extended attribute, a `name=value` pair attached to a file
  (`getxattr(2)`, `setxattr(2)`).

## What exists today

| Facility | State | Where |
|---|---|---|
| `ingest` (fixed-path upload, restart command) | Implemented; replaced by this design | `web-libs/kandelo-session/src/demo-ingest.ts`, `demo-config.ts`, `apps/browser-demos/pages/kandelo/panes/Framebuffer.tsx` |
| Boot inputs (sha256-verified files written before boot) | Implemented; unrelated to this design, which handles files arriving while the machine runs | `web-libs/kandelo-session/src/boot-inputs.ts` |
| Host clipboard device and its agent `kclipd` | Implemented; the model for a host-fed kernel object with one guest agent | `docs/architecture.md` "Host clipboard" |
| Extended attributes | Stubbed in a way that hides the gap: the set calls report success and store nothing, the get calls return ENODATA, the list calls return an empty list. `docs/posix-status.md` wrongly says ENOSYS. The syscalls have no `SYS_*` constants in `crates/shared` and no marshalling specs, so the kernel never sees their path, name, or value arguments. | `crates/kernel/src/wasm_api.rs` (numbers 350–361), `libc/musl-overlay/arch/*/bits/syscall.h.in` |
| `inotify` | ENOSYS | `docs/posix-status.md` |
| Guest `mount(2)` | ENOSYS; hosts configure mounts at boot | `docs/posix-status.md`, `host/src/vfs/default-mounts.ts` |
| Wayland drag and drop | `start_drag` is a no-op | `programs/wlcompositor/wlcompositor.c` |

A separate kernel defect matters to the `ingest` migration but not to
this design. A process that has `/dev/fb0` mapped keeps the device until
its parent reaps it, not when it exits. `cleanup_process_for_exit` in
`crates/runtime-core/src/syscalls.rs` never drops the framebuffer
binding; only reaping does (`finish_removed_process` in
`crates/kernel/src/wasm_api.rs`). It is tracked as its own fix. The
launch wrappers in "Replacing `ingest`" are the parent of the program
they restart, and reaping happens inside `wait`, so they work either
way.

## Principles

1. **One owner per object, released on observable events.** Every
   exchange object is owned by an open guest file description or by a
   host lease. Ownership ends on an event the kernel can observe: a
   close, a process exit, a listener being aborted, the kernel being
   destroyed. It never ends on JavaScript garbage collection. Names are
   views of objects, not owners. Quotas turn a live but negligent owner
   into visible backpressure instead of unbounded growth.
2. **Files are files.** Inputs and outputs are ordinary filesystem
   objects. Any program can read them by path. Metadata lives in the
   filesystem itself (stat fields and xattrs), not in side files.
3. **The kind is truthful.** A source with random access and a known
   size is a regular file. A source that is a stream of unknown length
   is a FIFO. Neither pretends to be the other.
4. **Policy lives in the image; delivery lives in the platform.** The
   host delivers files and receives outputs. It never decides what a
   file means and never types commands into the guest.
5. **Host-neutral.** The platform interface is the same on Node.js and
   in the browser. Drag and drop, file pickers, and any default
   destination for outputs belong to the embedding app.
6. **Truthful failure.** No consumer, no listener, quota exceeded, an
   unreadable source, a crashed writer: each one fails visibly with the
   errno POSIX gives that condition.
7. **Composable.** "Expect the output of every program to become the
   input to another, as yet unknown, program" (Doug McIlroy). See the
   checklist below.

### Composability checklist

Every change to exchange should answer these four questions.

1. **Closure.** Can an output be represented as an input? It should
   be: the same kind of file with the same metadata (`user.mime_type`,
   provenance), so it can be offered to another machine or round-tripped
   later with no special case.
2. **Identity.** Does passing a file through a handler that does nothing
   preserve its metadata? A plain `cp` drops xattrs; a handler that
   republishes a file must carry its metadata explicitly.
3. **Associativity.** Is provenance the same whether a pipeline runs as
   one handler or as two?
4. **Kind preservation.** Does a stream stay a stream and a random-access
   file stay a random-access file through every step?

## The exchange filesystem

### Mount, ownership, and permissions

Every machine mounts the exchange filesystem, on both hosts. The hosts
configure it at boot like the other default mounts. Guest `mount(2)`
stays ENOSYS and is tracked as its own gap. There is exactly one
instance per machine.

- Filesystem type name: `kandelo-exchange`. `statfs` reports `f_type`
  `0x4B584348` (ASCII "KXCH"). It follows Linux's habit of ASCII magics
  (`0x58465342` "XFSB"), matches no Linux magic, and is hard to produce
  by accident. Documented in `docs/posix-status.md`.
- Mount options: `nosuid`. Execution is allowed: dropped files are the
  user's own, and running one takes an explicit action.
- A reserved group `exchange`, GID 120, owns the control files. It is
  declared in the base rootfs `/etc/group`. The GID can be changed later
  if it collides. User `maker` is a
  member in the core images. Group membership is the capability to
  receive dropped files and to publish outputs. An image that wants no
  exchange leaves the group empty. Root bypasses permission checks as
  usual.
- The mount is cleared at boot. Consumers, sessions, and leases cannot
  survive a reboot, so neither can exchange contents. That holds even
  when the root filesystem is persistent.
- Bytes stored in `work/` and `outbox/` use the same backend as the root
  filesystem: memory today, the OPFS image once that lands. They count
  against the root filesystem's space.

Mode bits express each rule below. Where root would bypass a mode bit,
the filesystem enforces the rule itself and returns EPERM.

### Layout

```
/run/kandelo/exchange/                      0755 root:root
  events                                    0440 root:exchange
  inbox/                                    0770 root:exchange
    0192f3a1-7c4e-8a2b-8f00-3c1d9e5b4a10/   one batch, named by its ID
      photo.jpg                             regular file, lazy, read-only
      vacation/IMG_0001.jpg                 dropped folders become directories
      camera-feed                           FIFO, when the host offered a stream
  work/                                     0750 root:exchange
    clone                                   0440 root:exchange
    3/                                      one work session, 0700 owner:owner
  outbox/                                   0770 root:exchange
    contact-sheet.pdf                       published, frozen
    capture.webm                            published stream (FIFO)
```

The mount root, `inbox/`, `work/`, and `outbox/` never gain other
entries. Creating anything else in them fails with EPERM.

### Items and IDs

Every item carries a read-only xattr `user.kandelo.id`. The kernel
assigns it when the host offers a batch (for the batch and each of its
entries) and when a guest publishes an output. Files in a work session
have no ID until they are published.

IDs are UUIDs in canonical lowercase text form. Because the layout is
custom, the version is 8 (RFC 9562 §5.8):

| Bits | Field |
|---|---|
| 48 | Unix time in milliseconds, clamped so it never goes backwards |
| 4 | Version `8` |
| 12 | Counter, high bits |
| 2 | Variant `10` |
| 20 | Counter, low bits |
| 42 | Mount nonce: random, chosen when the mount is created |

- The counter is 32 bits, increases by one per item, and is never
  reused. Exhausting it fails new offers and publishes with ENOSPC.
- The time field leads and the counter follows it, so sorting IDs as
  strings gives the order they were issued. `ls inbox/` lists batches in
  arrival order.
- **Validation needs no storage.** An ID is valid on this mount if its
  version and variant are right, its nonce matches the mount nonce, and
  its counter is below the next counter. The kernel stores nothing per
  ID. A counter value is only used up when an item is created, so every
  valid ID names a real item, including items since removed.
- IDs from another machine, an earlier boot, or a different kind of
  number fail with EINVAL. Provenance across machines is the host's to
  record. The host knows when it feeds one machine's output into
  another machine.
- Internally an ID is 16 bytes. The 36-character text form exists only
  at the xattr and host-API boundary.
- Work session numbers are not IDs. They come from a separate counter,
  are short decimal numbers, and are never accepted in
  `derived_from`. A session is a staging handle, not an item.

### The consumer and `events`

- The consumer is whichever process holds `events` open for reading. A
  second open fails with EBUSY. Ownership belongs to the open file
  description, so `dup` and `fork` share it. It ends when the last
  descriptor for that description closes, including at process exit.
- Opening `events` for writing fails.
- Reading returns LF-terminated ASCII lines of at most 64 bytes:

  | Line | Meaning |
  |---|---|
  | `outputs accepting` | A host output listener is registered. Always the first line after open, or `outputs none`. |
  | `outputs none` | No host output listener; publishing fails with ENXIO. |
  | `batch <id>` | A new batch is complete and visible under `inbox/<id>/`. |

  Consumers must ignore line kinds they do not recognize, so the grammar
  can grow.
- A `read()` returns whole lines when the buffer allows. A buffer
  shorter than the next line streams through it, as with the clipboard
  device. A blocking read waits for the next line. `O_NONBLOCK` gives
  EAGAIN. `poll()` reports `POLLIN` while a line is pending.

### Inputs

**A batch appears all at once.** The host stages every entry, then
commits. Only then does the directory `inbox/<id>/` appear and the
`batch` line get emitted. A consumer never sees a partial batch.

**Pending batches.** A staged batch is committed only while a consumer
exists. Until then it is *pending*:

- it is invisible to the guest;
- it is owned by the host's offer;
- it counts against the pending-batch quota;
- it triggers activation (see "Activation").

When a consumer opens `events`, pending batches commit in order. If the
offer gives up (its `signal` aborts or its timeout passes), the kernel
discards the pending batch. The kernel never holds a batch that nobody
is waiting on.

**Ownership.** The consumer owns its batches. The batch directory and
its entries belong to the consumer's UID and the `exchange` group.
Batches end in one of three ways:

- **Removed** by the consumer. Removing the batch directory is the
  acknowledgement (`rm -r inbox/<id>`, or `kandelo-exchange ack <id>`).
  Removing entries one by one beforehand is allowed and releases them
  early.
- **Discarded** when the consumer's description closes. Every batch
  whose `batch` line the consumer has read but not removed is removed.
  A batch whose line was never read was never delivered. It returns to
  pending, which activates the agent again. This is not redelivery,
  because no consumer saw it. It closes the race between a new batch
  and an agent exiting while idle.
- **Cancelled** by the host.

Removal works like `unlink`. Descriptors already open on an entry keep
working until they close, and only then does the platform drop its
reference to the host source. There is no redelivery in v1. A
consumer that exits loses its unremoved batches, and the host is told so.

**Entries.**

- A host `Blob` becomes a **regular file**.
  - `st_size` is the Blob's size. `st_mtime` is the host-supplied
    modification time, or the offer time. `st_atime` and `st_ctime` are
    the offer time.
  - Bytes are read lazily by range from the host source, through a
    bounded cache. They are never copied whole into VFS memory, so a
    large drop does not have to fit in the root filesystem.
  - A read waits until its bytes arrive, can be interrupted by a signal
    (EINTR), and fails with EIO if the source has become unreadable
    (for example, the file changed on disk).
  - Seeking and private read-only `mmap` work as for other host-backed
    files.
- A host `ReadableStream<Uint8Array>` becomes a **FIFO**.
  - `st_size` is 0, `lseek` fails with ESPIPE, and the data can be read
    once. Several readers share it, as with any FIFO.
  - The host is the writer and is present from the moment the batch
    appears, so opening for read does not block.
  - When the host stream closes, the reader gets end-of-file. When the
    host stream errors, `read()` fails with EIO, so a truncated input
    is never mistaken for a complete one. The kernel buffers at most
    64 KiB per FIFO and applies backpressure to the host.
  - When the entry is removed before being fully read, the host stream
    is cancelled.
- Host-supplied directory paths become **directories** inside the
  batch.
- Entries cannot be written to, truncated, renamed, hard-linked, or
  given new xattrs: EPERM. Copying bytes out (`cp inbox/<id>/a
  "$KANDELO_WORK"/`) works. Hard links are refused because a second
  name would keep a host source alive after its batch was released.
- Inputs never contain symbolic links, because hosts offer files,
  streams, and directories only. Creating a symbolic link in `inbox/`
  fails with EPERM.

**Names are untrusted.** The host runtime cleans each path component,
and the kernel validates it again; the kernel is the authority.

- Components are non-empty, at most 255 bytes of UTF-8, not `.` or `..`,
  and contain no `/` or NUL.
- Invalid UTF-16 (lone surrogates) becomes U+FFFD.
- An over-long name is shortened, keeping its extension.
- Names that collide after cleaning get ` (2)`, ` (3)`, and so on,
  inserted before the extension.
- When cleaning changes a name, the original goes in
  `user.kandelo.original_name`.
- A name never reaches a shell command or a path chosen outside the
  batch.

### Work sessions

A work session is a staging directory tied to an open file description.
Most code never handles one directly. The agent creates a session for
every handler, and `kandelo-exchange run` creates one for any other
command (see "Guest software").

- Opening `work/clone` for reading creates `work/<n>/`, owned by the
  opener with mode 0700. Reading the descriptor returns `<n>\n` once,
  then end-of-file.
- The session lives as long as that open file description. When its
  last descriptor closes, including at process exit or on SIGKILL, the
  session directory and everything unpublished in it are removed. As
  with inputs, descriptors still open on files inside keep working
  until they close.
- Inside a session, ordinary operations work: create, write, `mkdir`,
  `mkfifo`, symbolic links, rename, hard links, and copies within the
  same session.
- Symbolic links are allowed because a symlink names a path; it does
  not own the object. Unlike a hard link, a symlink into `inbox/` cannot
  keep a host source alive. It dangles once the batch is removed, which
  is truthful. Symbolic links cannot be published, and `lsetxattr` on
  one fails with EPERM, as on Linux.
  xattrs that may be set: `user.mime_type`,
  `user.kandelo.derived_from`, and `user.xdg.*`. Renaming in from
  another filesystem fails with EXDEV as usual, so `mv` falls back to
  copying, which works.
- Creating anything directly in `work/` fails. Renames and links between
  sessions, or between a session and `inbox/`, fail with EPERM.

### Outputs

An output is published by renaming it from a work session into
`outbox/`:

```
rename("work/3/contact-sheet.pdf", "outbox/contact-sheet.pdf")
```

**Publish checks.** The rename succeeds only if all of these hold:

- A host output listener is registered. Otherwise **ENXIO**.
- The source is a regular file or a FIFO. Directories and symbolic
  links cannot be published in v1 (EPERM).
- No open file description has the source open for writing. Otherwise
  **EBUSY**, so a published file can never change under the host.
- The target name does not already exist in `outbox/`. Otherwise
  **EEXIST**, so a publish never replaces an earlier output.
- The output quotas allow it. Otherwise **ENOSPC**.

**On success:**

- The kernel assigns a `user.kandelo.id`.
- It freezes the output: writing, truncating, changing xattrs, renaming
  within `outbox/`, and hard-linking all fail with EPERM.
- It announces the output to the host listener.
- The guest may still `unlink` an output to withdraw it. The host is
  told, and a host read already in progress finishes, as with
  `unlink`.

**Provenance.** `user.kandelo.derived_from` lists the IDs of the items
an output came from, one per line: whole batches, single input entries,
or earlier outputs. One input may lead to several outputs, several
inputs may lead to one, and an output need not have any. `setxattr`
validates every line as an ID issued by this mount (EINVAL otherwise).
It accepts at most 64 entries (E2BIG beyond). Items referenced may have
been removed since; the reference is to history, not to a live object.

**Stored and streamed outputs.**

| | Stored output | Streamed output |
|---|---|---|
| Published file | Regular file | FIFO |
| Size | Known | Unknown, read once |
| Bytes held | The whole file, in the exchange filesystem | Only what is in flight in the FIFO buffer |
| The host reads it | Any number of times while its lease lasts, optionally by range | Once |

**Streamed outputs** work like FIFOs whose reader is the host:

- The guest creates the FIFO in a session, sets its xattrs, and
  publishes it. Only then does it open the FIFO for writing.
- A blocking open waits until the host starts reading. With
  `O_NONBLOCK`, the open fails with ENXIO until the host has started.
- If the host ends the lease before the stream ends, writers get EPIPE
  and SIGPIPE.

**Stream completion is explicit.** A closed pipe looks the same to its
reader whether the writer finished or crashed, because the kernel
closes a dead process's descriptors. So a writer declares the end
*before* closing, by setting `user.kandelo.end` on the published FIFO:

- `complete`: everything has been written.
- `aborted <reason>`: the stream failed. The reason is at most 256 bytes
  of UTF-8.

`user.kandelo.end` can be set once, and only on a published FIFO; it is
the one exception to freezing. After it is set, further writes fail
with EPERM. When the host reaches end-of-file:

- `complete` set: the host's stream closes normally.
- `aborted` set: the host's stream errors with the reason.
- Neither set: the host's stream errors as incomplete.

A crashed writer therefore always shows up as a failed output, never as
a short file that looks finished. The `kandelo-publish --stream` helper
sets `complete` only when the producer it runs exits with status 0.

Linux permits `user.*` xattrs only on regular files and directories.
Allowing them on exchange FIFOs is a documented difference from Linux.
POSIX does not define xattrs at all, so this is not a POSIX deviation.

### Extended attributes

v1 implements all twelve xattr syscalls: get, set, list, and remove, in
their path, `l`, and `f` forms.

- On the exchange filesystem, only the `user.` namespace exists. Other
  namespaces fail with ENOTSUP.
- On every other filesystem, get, set, and remove fail with ENOTSUP and
  list returns an empty list. That is what Linux does for a filesystem
  without xattr support (its `listxattr` falls back to security labels,
  of which there are none). It replaces today's stubs, which report
  success for set calls and store nothing.
  Copying tools are expected to tolerate ENOTSUP (for example,
  `cp --preserve=xattr` and Python's `shutil.copystat`); the plan
  verifies this for the tools Kandelo ships.
- The ordinary errors apply: ENODATA for a missing attribute, ERANGE
  for a buffer that is too small (a size-0 query returns the size),
  EEXIST and ENODATA for the `XATTR_CREATE` and `XATTR_REPLACE` flags,
  E2BIG for a value over the cap, and EPERM for read-only attributes.

| Attribute | On | Set by | Notes |
|---|---|---|---|
| `user.kandelo.id` | Batches, input entries, outputs | Kernel | Read-only |
| `user.mime_type` | Input entries, session files, outputs | Host (inputs); guest (outputs) | Freedesktop "Common Extended Attributes" name. Absent when the host did not know the type. A hint, not a verified type. |
| `user.xdg.origin.url` | Input entries, session files, outputs | Host (inputs); guest (outputs) | For example, a dragged link |
| `user.kandelo.original_name` | Input entries | Host | Only when cleaning changed the name |
| `user.kandelo.index` | Top-level input entries | Host | Order the host listed the entries in, from 0. Nested entries have none, because the browser reports no meaningful order inside folders. |
| `user.kandelo.source` | Batches | Host | Which gesture created the batch: `drop`, `picker`, `paste`, `share`, or `api` |
| `user.kandelo.status` | Batches | Guest (consumer or handler) | At most 256 bytes of UTF-8, no control characters. The host shows it as progress text. |
| `user.kandelo.derived_from` | Session files, outputs | Guest | Provenance; see "Outputs" |
| `user.kandelo.end` | Published FIFOs | Guest | `complete` or `aborted <reason>`; set once |

Values are capped at 4 KiB unless the table says otherwise.

### Errors

| Situation | Result |
|---|---|
| Second open of `events` | EBUSY |
| Host offers a batch with no consumer | Offer rejected (host side); nothing appears in the guest |
| Publish with no host listener | ENXIO |
| Publish while the source is open for writing | EBUSY |
| Publish onto an existing output name | EEXIST |
| Changing a frozen output or an input entry | EPERM |
| Creating outside a session, or linking or renaming across areas | EPERM |
| Renaming into a session from another filesystem | EXDEV (so `mv` copies) |
| Writing to a stream whose lease ended | EPIPE + SIGPIPE |
| Opening a published output after its lease ended | ENOENT (it was unlinked) |
| Reading an input whose host source failed | EIO |
| Unknown ID or malformed provenance | EINVAL |
| Any quota exceeded, by bytes or by object count | ENOSPC |

### Quotas and `statfs`

Quotas are host configuration, with defaults in the host runtime
profile. Images may not raise them, following the `runtime.requests`
clamping model. Defaults (agreed 2026-10-21):

| Limit | Default |
|---|---|
| Pending batches | 16 |
| Entries per batch, including folder contents | 1024 |
| Folder depth inside a batch | 16 |
| Open work sessions | 32 |
| Bytes in `work/` and `outbox/` together | 256 MiB, and at most a quarter of the root filesystem's capacity |
| Unreleased stored outputs | 64 |
| Unfinished streamed outputs | 8 |
| FIFO buffer, each direction | 64 KiB |

`statfs` on the mount reports the byte quota as the filesystem's size
and the object quotas as its inode counts. ENOSPC is then truthful by
the usual reading: there is no space, or there are no inodes left.
Input bytes do not count against the byte quota; they are not stored.

## Activation

The platform starts the image's agent when it is needed and at no other
time. The kernel decides; the host only launches. Linux has the same
shape: `call_usermodehelper` runs `/sbin/modprobe` and similar helpers
on demand. inetd and systemd socket activation, and the Plan 9
plumber's `plumb start`, are the same idea in userland.

**The agent path is the contract.**

- `/usr/libexec/kandelo/exchange-agent` is part of the platform–image
  contract, documented alongside `/etc/kandelo/demo.json`.
- An executable there means the machine accepts files. No executable
  means `unavailable`. The check is ordinary path resolution and exec
  permission. The kernel makes it at boot, again on every offer, and
  whenever the host asks, so replacing or removing the file at runtime
  is reflected. Nothing else is inferred.
- The base rootfs installs `kxchgd` there, so every image built on it
  has exchange, under every init shape: `{ target }`, `{ program }`,
  `shellCommand`, and plain login sessions.
- An image supplies its own agent by replacing the file, or opts out by
  not shipping it.
- No service manager, image declaration, profile field, or pid 1
  behavior is involved.

**When.** Activation happens only on demand, never at boot, so a
machine that never receives a file pays nothing. It happens when a batch
is pending, no consumer holds `events`, the agent is not already
starting, and no backoff delay is running.

**How.**

- The kernel creates the agent's process record the way it does for
  `posix_spawn`:
  - argv `["/usr/libexec/kandelo/exchange-agent"]`;
  - environment `PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` and
    `KANDELO_EXCHANGE=/run/kandelo/exchange`;
  - working directory `/`;
  - uid and gid 0, with no supplementary groups;
  - stdin, stdout, and stderr on `/dev/null`;
  - its own session and process group, so no terminal's job control
    reaches it;
  - parent pid 1, the synthetic init.
- A host import then asks the host to launch that process through the
  same preflight and worker-launch path that `posix_spawn` children use.
  That path is shared runtime code, so both hosts behave the same by
  construction.
- An exec failure (ENOENT, EACCES, ENOEXEC, an ABI mismatch) is an
  activation failure, reported with its errno.

**Readiness and failure.**

- The agent is `starting` from activation until it opens `events`, and
  `ready` after that. Exiting before opening `events` is a failure.
- After consecutive failures the kernel backs off: 250 ms, doubling, up
  to 5 s. The count resets once the agent has been `ready` for 2 s. This
  mirrors the terminal session supervisor.
- The kernel reports the last failure to the host: the exit status or
  signal, or the exec errno. Pending offers keep waiting through backoff
  until their own timeout.

**Exiting when idle.** An agent may exit when it has no batch in
flight; `kxchgd` exits after 60 s idle. Its exit closes `events`, and
the state returns to `idle`. A batch committed while it was exiting
returns to pending, because its line was never read (see "Inputs"). The
next activation picks it up.

**Reaping.** The agent's parent is the synthetic init, which has no
wait loop, so the kernel reaps the agent as soon as it exits and records
the status for the failure report. This is the "init reaps its
children" behavior that the separate orphan-reparenting change
implements. Whichever change lands first provides it, and the other
reuses it.

**Credentials: the agent drops its own privileges.**

- The kernel starts the agent as root, as Linux does for its helpers.
  The agent contract, documented for anyone writing an agent, says the
  agent must drop privileges itself before touching any input.
- `kxchgd` does this in order:
  1. Reads `/etc/kandelo/exchange.conf`, which holds the line `user
     maker` on the core images.
  2. Resolves that user with `getpwnam`.
  3. Calls `initgroups`, `setgid`, and `setuid`.
  4. Checks that it cannot regain root (`setuid(0)` must fail with
     EPERM).
  5. Opens `events`. It does so only now because batches belong to the
     consumer's credentials as of that open (see "Ownership"); opened as
     root, every batch would be root's, and the handler account could
     neither remove it nor set its status. The account can open
     `events` because it must be in `exchange`.
  6. Only then reads rules and processes batches.
- If `exchange.conf` is missing or invalid, or the user is unknown,
  `kxchgd` exits with status 78 (`EX_CONFIG`) and logs why. The host
  shows that as an activation failure rather than guessing a user.
  `user root` is honored only when written explicitly.
- The configured account must be in the `exchange` group, because
  handlers open work sessions. `kxchgd` checks this and fails clearly
  if it is not.
- Logging goes to `/var/log/kxchgd.log`, on the scratch `/var/log`
  mount. Failures for a batch also appear in its status.

**Embedder control: `exchange.activation`.**

- **What it is.** A setting the embedder passes when it creates a
  `KernelHost`, on both hosts: `"on-demand"` (the default) or `"off"`.
  It is fixed for the machine's lifetime, and the host passes it to the
  kernel at init.
- **Why it exists.** Two parties have a say:
  - the **image** decides whether an agent exists (the file at the agent
    path);
  - the **embedder** decides whether the platform may start it
    implicitly.

  Uses for `"off"`:
  - tests in which a test program is the consumer, with no agent racing
    it;
  - embedders that start their own consumer;
  - embedders whose policy forbids processes they did not launch,
    including a helper started as root;
  - running `kxchgd --foreground` by hand to debug.
- **Behavior with `"off"`.**
  - The kernel never creates the agent.
  - Everything else is unchanged: batches still wait as pending and
    commit as soon as any consumer opens `events`.
  - Offers wait until their timeout. An embedder that turned activation
    off has promised that a consumer will come; if none does, the drop
    fails visibly at the timeout.
  - The consumer state reports `activation: "off"`, so the UI can say
    "Waiting for a file handler" instead of "Starting the file
    handler…".
- **Who can set it.** Only embedder code. Boot descriptors, shared URLs,
  and image files cannot. They are untrusted input, and a link must not
  be able to switch a platform behavior on or off. The browser app uses
  the default.

## Host interface

The interface lives on `KernelHost` (`web-libs/kandelo-session`) and is
implemented by the host runtime (`host/src`) for both hosts. Names here
are working names; the plan may rename them.

### Offering inputs

```ts
interface ExchangeItem {
  name: string;
  /** Directories inside the batch, outermost first (folder drops). */
  dirs?: readonly string[];
  source: Blob | ReadableStream<Uint8Array>;
  mimeType?: string;
  modifiedMs?: number;
  originUrl?: string;
}

interface ExchangeBatch {
  readonly id: string;
  readonly entries: readonly { id: string; path: string }[];
  /** Latest `user.kandelo.status` text. */
  readonly status: string | undefined;
  onStatus(listener: (status: string) => void): () => void;
  /** Resolves when the batch leaves the inbox. */
  readonly settled: Promise<{
    outcome: "removed" | "discarded" | "cancelled";
    status?: string;
  }>;
  /** Resolves when the platform holds no reference to any source. */
  readonly released: Promise<void>;
  cancel(): void;
}

host.exchange.offer(
  items: readonly ExchangeItem[],
  options?: { source?: "drop" | "picker" | "paste" | "share" | "api";
              signal?: AbortSignal;
              consumerTimeoutMs?: number },
): Promise<ExchangeBatch>;

interface ExchangeConsumerState {
  /** "unavailable": no agent at the agent path, and no consumer.
   *  "idle": no consumer. With activation on, an offer activates the
   *    agent; with activation off, offers wait for some consumer.
   *  "starting": activated, or in backoff; nothing holds `events` yet.
   *  "ready": a consumer holds `events`. */
  state: "unavailable" | "idle" | "starting" | "ready";
  activation: "on-demand" | "off";
  lastFailure?: { exitStatus?: number; signal?: number; errno?: number };
}
host.exchange.consumer: ExchangeConsumerState;
host.exchange.onConsumer(
  listener: (state: ExchangeConsumerState) => void,
): () => void;
```

- `offer()` resolves once the batch is visible to the guest. It rejects
  with a typed reason (`unavailable`, `consumer-timeout`, `quota`,
  `invalid-name`, `aborted`) without changing the guest.
- Aborting the `signal` cancels the batch.

**Readiness.** The kernel reports every state; the host never infers
one.

- `unavailable`: `offer()` rejects at once with `unavailable`.
- `idle` or `starting`: `offer()` stages the batch as pending, which
  activates the agent if needed. It resolves when the batch commits. It
  rejects with `consumer-timeout` after `consumerTimeoutMs` (default
  30 s), or `aborted` when its `signal` aborts. In both cases the kernel
  discards the pending batch.
- `ready`: the batch commits at once.
- A batch with no matching rule does not wait. The agent fails it as
  soon as it looks at it, with `no handler: <name>`.
- The output listener needs no readiness wait. It is host state and can
  be registered before boot. A consumer that opens `events` later sees
  `outputs accepting` as its first line.
- `settled` and `released` are separate because a guest can keep reading
  an entry after its batch is removed. A host that needs to know when it
  may close its own files waits for `released`.

### Receiving outputs: scoped leases

```ts
interface ExchangeOutput {
  readonly id: string;
  readonly name: string;
  readonly kind: "stored" | "stream";
  readonly size?: number;            // stored outputs
  readonly mimeType?: string;
  readonly originUrl?: string;
  readonly derivedFrom: readonly string[];
  /** Stored: callable repeatedly, optionally by range. Stream: once. */
  read(range?: { start: number; end?: number }): ReadableStream<Uint8Array>;
  /** Resolves when the guest withdraws the output. */
  readonly withdrawn: Promise<void>;
}

host.exchange.onOutput(
  listener: (output: ExchangeOutput, scope: { signal: AbortSignal })
    => void | Promise<void>,
  options: { signal: AbortSignal },
): void;
```

- **One listener at a time.** Registering a second while one is active
  throws. This mirrors the single consumer on the guest side. An app
  that wants several destinations fans out inside its listener.
  Registering a listener makes the guest see `outputs accepting`, and
  aborting its `signal` makes it see `outputs none`.
- **A lease lasts as long as its scope:**
  - It ends when the listener's returned promise settles **and** every
    stream obtained from `read()` has closed or been cancelled.
  - A listener that returns nothing and calls `read()` nothing releases
    the output at once. Ignoring outputs leaks nothing.
  - Waiting for a user's "Save" click is just an `await` inside the
    listener. A "Dismiss" control resolves it.
- **Aborting the listener's `signal`** aborts every scope's `signal` and
  ends every lease.
- **When a lease ends**, the output is unlinked from `outbox/`, and
  writers of an unfinished stream get EPIPE.
- **After release**, using an `ExchangeOutput` fails with a "lease
  ended" error. It never returns stale data.
- **No default destination.** No host turns outputs into files,
  downloads, or anything else on its own. The Node.js host writes
  nothing to disk unless its embedder's listener does so.

### Diagnostics

`host.exchange.stats()` reports whether a consumer is present, the
number of batches, entries, sessions and output leases, stored bytes,
and how many host sources the platform still references. Exchange tests
end by asserting these return to zero after processes are killed,
listeners are aborted, and kernels are destroyed.

### Node.js and browser

The two hosts expose the same API with the same guest-observable
behavior.

- `Blob` and web streams exist on both hosts. On Node.js,
  `fs.openAsBlob()` provides Blobs backed by a file on disk.
- **Sources stay where they were offered.** The kernel worker asks the
  host side that owns a source for byte ranges, over the existing
  worker message channel. That side answers with transferred
  `ArrayBuffer`s. Stream chunks are pumped the same way, with
  backpressure. One protocol therefore serves every kind of source on
  both hosts, and the main thread never owns a VFS `SharedArrayBuffer`.
- Why sources are not posted to the worker. Probes on Node.js 24.15
  (`worker_threads`) showed:
  - In-memory Blobs clone to a worker.
  - A Blob from `fs.openAsBlob()` cannot be cloned at all. The
    serializer throws "File-backed Blobs are not cloneable" for
    `worker.postMessage`, a `MessagePort` (same thread or to a worker),
    `BroadcastChannel`, and `structuredClone()` alike, so no choice of
    channel avoids it.
  - Wrapping it (`new Blob([fileBlob])`) gets past the check, but
    reading the wrapper inside the worker aborted the Node.js process
    with a fatal V8 error (`Cannot create a handle without a
    HandleScope`).
  - A `FileHandle` can be transferred, but accepting one would put a
    Node-only source type in the API.

  Posting cloneable sources (browser `File`s, Node in-memory Blobs) to
  the worker to save round trips may come later as an optimization that
  guests cannot observe.
- A file that changes on disk after being offered becomes unreadable,
  and reads fail with EIO. The same probe showed Node.js reporting
  `NotReadableError` for a modified file-backed Blob. Browsers specify
  the same behavior for `File` snapshots; that has not been checked
  here.
- Lazy reads use the kernel's existing asynchronous completion and
  blocking-retry path on both hosts. There is no synchronous-read
  shortcut that only one host has. The cost of a round trip per cache
  miss has not been measured.

### Kernel and host boundary, and ABI

The kernel owns all exchange state: the namespace, IDs, ownership,
quotas, and freezing. The host owns the sources and leases. The
boundary consists of:

- kernel exports to stage and commit a batch, cancel one, set listener
  presence, push stream-input chunks and end-of-stream or errors, read
  stored outputs, drain streamed outputs, and release leases;
- host imports for range reads of input sources (completing
  asynchronously) and for notifications: batch committed, batch removed
  with outcome and status, status changed, consumer state changed,
  output published, output withdrawn, stream data available, stream
  ended with its `end` state;
- a host import to launch a process the kernel created, which reuses the
  `posix_spawn` preflight and worker launch. Activation uses it.

The xattr syscalls need `SYS_*` constants in `crates/shared/src/lib.rs`
and marshalling specs in `crates/shared/src/host_abi.rs`, which
regenerate `host/src/generated/abi.ts`. The existing argument kinds
cover them: a C-string path and name going in, a value of `size` bytes
going in for the set calls, and an output buffer of `size` bytes for the
get and list calls. That buffer may be null when `size` is 0.

**The xattr fix lands first, as its own commit.** It makes all twelve
calls honest on every existing filesystem before exchange exists:

- Path and descriptor errors come first, as on Linux: ENOENT, ENOTDIR,
  ELOOP, EACCES on search, EBADF.
- Then ENOTSUP for get, set, and remove, and an empty list for list.
- `docs/posix-status.md` is corrected.

No test in the tree depends on the current stubs. The commit carries its
own `ABI_VERSION` bump and snapshot, so it stays correct on its own when
the branch is rebase-merged. The exchange commits then add `user.*`
support on the exchange filesystem.

The exchange change requires its own `ABI_VERSION` bump and a
regenerated `abi/snapshot.json`. It adds:

- kernel exports and host imports;
- a mount every image's programs can observe;
- the agent path `/usr/libexec/kandelo/exchange-agent` and the agent
  contract (started as root, must drop privileges);
- `user.*` xattrs on the exchange filesystem;
- the `<kandelo/exchange.h>` header.

`docs/abi-versioning.md` records it.

## Guest software

### Where each part lives

| Layer | Owns | Ships as |
|---|---|---|
| Platform: kernel and host runtime | Delivery, IDs, ownership, quotas, freezing. It never interprets a file. | Kernel Wasm, `host/src`, `web-libs/kandelo-session` |
| Base userland | `kxchgd` installed at the agent path, the helpers, `<kandelo/exchange.h>`, and the vendor default rules, including the catch-all `99-save` | A `kandelo-exchange` package in the base rootfs; rules in `/usr/share/kandelo/exchange-handlers.d/` |
| Image and machine | `/etc/kandelo/exchange.conf` (which user runs handlers), machine-specific rules (doom, quake, scummvm), and rules added while the machine runs | Image build, then runtime edits; rules in `/etc/kandelo/exchange-handlers.d/` |

The catch-all handler is therefore base userland, not platform. A
machine that ships no rules, or replaces `kxchgd`, gets no behavior from
the platform beyond delivery.

### `kxchgd`, the agent

`kxchgd` is the consumer on images that want exchange. It holds
`events` open and processes batches one at a time in v1.

- **Handler rules** are one rule per file:

  ```
  # /etc/kandelo/exchange-handlers.d/50-doom-wad.handler
  match extension .wad
  kind file
  max-bytes 33554432
  run /usr/libexec/kandelo/doom-load-wad
  ```

  - `match extension <ext>` and `match mime <type>` lines are
    alternatives: an entry matches if any one of them matches.
  - `kind` is `file` (the default), `stream`, or `any`.
  - `max-bytes` applies to regular files.
- **Rule search path.** `kxchgd` is one agent per machine, so its
  configuration is machine-wide. Highest precedence first:
  1. `/etc/kandelo/exchange-handlers.d/`: the image's rules and rules
     added while the machine runs. They persist wherever the root
     filesystem does: for the session today, and across reloads once the
     OPFS image lands.
  2. `/usr/share/kandelo/exchange-handlers.d/`: vendor defaults from
     the `kandelo-exchange` package.

  The directories are merged by filename. A file in `/etc` replaces the
  same name in `/usr/share`, and an empty file masks it, so an empty
  `/etc/kandelo/exchange-handlers.d/99-save.handler` disables the
  catch-all. That is the systemd convention.

  A third, transient tier that is cleared at boot is left out of v1.
  Nothing clears `/run` at boot on a persistent root, and the
  transient-handler use case is the deferred claims feature.
- **Who may change rules.** A rule runs a command as the handler account
  (the `user` in `exchange.conf`) whenever a matching file arrives.
  Writing a rule therefore amounts to running code as that account, so
  write access is limited to root and that account. Membership in
  `exchange` is not enough, because it grants a different privilege:
  receiving inputs and publishing outputs.
  - `/usr/share/…` is root-only (vendor).
  - `/etc/kandelo/exchange-handlers.d/` is owned by the handler account
    (`maker:exchange` 0755 on the core images). The image build sets the
    owner from `exchange.conf`. `maker` can add rules without `sudo`.
  - `kxchgd` refuses to load a rule file that is not owned by root or
    the handler account, or that anyone else can write. It reports
    `ignored rule <name>: unsafe permissions` instead of running it.
- **Selection order:** the merged rules in lexical filename order. A
  batch goes to the first rule that matches **every** top-level entry.
- **Rules are re-read before each dispatch.** A rule installed at
  runtime takes effect on the next batch with no restart and no
  `inotify`. The directories hold a few small files, so re-reading them
  is cheap.
- **Dispatch:**
  - `kxchgd` opens a work session for the handler and runs `run` with
    the batch directory as `argv[1]`.
  - Environment: `KANDELO_EXCHANGE_BATCH` (the batch path),
    `KANDELO_EXCHANGE_BATCH_ID`, and `KANDELO_WORK` (the session path).
  - The working directory is the session and stdin is `/dev/null`.
    stdout and stderr are `kxchgd`'s own.
- **Outcome:**
  - Exit status 0: the status becomes `done`, unless the handler set its
    own status.
  - Nonzero exit or a signal: `failed: exit N` or `failed: signal N`.
  - No matching rule: `no handler: <name>`.
  - In every case `kxchgd` then removes the batch and closes the
    session, so unpublished work disappears.
- **Account.** Handlers run as the account named in
  `/etc/kandelo/exchange.conf` (`maker` on the core images), so they can
  touch that user's files and signal that user's programs. `kxchgd`
  switches to it before reading any rule (see "Activation").
  - **No dedicated handler user in v1.** A dedicated account would
    isolate a compromised handler from `maker`'s files. But `99-save`
    would then write files owned by another uid into `maker`'s
    `~/Downloads`, the doom handler could not signal `maker`'s launch
    wrapper, and `maker` would need `sudo` to add rules.
  - **Why this is acceptable.** Dropped files are the user's own, on the
    user's own machine, inside the browser sandbox, so isolating a
    handler from that same user protects little. `sudo` on the core
    images requires `maker`'s password (`%wheel ALL=(ALL:ALL) ALL`), so
    a compromised handler does not become root by default.
  - **When to revisit.** Persistent roots (the OPFS image), where a
    compromised handler could change files that survive reloads; images
    that keep credentials or secrets in the handler account's home;
    handlers that parse complex untrusted formats, such as the scummvm
    `.zip` extraction. An image that wants isolation can create its own
    account and name it in `exchange.conf` without any platform change.
- **Start-up.** `kxchgd` is started by activation, never at boot and
  never by a service manager. It does not care what its pid or its
  parent is, and it never daemonizes: it is already detached. Its
  identity as consumer comes from its open `events` descriptor, nothing
  else.
- **Idle exit.** It exits after 60 s with no batch in flight.

### Helpers and library

- **`kandelo-exchange run [--] CMD [ARGS...]`** opens a session, sets
  `KANDELO_WORK`, runs the command as its child, and exits with the
  child's status. The session descriptor is close-on-exec, so the helper
  holds the session, not the child.
- **`kandelo-exchange ack <id>`** removes a batch.
- **`kandelo-exchange handler list | add | remove | mask`** manages
  rules in `/etc/kandelo/exchange-handlers.d/`, as the handler account
  or root. `list` shows the merged result and which directory each rule
  came from. `add NAME --extension .x --run CMD` writes a rule file. A
  change takes effect on the next batch.
- **Replacing the agent.**
  - Persistently: replace the file at the agent path.
  - For a while: while no consumer holds `events`, any member of
    `exchange` that opens it becomes the consumer, and the kernel does
    not activate the agent while a consumer exists.
- **`kandelo-publish [--mime TYPE] [--from ID]... [--name NAME] FILE`**
  stages FILE in `$KANDELO_WORK`, copying it if it is elsewhere, sets
  its xattrs, publishes it, and prints the output ID.
- **`kandelo-publish --stream --name NAME [--mime TYPE] [--from ID]...
  -- CMD [ARGS...]`** publishes a FIFO and runs CMD with its stdout on
  it. It sets `user.kandelo.end` to `complete` only if CMD exits 0, and
  to `aborted exit N` (or `aborted signal N`) otherwise. There is no
  form that reads its own stdin: `producer | kandelo-publish` cannot
  tell a finished producer from a crashed one.
- **`kandelo-publish --complete PATH` and `--abort PATH REASON`** are the
  low-level forms, for programs that manage their own streams.
- **`<kandelo/exchange.h>`**, next to `<kandelo/clipboard.h>` in
  `libc/musl-overlay/include/kandelo/`, declares `kx_session_open()`,
  `kx_publish()`, and the xattr names.
- The `attr` package (`getfattr`, `setfattr`) is ported, so shell
  handlers can use xattrs through ordinary tools. Python's
  `os.getxattr` works once the syscalls exist.

### The catch-all handler, `99-save`

Vendor default, in `/usr/share/kandelo/exchange-handlers.d/99-save.handler`,
matching `kind any`:

- It copies each top-level entry into `~/Downloads/`, creating the
  directory if needed. Folders keep their structure, and names that
  collide get ` (2)`, ` (3)`, and so on.
- A FIFO entry is read to end-of-file into a regular file. Saving is a
  sink, not a pipeline step, so turning a stream into a file here is the
  intended result. If the stream fails, the file is removed and the
  batch fails.
- The status becomes `saved to ~/Downloads/<name>`, or `saved N items
  to ~/Downloads/`.
- Metadata is not carried over. `~/Downloads` is on the root
  filesystem, which has no xattr support (ENOTSUP), so `user.mime_type`
  and the IDs stay with the exchange copy. The composability checklist
  flags this as an identity loss. It is accepted because the root
  filesystem truthfully cannot hold the metadata.
- Running out of space surfaces as `failed: no space left on device`.

## Browser app

The app is a consumer of the host interface. It implements no exchange
behavior of its own.

- **Inputs.**
  - Dropping files or folders anywhere on a machine's terminal,
    framebuffer, KMS, or desktop surface offers them as one batch.
    Drops on the web pane belong to the page inside it.
  - A dock button opens a file picker, which also covers touch devices
    that have no drag and drop.
  - Both follow `exchange.consumer`:
    - `ready` or `idle`: drops and picks are accepted. From `idle`, the
      drop's toast says "Starting the file handler…" until the batch
      commits, or "Waiting for a file handler" when the state reports
      `activation: "off"`.
    - `starting`: the same, and a `lastFailure` is shown, for example
      "The file handler exited with status 78; retrying". A timeout is
      shown as a failure.
    - `unavailable`: the surface says "This machine doesn't accept
      files" and refuses the drop.
  - Folder drops are walked through `webkitGetAsEntry`, within the
    quotas.
  - Each batch gets a toast that shows its status text and final
    outcome, including "the handler exited before finishing".
- **Outputs.**
  - The app registers the single listener for the machine's lifetime. A
    tray lists each output with its name, size, type, and provenance
    ("from photo.jpg, notes.txt"), with Save and Dismiss.
  - Save uses `showSaveFilePicker()` where available (Chromium), which
    also streams. Otherwise stored outputs are saved through a Blob and
    `<a download>`, which holds the whole file in memory.
  - Streamed outputs where no save picker exists offer "Buffer and
    download" with the size so far. Streaming downloads served by the
    service worker are deferred until they are verified in each
    browser.
  - The tray holds each lease until Save finishes or the user dismisses
    the output, within the output quotas.

## Replacing `ingest`

Exchange supersedes `ingest` completely.

- **doom.**
  - The profile's `shellCommand` becomes a launch wrapper. The wrapper
    runs `fbdoom -iwad <wad>` as its child, choosing `/user.wad` when it
    exists and `/doom1.wad` otherwise.
  - On SIGHUP the wrapper sends its child SIGTERM, waits for it with
    `waitpid`, and starts it again.
  - The handler rule `50-doom-wad.handler` runs a script that copies the
    WAD to `/user.wad.tmp`, renames it over `/user.wad`, and signals the
    wrapper.
- **quake.** The same pattern, with `.pak` going to
  `/usr/share/quake/id1/pak0.pak`.
- **scummvm.** A handler for `.zip` extracts into
  `/usr/share/scummvm-games` directly. The wrapper's polling loop for
  `upload.zip` (in `images/vfs/scripts/build-source-rootfs-shell-image.ts`)
  is removed.
- **Code removed:** the `ingest` schema and its 512 MiB ceiling in
  `demo-config.ts`, `demo-ingest.ts`, the ingest UI in
  `Framebuffer.tsx`, the three profiles' `ingest` blocks, and the
  `ingest` section of `docs/browser-support.md`. A profile that still
  declares `ingest` fails validation with a message pointing to
  exchange. It is not silently ignored.
- **Presentation hints.** A profile may declare `exchange.label` (the
  dock button's text) and `exchange.accept` (an extension list used only
  to filter the file picker). They are hints for the UI; the guest
  remains the authority on what it accepts.
- **Tests.** `kandelo-doom-ingest.spec.ts` and the scummvm upload test
  are rewritten to drive exchange.

`dockActions` uses the same host-types-a-command mechanism. Moving them
to the wrapper pattern is outside v1.

## Ownership

| Object | Owner | Ends when |
|---|---|---|
| Batch and its entries | The consumer's open file description for `events` | Removed, consumer closes or exits, host cancels |
| Host source behind an entry | The platform, on behalf of the entry | The entry is gone **and** its last guest descriptor closes; a stream source is then cancelled |
| Work session and its files | The open file description for `work/clone` | Last close, including exit and SIGKILL |
| Published output | A host lease inside the listener's scope | The scope settles and its streams close, the listener is aborted, the guest unlinks it, or the kernel is destroyed |
| Host output listener | Its `AbortSignal` | Abort, or the kernel is destroyed |
| Pending batch (no consumer yet) | The host's offer | Commit, `signal` abort, or `consumerTimeoutMs` (then discarded) |
| Activated agent process | The kernel, with the synthetic init as its parent | Exit; the kernel reaps it at once |

Every transfer is a move (rename) or a lease handoff, so no object ever
has two owners. Quotas bound what a live owner can hold.
`exchange.stats()` makes the remainder visible.

## Prior art

- **Plan 9.** Control and data files side by side, the `clone` idiom
  (opening a file creates a per-connection directory), the plumber
  (rule-based routing to handlers, starting a handler when nobody is
  listening), and `upas/fs` (a mailbox presented as directories). This
  design keeps the filesystem-as-interface idea. It deliberately avoids
  per-process namespaces, ad hoc text grammars, and string errors.
- **Linux FunctionFS.** A mountable filesystem with an event file next
  to data files.
- **Maildir.** Write elsewhere, then rename into place.
- **Service worker `waitUntil` and structured concurrency** (Trio, Kotlin
  coroutines). Lifetimes tied to scopes.
- **Freedesktop Common Extended Attributes.** `user.mime_type` and
  `user.xdg.origin.url`.
- **RFC 9562.** UUID version 8 for custom layouts.

## What this rejects

- **A character device carrying file contents.** It would force every
  file through `read()` and a copy before ordinary tools could use it.
  Exchange keeps device-like behavior only in `events`.
- **An inbox and outbox convention on an ordinary mount.** There is no
  notification (inotify is ENOSYS), no batch boundary, no
  acknowledgement, no way to see whether a consumer exists, and a full
  copy of every input.
- **A `manifest.json` per batch.** The filesystem carries the same
  information.
- **Inode numbers as IDs.** That would tie file identity in the
  filesystem to provenance identity in exchange.
- **Default host sinks for outputs.** Each embedder chooses what an
  output becomes.
- **Redelivery.** Deferred until real uses show which semantics are
  needed. Adding it later must be opt-in, because it changes what
  closing `events` means.
- **Time-based expiry.** Timers are surprising policy. Ownership and
  quotas already bound every resource.
- **Release on garbage collection.** It is not deterministic.
  `FinalizationRegistry` may only drive a development-time warning.
- **Files owned by the process that created them.** Most files are
  created by short-lived processes such as `cp`, so they would vanish
  as soon as the creator exited.
- **`O_TMPFILE` staging.** It is Linux-only, not POSIX, and handles one
  file at a time.
- **The host stopping and restarting guest programs.** Process control
  belongs to the guest.
- **Starting the agent at boot or from a service manager.** Each image
  would have to declare and supervise it, idle machines would pay for a
  running process, and the result would depend on each machine's init
  shape.
- **Host-owned activation.** The kernel already owns the consumer state
  and the pending batches, so it owns the decision. The host only
  launches.
- **A credentials declaration for the agent.** Either the kernel would
  parse image files or the host would hold policy. Instead the agent
  drops privileges using the image's own configuration.

## How it gets proven

- **Kernel unit tests** (`crates/runtime-core`):
  - every row of the error table;
  - ID layout, ordering, and validation;
  - xattr syscall semantics, and ENOTSUP on other filesystems;
  - batch visibility being atomic;
  - consumer close discarding batches;
  - session close (including the owner being killed) removing staged
    files;
  - unlinked-but-open behavior for inputs and outputs;
  - freezing and the EBUSY publish rule;
  - stream completion and abort states;
  - quotas and `statfs`.
- **Host tests, run against both hosts:**
  - offer, settle, and release outcomes;
  - lease scoping: an ignored output is released, one held across an
    `await` survives, and aborting releases everything;
  - stream inputs with backpressure, cancellation, and host errors
    surfacing as EIO;
  - streamed outputs that complete, abort, or end with neither;
  - `stats()` returning to zero after kills, aborts, and kernel
    destruction.
- **Guest integration tests on Node.js:**
  - `kxchgd` dispatch and each outcome status;
  - rule precedence and masking across the three directories;
  - a rule added at runtime taking effect on the next batch;
  - `99-save`;
  - `kandelo-exchange run`, and every `kandelo-publish` form, including
    a producer that crashes mid-stream.
- **Activation, on both hosts:**
  - `exchange.activation: "off"` reports `activation: "off"`, never
    activates, and commits pending batches when a test consumer opens
    `events`;
  - an offer to an `idle` machine activates the agent and commits when it
    opens `events`;
  - an offer during boot works under every init shape (`{ target }`,
    `{ program }`, `shellCommand`, login session);
  - no agent file gives `unavailable`, and an agent that is not
    executable gives an activation failure with its errno;
  - a crashing agent backs off, reports `lastFailure`, and recovers;
  - idle exit, then reactivation by the next offer;
  - a batch committed while the agent exits returns to pending and is
    handled by the next activation;
  - the agent is reaped and leaves no zombie;
  - handlers never run as root; a missing `exchange.conf` exits with 78;
    `setuid(0)` fails after the drop;
- **Conformance:** run the libc and POSIX suites with any xattr tests
  they contain. Check that shipped software which used to "succeed"
  against the fake set calls (copy, archive, and package tools) now
  behaves correctly with ENOTSUP.
- **Browser tests** in Chromium, Firefox, and WebKit: drops on each
  surface, a folder drop, the picker, the refusal with no consumer, the
  toasts, output Save and Dismiss, and the migrated doom, quake, and
  scummvm flows.
- **Manual check** with `./run.sh browser` for the user-visible flows.
- **ABI:** the version bump and a regenerated snapshot.
- **Performance:** not claimed. Lazy input reads are a new read path.
  If the plan touches the syscall hot path, it follows
  `docs/agent-guidance/performance.md`.

## Documentation

- `docs/architecture.md`: an "Exchange filesystem" section beside
  "Host clipboard".
- `docs/posix-status.md`: the xattr rows (implemented on exchange,
  ENOTSUP elsewhere), an exchange filesystem row, and the FIFO xattr
  difference from Linux.
- `docs/abi-versioning.md`: the new ABI version.
- `docs/browser-support.md`: replace the `ingest` section with
  exchange, including the profile hints and a pointer to this spec.
- `docs/sdk-guide.md` or `docs/porting-guide.md`: `<kandelo/exchange.h>`,
  the helpers, and handler rules, for software authors.
- `docs/future-improvements.md`: the deferred items below.

## Out of scope for v1

- Transient claims (a running program receiving drops for as long as
  it holds a connection to `kxchgd`). They belong with Wayland drag and
  drop, where "the window under the pointer" is the real use.
- Wayland drag and drop in `wlcompositor`, which will consume exchange,
  in its own spec.
- Streamed downloads served by the service worker, pending per-browser
  verification.
- Redelivery, and more than one consumer.
- Pasting files and the PWA share target as input gestures.
- Publishing directories.
- Moving an input into a session without copying it.
- Moving `dockActions` to launch wrappers.
- Guest `mount(2)`.
- Reparenting orphans to init, which is tracked separately. Activation
  needs only the part where init reaps its own children (see
  "Activation").

## Delivery order

The branch is rebase-merged, so each commit must stand on its own:

1. **xattr honesty.** ENOTSUP on every existing filesystem, correct
   errno ordering, constants and marshalling, docs, and its own ABI
   bump.
2. **Exchange filesystem and IDs in the kernel.** With the exchange
   ABI bump.
3. **Host interface on both hosts**, including readiness and the
   source range protocol.
4. **Kernel activation:** the agent path, pending batches, backoff,
   reaping of init's children (unless the orphan change landed first),
   and the host launch import.
5. **Guest userland:** `kxchgd`, the helpers, the header, the `attr`
   port, the vendor rules, and the base-rootfs group.
6. **Browser app:** gestures, readiness states, toasts, and the output
   tray.
7. **Replacing `ingest`:** wrappers, handler rules, the migrated tests,
   and removal of the old code and docs.

## Open questions for the plan

1. The exact credential syscalls Kandelo implements for the privilege
   drop (`initgroups`, `setresuid`, or the `setuid`/`setgid` pair), and
   whether `setuid(0)` after the drop really fails. That is the check
   `kxchgd` relies on.
2. Where `exchange.activation` sits among the existing `KernelHost`
   options on both hosts.

## Decisions (2026-10-21, maintainer)

- A filesystem, not a device and not a directory convention. Only
  `events` behaves like a device.
- Metadata goes in stat fields and xattrs; there is no manifest file.
  MIME type uses `user.mime_type`, and entry order uses
  `user.kandelo.index`.
- Inputs are regular files for random-access sources and FIFOs for
  streams. Hosts can offer streams programmatically, independent of
  drag and drop.
- Outputs are independent of inputs and can be linked to any number of
  them through `user.kandelo.derived_from`.
- Outputs come in two kinds, stored and streamed. Stored outputs are
  published by rename and frozen. Streamed outputs end explicitly
  through `user.kandelo.end`.
- Hosts consume outputs through a platform event and lease. There is no
  default sink on any host.
- Leases are scoped: to the listener's returned promise and its open
  streams, inside the listener's `AbortSignal`.
- Work sessions are tied to an open file description and hidden behind
  helpers.
- Move-only rules hold between `inbox/`, `work/`, and `outbox/`.
- ENXIO is returned only for publishing without a listener. The other
  conditions use their POSIX errnos.
- A single consumer, no redelivery, and host-configured quotas.
- IDs are kernel-issued UUIDv8 that can be validated without storage.
  Batch directories are named by their ID.
- The mount is universal, in a reserved `exchange` group with `maker`
  as a member in the core images.
- Handlers run as the account in `/etc/kandelo/exchange.conf` (`maker`
  on the core images), not a dedicated account, because handlers must
  be able to touch that user's files and signal that user's programs
  (for example, the doom wrapper).
- Exchange supersedes `ingest` entirely.
- The `exchange` group is GID 120, and `f_type` is `0x4B584348`
  ("KXCH").
- Symbolic links are allowed inside work sessions, but they never appear
  in inputs and cannot be published.
- Input bytes reach the kernel worker by range requests to the host side
  that owns the source, the same way on both hosts.
- The kernel activates the agent on demand, the host only launches it,
  and nothing depends on a service manager, an image declaration, or
  pid 1. The agent path `/usr/libexec/kandelo/exchange-agent` is the
  contract.
- The agent starts as root and drops its own privileges, to the user in
  `/etc/kandelo/exchange.conf`. There is no dedicated handler user in
  v1; core images use `maker`. The spec lists when to revisit that.
- `exchange.activation` (`"on-demand"` or `"off"`) is embedder-only
  configuration, reported in the consumer state.
- Readiness states are `unavailable`, `idle`, `starting`, and `ready`,
  all reported by the kernel. `offer()` waits as a pending batch, with a
  timeout. The output listener can register at any time.
- Handling is base userland, not platform. Rules merge from the vendor
  directory (`/usr/share`) and the machine directory (`/etc`, owned by
  the handler account). Rules added at runtime apply to the next batch.
  Only root and the handler account may write rules, because a rule
  runs code as that account.
- Core images ship the catch-all `99-save` rule, which saves to
  `~/Downloads/`.
- The xattr stubs are fixed in this change, as its first standalone
  commit.
- The quota defaults in "Quotas and `statfs`" are agreed.
- Transient claims are deferred to the Wayland drag-and-drop spec.
- The `/dev/fb0` release-on-exit defect is fixed separately.
