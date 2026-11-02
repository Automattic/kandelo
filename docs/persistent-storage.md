# Persistent storage overview

This is the short version. It explains how a saved computer is stored and where
to read more. It describes the current source candidate, which is experimental:
browser storage is not a backup, so do not keep irreplaceable data only here.

## The two pieces of a saved computer

A saved computer is two things on disk, in the browser's Origin Private File
System (OPFS), a private per-site file area.

- **The base image** is a read-only filesystem image. It holds the software the
  computer started with. It is never changed in place.
- **The journal** is an append-only log of every change since. Writes, new
  files, deletions and permission changes all land here.

The running filesystem is the base with the journal replayed on top, so a saved
computer needs no save step and survives a tab closing. Base image blocks are
read and verified on demand, which is why a large computer opens quickly.
Package files may also be *lazy*: the image records their size and content hash,
and the bytes are downloaded the first time they are read.

```text
   guest programs
         │  POSIX system calls
         ▼
   Rust kernel  ── filesystem, journal, checks, recovery, package transactions
         │  bounded read/write/flush requests
         ▼
   host adapter ── OPFS on the browser, files on Node
         ▼
   base image + journal + index + control records
```

## Who owns what

Rust owns the filesystem and every decision about it: journal transactions,
checkpoint indexes, integrity checks, which saved state is current, and package
upgrades. The host moves bytes and manages files, locks and workers. It cannot
decide that a damaged or older state is good enough. Both hosts run the same
Rust code, so Node and the browser behave alike.

TypeScript does own the browser computer around that: the library of saved
computers, image manifests, leases that stop two tabs opening one computer, and
the user interface.

## Keeping the journal manageable

A journal only grows, so the system periodically *compacts* it into a new
journal with an index, leaving the old one in place until the new one is proven
and activated. A *checkpoint* goes further and writes a new base image. Neither
is required to save anything, and both are built separately so that a failure
leaves the computer as it was.

## What happens after a crash

Every acknowledged change is either fully in the journal or not there at all.
On reopen, Rust replays complete transactions and ignores a torn tail. Damage is
refused instead of repaired: the system will not quietly select an older state
as if it were current. Only a successful `fsync` or sync promises durability.

## What is checked, and when

Base image blocks are checked when read, so damage to a block nobody reads can
go unnoticed. Nothing here is a backup or a repair copy. Lazy files are checked
against their hash when downloaded, and a missing download is a clear read
error, never a substitute from another release.

## Reading and running are separate

Saved data stays readable even when its programs cannot run, because a computer
stores files, not running processes or a runtime. If the installed software was
built for a different program contract, the computer opens with programs
stopped until a compatible software set is applied.

## Updating software

Updates are transactions in the journal: guests stop, the new set is staged,
and the switch happens all at once, with one rollback available. User files are
never touched, and database migrations stay separate.

## Where to read more

| Question | Document |
| --- | --- |
| Exactly what is promised about durability, recovery and capacity? | [Durability contract](persistence-durability.md) |
| How do updates and rollback work, and what do they not do? | [Package upgrades](package-upgrades.md) |
| Which versions exist, and what makes a program compatible? | [Persistent program compatibility](persistent-program-compatibility.md) |
| How do I use saved computers in the browser? | [Browser support](browser-support.md#computer-library-and-retention) |
| Which storage behavior has coverage, and what does it prove? | [Durability acceptance map](persistence-durability.md#release-acceptance-map) |
