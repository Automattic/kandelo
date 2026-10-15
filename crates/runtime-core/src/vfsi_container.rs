//! Writer for the VFS image *container* — the envelope around the KIFS body.
//!
//! # Why this exists
//!
//! `kandelo_image_fs.rs` reads this container and `kandelo_image_write.rs`
//! builds the body inside it; this module WRITES the envelope. Without it the
//! Rust side could not emit a production image however complete its body
//! writer was: a `.vfs.zst` is not an KIFS body, it is this container holding
//! one.
//!
//! # Layout
//!
//! ```text
//! header(16 for v1, 24 for v2) | body | u32 lazyLen | lazyJson
//!                   | u32 archiveLen | archiveJson   (flag 1<<1)
//!                   | u32 metadataLen | metadataJson (flag 1<<2)
//!                   | u32 klzyLen | KLZY             (flag 1<<4)
//! ```
//!
//! The lazy-JSON section is unconditional; the rest are flagged. That is not a
//! choice this module makes, it is what `kernel_lazy_span` walks and what
//! every image written by the original TypeScript writer (since deleted)
//! contains, and the two must agree byte for byte or a reader lands on the
//! wrong offset.
//!
//! # Why the KLZY section is REQUIRED rather than optional
//!
//! This is the module's one opinionated decision, and it encodes a defect that
//! would otherwise be easy to ship.
//!
//! `rootfs::load_image_inner` refuses an image that declares no KLZY section:
//! it cannot tell "this image has no lazy files" from "this image records its
//! lazy files only in host-side JSON I cannot read", and accepting it "would
//! silently build a tree where every deferred file reports size 0 — a wrong
//! tree that looks like a right one". An image with genuinely no lazy files
//! still carries the section, empty, in 20 bytes.
//!
//! That reason still holds, and it is why `kernel_lazy` was once a plain slice
//! rather than an `Option`: a caller could not forget it, and the unbootable
//! image was not a state this API could express.
//!
//! **It is an `Option` now, because the statement it was protecting changed.**
//! `rootfs::load_image_inner` reads the body's SDEF section as a linkage source
//! when an image declares no KLZY, so "declares no KLZY" and "describes its
//! deferred files nowhere" stopped being the same thing. An image whose body
//! carries SDEF needs no KLZY, and every image the Rust exporter writes is
//! such an image.
//!
//! What this API still cannot check is the combination that IS unbootable:
//! `None` with a body carrying no SDEF. This writer never looks inside the
//! body, so the loader is the only layer that can refuse it — and does.
//!
//! # Streaming
//!
//! [`header`] and [`trailer`] are separate because the body is streamed. The
//! writer never materializes file content (`lamp.vfs` is 249 MiB), so a caller
//! emits the header, streams the body through `KandeloImage::read_at`, then
//! emits the trailer. [`wrap`] is the convenience for callers small enough to
//! hold the whole image, and is what the tests use.

use alloc::vec::Vec;
use wasm_posix_shared::Errno;

use crate::kandelo_image_fs::{
    VFSI_CONTAINER_MAGIC, VFSI_CONTAINER_VERSION, VFSI_EXTENDED_CONTAINER_VERSION,
    VFSI_EXTENDED_HEADER_SIZE, VFSI_HEADER_SIZE, VFS_IMAGE_FLAG_HAS_LAZY,
    VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES, VFS_IMAGE_FLAG_HAS_METADATA,
    VFS_IMAGE_FLAG_HAS_TYPED_LAZY_ARCHIVES,
};

