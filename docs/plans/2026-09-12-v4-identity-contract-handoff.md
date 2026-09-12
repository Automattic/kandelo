# V4 identity contract — handoff from lane Y

**Date: 2026-09-12. Owner: LANE V** (maintainer decision). Lane Y is blocked on
this and supplies the tests. Written so lane V does not have to re-derive what
lane Y measured while hitting it.

## The defect, in one sentence

`rootfs::export_image_read` turns every deferred file into a zero-length
regular file with no record of where its bytes were, so an image exported
through it builds, mounts, boots — and is empty where it should be lazy.

## Exactly where

Two arms of `build_export_image` in `crates/runtime-core/src/rootfs.rs`:

| line | arm | what it does now |
|---|---|---|
| ~3562 | `BaseSource::Host => ExportNode::LazyStub` | a base file whose bytes live in a host blob |
| ~3569 | `InodeKind::LazyMember { .. } => ExportNode::LazyStub` | a file registered against a lazy archive |

Both resolve to `ExportNode::LazyStub`, which writes
`create_file(parent, name, mode, Content::Bytes(b""))` — an empty file.

Deferred records are emitted only for entries created through
`SffsWriter::create_deferred_file` (`crates/runtime-core/src/sffs_write.rs`,
~line 1058), which the export never calls. So `emit_deferred_section` finds
nothing and the image declares **no SDEF section at all**.

## Why it is not derived-build-only

Lane Y first concluded this only affected derived builds and was wrong. Fresh
builds REGISTER lazy files — the shipped shell image carries **7,546 deferred
entries** against 79 URL-backed single files — so the export cannot publish any
production image.

## The shape of the fix

`create_deferred_file(parent, name, mode, size, payload)` already exists and
already pushes the record `emit_deferred_section` writes. The mechanical part
is calling it from those two arms instead of stubbing.

**The design decision is the payload**, and it is genuinely lane V's:
`sffs_deferred` treats the payload as opaque — "the kernel is a courier" — so
V4 must define what identity is encoded there and agree it with whoever
fetches. For a lazy member that is at least `archive_id` and `source_path`; for
a host-backed base file it is whatever the fetcher needs to locate the blob.

**Do not materialize base content into the export.** Preserving laziness is the
point: `lamp.vfs` is 249 MiB precisely because its content is not resident.

## How to know it is done

Two mutation trials are held on `brandonpayton/lane-y-image-writer` at
`perturb/deferred-until-v4.json`, deliberately outside that lane's green
contract:

* *export reports a negative errno as a byte count*
* *export silently invents base bytes*

Neither can be killed today, because the export never consults its byte source.
**Both become killable the moment the identity contract makes that source
reachable.** Move them into `perturb/sffs-module-abi.json` when V4 lands; a
green run there is the definition of done.

Two tests in `crates/sffs-module/src/lib.rs` currently assert THE DAMAGE and
must be inverted by the same change:

* `exporting_a_base_file_silently_empties_it_todo_derived_builds`
* `a_registered_lazy_file_is_lost_by_the_export_todo_builder_serialization`

They assert `st.size == 0` and `deferred_section().is_none()`. When V4 lands,
they should assert the real size rides in the deferred record and the body
inode is a zero-length stub — which is the SDEF contract, and is what lane Y's
`a_registered_lazy_file_exports_as_deferred_with_its_real_size` was originally
written to check before the damage was discovered.

## What lane Y could not settle

* **Whether the payload encoding should be shared with the KLZY section's**
  producer format or defined fresh for SDEF. V5 is moving that metadata
  in-body; writing the contract against a format mid-change is the risk.
* **Whether `BaseSource::Image` needs different treatment from
  `BaseSource::Host`.** Lane Y only exercised the host-backed path.
