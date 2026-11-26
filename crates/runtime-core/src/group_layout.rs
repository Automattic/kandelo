//! Kernel interpretation of the normal SDK grouped executable layout.
use wasm_posix_shared::{Errno, memory_group::ReceiptRecord};
#[derive(Clone, Copy)]
pub(crate) struct Artifact { minimum: u32, maximum: u32, heap: u64, slots: Option<i32> }
impl Artifact {
    pub(crate) fn read(bytes: &[u8]) -> Result<Self, Errno> {
        let declared = wasm_artifact::grouped_memory::read_layout(bytes).map_err(|_| Errno::ENOEXEC)?;
        Ok(Self { minimum: declared.initial_pages, maximum: declared.maximum_pages,
            heap: wasm_artifact::read_heap_base(bytes).unwrap_or(u64::from(wasm_posix_shared::process_memory::FALLBACK_BRK_BASE)),
            slots: wasm_artifact::read_thread_slot_declaration(bytes) })
    }
}
const PAGE: u64 = 65536;

#[derive(Clone, Copy)]
pub(crate) struct Layout(pub(crate) [u64; 14]);
impl Layout {
    pub(crate) fn artifact(bytes: &[u8], ceiling: u32) -> Result<Self, Errno> {
        Self::configured(Artifact::read(bytes)?, ceiling, wasm_posix_shared::process_memory::DEFAULT_THREAD_SLOTS)
    }
    pub(crate) fn configured(artifact: Artifact, ceiling: u32, default_slots: u32) -> Result<Self, Errno> {
        use wasm_posix_shared::process_memory as M;
        let maximum = artifact.maximum.min(ceiling);
        let minimum = artifact.minimum.max(M::DEFAULT_INITIAL_PAGES);
        let heap = artifact.heap;
        let base = heap
            .max(u64::from(minimum) * PAGE)
            .checked_add(PAGE - 1)
            .ok_or(Errno::ENOMEM)?
            / PAGE;
        let channel_page = base
            .checked_add(u64::from(M::MAIN_CHANNEL_PRIMARY_PAGE))
            .ok_or(Errno::ENOMEM)?;
        let channel_pages = (wasm_posix_shared::channel::MIN_CHANNEL_SIZE as u64).div_ceil(PAGE);
        let end = channel_page
            .checked_add(channel_pages)
            .ok_or(Errno::ENOMEM)?;
        if end > u64::from(maximum) || maximum == 0 {
            return Err(Errno::ENOMEM);
        }
        let slots = match artifact.slots {
            None | Some(M::THREAD_SLOTS_USE_HOST_DEFAULT) => u64::from(default_slots),
            Some(value) if value >= 0 => value as u64,
            _ => return Err(Errno::ENOEXEC),
        };
        Ok(Self([
            end,
            u64::from(maximum),
            base * PAGE,
            end * PAGE,
            channel_page * PAGE,
            channel_page,
            end * PAGE,
            end * PAGE,
            u64::from(maximum) * PAGE,
            u64::from(maximum) * PAGE,
            end,
            end + u64::from(M::THREAD_SLOT_CHANNEL_PRIMARY_PAGE),
            end,
            slots,
        ]))
    }
    pub(crate) fn record(self, receipt: ReceiptRecord) -> wasm_posix_shared::group_memory_layout::Record {
        let v = self.0;
        wasm_posix_shared::group_memory_layout::Record {
            receipt,
            initial_pages: v[0] as u32,
            maximum_pages: v[1] as u32,
            control_base: v[2],
            control_end: v[3],
            channel: v[4],
            brk_base: v[6],
            mmap_base: v[7],
            brk_limit: v[8],
            mode: wasm_posix_shared::group_memory_layout::FRESH,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn group_layout_preserves_embedder_defaults_and_artifact_ceilings() {
        let mut artifact = Artifact::read(&crate::grouped_exec::tests::grouped(3)).unwrap();
        artifact.maximum = 512;
        let inherited = Layout::configured(artifact, 1024, 73).unwrap();
        assert_eq!(inherited.0[1], 512);
        assert_eq!(inherited.0[13], 73);
        artifact.slots = Some(0);
        assert_eq!(Layout::configured(artifact, 1024, 73).unwrap().0[13], 0);
        artifact.slots = Some(-2);
        assert!(matches!(Layout::configured(artifact, 1024, 73), Err(Errno::ENOEXEC)));
    }
}