/// The trailer sections, in the order the container stores them.
pub struct ContainerSections<'a> {
    /// Host-side lazy-file JSON. Always written, empty when there is none.
    pub lazy_json: &'a [u8],
    /// Host-side lazy-archive JSON.
    pub archive_json: Option<&'a [u8]>,
    /// Image metadata JSON (`version`, `kernelAbi`, `createdBy`).
    pub metadata_json: Option<&'a [u8]>,
    /// The kernel-facing lazy linkage, or `None` when the BODY describes the
    /// image's deferred files instead (an `SDEF` section, [`crate::sdef`]).
    ///
    /// This was once required, because the loader refused any image declaring
    /// no `KLZY` — an image with no description of its deferred files loads as
    /// a tree where every one of them reports size 0, which is a wrong tree
    /// that looks like a right one. That reason still holds; what changed is
    /// that `SDEF` is now also a description, so "declares no `KLZY`" and
    /// "describes nothing" stopped being the same statement.
    ///
    /// `None` with a body that carries no `SDEF` produces an image the loader
    /// refuses, which is the correct outcome and not something this writer can
    /// check: it never sees inside the body.
    pub kernel_lazy: Option<&'a [u8]>,
}

impl ContainerSections<'_> {
    /// The flag word these sections imply.
    ///
    /// `HAS_TYPED_LAZY_ARCHIVES` tracks `HAS_LAZY_ARCHIVES` exactly, because
    /// that is what the original TypeScript writer did: it set both from the
    /// same `hasArchives` condition. Deriving it from a separate notion here
    /// would produce a flag word no existing image has.
    pub fn flags(&self) -> u32 {
        let mut flags = 0;
        if self.kernel_lazy.is_some() {
            flags |= wasm_posix_shared::abi::VFS_IMAGE_FLAG_HAS_KERNEL_LAZY;
        }
        if !self.lazy_json.is_empty() {
            flags |= VFS_IMAGE_FLAG_HAS_LAZY;
        }
        if self.archive_json.is_some() {
            flags |= VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES | VFS_IMAGE_FLAG_HAS_TYPED_LAZY_ARCHIVES;
        }
        if self.metadata_json.is_some() {
            flags |= VFS_IMAGE_FLAG_HAS_METADATA;
        }
        flags
    }
}

/// Every section length is a `u32`, so a section that does not fit is a real
/// limit rather than an overflow to wrap silently. Named so a
/// caller can refuse an oversized section at the point it is handed one, rather
/// than at the point the container is written.
pub const MAX_SECTION_LEN: u32 = u32::MAX;

/// Version 1 body and all section lengths are `u32`, never wrapped silently.
fn len_u32(len: usize, _what: &'static str) -> Result<u32, Errno> {
    u32::try_from(len).map_err(|_| Errno::EINVAL)
}

/// The 16-byte version 1 container header.
pub fn header(body_len: usize, flags: u32) -> Result<[u8; VFSI_HEADER_SIZE], Errno> {
    let body_len = len_u32(body_len, "body")?;
    let mut out = [0u8; VFSI_HEADER_SIZE];
    out[0..4].copy_from_slice(&VFSI_CONTAINER_MAGIC.to_le_bytes());
    out[4..8].copy_from_slice(&VFSI_CONTAINER_VERSION.to_le_bytes());
    out[8..12].copy_from_slice(&flags.to_le_bytes());
    out[12..16].copy_from_slice(&body_len.to_le_bytes());
    Ok(out)
}

pub fn header_for_body(body_len: u64, flags: u32) -> Result<Vec<u8>, Errno> {
    if body_len <= u32::MAX as u64 {
        return Ok(header(body_len as usize, flags)?.to_vec());
    }
    let mut out = alloc::vec![0u8; VFSI_EXTENDED_HEADER_SIZE];
    out[0..4].copy_from_slice(&VFSI_CONTAINER_MAGIC.to_le_bytes());
    out[4..8].copy_from_slice(&VFSI_EXTENDED_CONTAINER_VERSION.to_le_bytes());
    out[8..12].copy_from_slice(&flags.to_le_bytes());
    out[12..16].copy_from_slice(&(VFSI_EXTENDED_HEADER_SIZE as u32).to_le_bytes());
    out[16..24].copy_from_slice(&body_len.to_le_bytes());
    Ok(out)
}

