# `browser-mount-layering.test.ts` was retired on 2026-09-17

It mirrored `browser-kernel-worker-entry.ts`'s mount construction and asserted
how the browser host LAYERED its mounts. The browser host mounts nothing now:
`/` is the kernel's, the eight prefixes the in-kernel tmpfs owns are filtered
out of the spec, and a scratch mount at any other path is refused rather than
backed, because the browser has no filesystem of its own.

Its five claims, and where each went:

| claim | disposition |
|---|---|
| produces exactly the spec's mounts and nothing under `/dev` | `vfs/default-mounts.test.ts` asserts the stronger thing: the canonical spec resolves to NO mounts at all |
| leaves the whole of `/dev` to the kernel | the kernel's, and asserted there — `tmpfs.rs`'s `dev_shm_is_a_scratch_mount_and_behaves_like_one` pins that `/dev/shm` is tmpfs's and the rest of `/dev` is not |
| rootfs files reach the image backend through the router | there is no image backend; the kernel serves `/` |
| scratch mount roundtrips a write that does not appear under `/` | a host-backed browser scratch mount, which no longer exists |
| keeps a uid/gid profile writable and separate from `/opt/admin` | the same shape as the maker-home claim, which was PORTED to `tmpfs.rs` as `the_canonical_maker_home_is_writable_and_owned_by_the_maker`; `/opt/admin` is a non-tmpfs path the browser cannot back |

**Found late, and that is the point of recording it here.** The commit that
removed the browser's scratch backend ran `test/vfs/default-mounts.test.ts`
and not the rest of `test/vfs/`, so this file was left red for two commits. A
directory is the unit to re-run when a module under it changes, not the one
file whose name matches the change.