/// Every section after the body, in container order.
pub fn trailer(sections: &ContainerSections<'_>) -> Result<Vec<u8>, Errno> {
    let mut out = Vec::new();
    let mut push = |bytes: &[u8], what: &'static str| -> Result<(), Errno> {
        out.extend_from_slice(&len_u32(bytes.len(), what)?.to_le_bytes());
        out.extend_from_slice(bytes);
        Ok(())
    };
    push(sections.lazy_json, "lazy json")?;
    if let Some(archive) = sections.archive_json {
        push(archive, "archive json")?;
    }
    if let Some(metadata) = sections.metadata_json {
        push(metadata, "metadata json")?;
    }
    if let Some(kernel_lazy) = sections.kernel_lazy {
        push(kernel_lazy, "kernel lazy")?;
    }
    Ok(out)
}

/// Whole container, for callers that can hold the image.
pub fn wrap(body: &[u8], sections: &ContainerSections<'_>) -> Result<Vec<u8>, Errno> {
    let head = header_for_body(body.len() as u64, sections.flags())?;
    let tail = trailer(sections)?;
    let mut out = Vec::new();
    out.try_reserve(head.len() + body.len() + tail.len())
        .map_err(|_| Errno::ENOMEM)?;
    out.extend_from_slice(&head);
    out.extend_from_slice(body);
    out.extend_from_slice(&tail);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kandelo_image_fs::{self, BlockSource};

    struct SparseContainer {
        head: Vec<u8>,
        tail: Vec<u8>,
        body_len: u64,
    }

    impl BlockSource for SparseContainer {
        fn len(&self) -> u64 {
            self.head.len() as u64 + self.body_len + self.tail.len() as u64
        }

        fn read_exact_at(&self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
            if offset.checked_add(dst.len() as u64).is_none_or(|end| end > self.len()) {
                return Err(Errno::EIO);
            }
            let tail_start = self.head.len() as u64 + self.body_len;
            for (index, byte) in dst.iter_mut().enumerate() {
                let position = offset + index as u64;
                *byte = if position < self.head.len() as u64 {
                    self.head[position as usize]
                } else if position >= tail_start {
                    self.tail[(position - tail_start) as usize]
                } else {
                    0
                };
            }
            Ok(())
        }
    }

    const BODY: &[u8] = b"not a real image body, but the container does not care";

    fn sections<'a>(
        lazy: &'a [u8],
        archive: Option<&'a [u8]>,
        metadata: Option<&'a [u8]>,
        klzy: Option<&'a [u8]>,
    ) -> ContainerSections<'a> {
        ContainerSections {
            lazy_json: lazy,
            archive_json: archive,
            metadata_json: metadata,
            kernel_lazy: klzy,
        }
    }

    /// The readers are the specification. A container this module writes must
    /// be one `image.rs` walks to the same bytes -- that is the whole contract,
    /// and asserting it against our own parser would prove nothing.
    #[test]
    fn every_section_combination_round_trips_through_the_readers() {
        let klzy: &[u8] = b"KLZY-payload";
        for (lazy, archive, metadata) in [
            (&b""[..], None, None),
            (&b"{\"lazy\":1}"[..], None, None),
            (&b"{\"lazy\":1}"[..], Some(&b"[archive]"[..]), None),
            (&b""[..], None, Some(&b"{\"kernelAbi\":44}"[..])),
            (
                &b"{\"lazy\":1}"[..],
                Some(&b"[archive]"[..]),
                Some(&b"{\"kernelAbi\":44}"[..]),
            ),
        ] {
            let s = sections(lazy, archive, metadata, Some(klzy));
            let image = wrap(BODY, &s).expect("wrap");
            let (offset, len) = kandelo_image_fs::kandelo_image_span(&image.as_slice()).expect("span");
            assert_eq!(
                &image[offset as usize..(offset + len) as usize],
                BODY,
                "body span must address the body"
            );
            assert_eq!(
                kandelo_image_fs::kernel_lazy_section(&image).expect("klzy"),
                Some(klzy),
                "the KLZY walk must land on the section for lazy={lazy:?} archive={archive:?} metadata={metadata:?}",
            );
        }
    }

    /// The flag word is what makes the trailer walkable; a wrong bit sends the
    /// reader to the wrong offset. Checked against the values observed in the
    /// shipped corpus: 20 for an image with metadata and KLZY only, 31 for one
    /// with every section.
    #[test]
    fn flag_word_matches_the_shipped_corpus() {
        let bare = sections(b"", None, Some(b"{}"), Some(b"k"));
        assert_eq!(bare.flags(), 20, "metadata + kernel lazy");

        let full = sections(b"{\"lazy\":1}", Some(b"[a]"), Some(b"{}"), Some(b"k"));
        assert_eq!(full.flags(), 31, "every section");
    }

    /// Section ORDER has no reader to protect it, so it is pinned by bytes.
    ///
    /// This test replaces one that asserted the reader would catch a
    /// misordered trailer. **It would not, and finding that out is the
    /// useful part.** `kernel_lazy_span` walks the trailer by length prefix:
    /// it skips the lazy section, then archive and metadata if their flags are
    /// set, then reads KLZY. Swapping two sections that are both present and
    /// both skipped leaves the KLZY offset identical, so the kernel reaches
    /// the right section over a trailer whose other two are transposed.
    ///
    /// Nothing in Rust would notice; the damage lands on whoever parses the
    /// lazy and metadata JSON, which is the host. A golden-byte assertion is
    /// therefore the only thing standing between this writer and a silently
    /// transposed trailer.
    #[test]
    fn trailer_writes_sections_in_container_order() {
        let s = sections(b"LAZY", Some(b"ARCH"), Some(b"META"), Some(b"KLZY"));
        let mut expected = Vec::new();
        for part in [&b"LAZY"[..], &b"ARCH"[..], &b"META"[..], &b"KLZY"[..]] {
            expected.extend_from_slice(&(part.len() as u32).to_le_bytes());
            expected.extend_from_slice(part);
        }
        assert_eq!(
            trailer(&s).expect("trailer"),
            expected,
            "sections must be written lazy, archive, metadata, kernel-lazy",
        );
    }

    #[test]
    fn a_container_carries_no_bytes_its_flags_do_not_account_for() {
        // Every section in the trailer is claimed by a flag (or, for the lazy
        // JSON, unconditional). A section written without a flag to claim it is
        // trailing slack: the reader walks by length prefix from the body and
        // stops when the flags say to, so those bytes are unreachable and an
        // image has two byte representations for one content.
        //
        // Found by mutation: making the trailer write an empty kernel-lazy
        // section when there is none changed no test, because nothing looked at
        // the container's total length.
        let body: &[u8] = BODY;
        for (lazy, archive, metadata, klzy) in [
            (&b""[..], None, None, None),
            (&b""[..], None, None, Some(&b"KLZY"[..])),
            (&b"{\"lazy\":1}"[..], Some(&b"[a]"[..]), Some(&b"{}"[..]), None),
            (
                &b"{\"lazy\":1}"[..],
                Some(&b"[a]"[..]),
                Some(&b"{}"[..]),
                Some(&b"KLZY"[..]),
            ),
        ] {
            let s = sections(lazy, archive, metadata, klzy);
            let image = wrap(body, &s).expect("wrap");

            // What the flags account for, counted independently of `trailer`.
            let mut accounted = VFSI_HEADER_SIZE + body.len();
            accounted += 4 + lazy.len();
            if let Some(archive) = archive {
                accounted += 4 + archive.len();
            }
            if let Some(metadata) = metadata {
                accounted += 4 + metadata.len();
            }
            if let Some(klzy) = klzy {
                accounted += 4 + klzy.len();
            }
            assert_eq!(
                image.len(),
                accounted,
                "flags {:#x} account for every byte",
                s.flags(),
            );
        }
    }

    /// The blindness above, asserted rather than left as prose, so that a
    /// future reader change which DOES start checking order is noticed here
    /// instead of silently making the golden test the only survivor.
    #[test]
    fn the_kernel_walk_cannot_detect_a_transposed_trailer() {
        let klzy: &[u8] = b"KLZY-payload";
        let s = sections(b"{\"lazy\":1}", None, Some(b"{\"kernelAbi\":44}"), Some(klzy));

        let mut transposed = Vec::new();
        for part in [&b"{\"kernelAbi\":44}"[..], &b"{\"lazy\":1}"[..], klzy] {
            transposed.extend_from_slice(&(part.len() as u32).to_le_bytes());
            transposed.extend_from_slice(part);
        }
        let mut image = header(BODY.len(), s.flags()).expect("header").to_vec();
        image.extend_from_slice(BODY);
        image.extend_from_slice(&transposed);

        assert_eq!(
            kandelo_image_fs::kernel_lazy_section(&image).expect("walk"),
            Some(klzy),
            "documented blindness: the walk skips by length, so a transposed \
             lazy/metadata pair still leaves KLZY where it expects it",
        );
    }

    /// The length fields are `u32`; a body that does not fit is a real limit.
    #[test]
    fn an_oversized_length_is_refused_rather_than_wrapped() {
        assert_eq!(header(u32::MAX as usize + 1, 0), Err(Errno::EINVAL));
    }

    #[test]
    fn extended_header_addresses_a_large_body_and_its_sections() {
        let body_len = u32::MAX as u64 + 4097;
        let sections = sections(b"lazy", Some(b"archive"), Some(b"metadata"), Some(b"KLZY"));
        let head = header_for_body(body_len, sections.flags()).expect("header");
        assert_eq!(head.len(), VFSI_EXTENDED_HEADER_SIZE);
        assert_eq!(u32::from_le_bytes(head[4..8].try_into().unwrap()), VFSI_EXTENDED_CONTAINER_VERSION);
        let source = SparseContainer {
            head,
            tail: trailer(&sections).expect("trailer"),
            body_len,
        };
        assert_eq!(kandelo_image_fs::kandelo_image_span(&source), Ok((24, body_len)));
        assert_eq!(kandelo_image_fs::container_flags(&source), Ok(sections.flags()));
        for (span, expected) in [
            (kandelo_image_fs::metadata_span(&source).expect("metadata"), &b"metadata"[..]),
            (kandelo_image_fs::kernel_lazy_span(&source).expect("kernel lazy"), &b"KLZY"[..]),
        ] {
            let (offset, len) = span.expect("section span");
            let mut bytes = alloc::vec![0; len as usize];
            source.read_exact_at(offset, &mut bytes).expect("section bytes");
            assert_eq!(bytes, expected);
        }
    }

    #[test]
    fn extended_header_refuses_wrong_geometry_and_wraparound() {
        let mut source = SparseContainer {
            head: header_for_body(u32::MAX as u64 + 1, 0).expect("header"),
            tail: Vec::new(),
            body_len: u32::MAX as u64 + 1,
        };
        source.head[12..16].copy_from_slice(&16u32.to_le_bytes());
        assert_eq!(kandelo_image_fs::kandelo_image_span(&source), Err(Errno::EINVAL));
        source.head[12..16].copy_from_slice(&24u32.to_le_bytes());
        source.head[16..24].copy_from_slice(&u64::MAX.to_le_bytes());
        assert_eq!(kandelo_image_fs::kandelo_image_span(&source), Err(Errno::EINVAL));
        source.head[16..24].copy_from_slice(&(source.body_len + 1).to_le_bytes());
        assert_eq!(kandelo_image_fs::kandelo_image_span(&source), Err(Errno::EINVAL));
    }
}
