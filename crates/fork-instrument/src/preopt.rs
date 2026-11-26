//! Prepare private optimizer input without metadata tied to instruction offsets.
use crate::{artifact_io::copy_without_custom, contract_inventory::artifact_identity, native};
use anyhow::{Result, ensure};
use std::io::Write;

pub fn prepare(input: &[u8], output: &mut impl Write) -> Result<()> {
    let identity = artifact_identity(input)?;
    ensure!(
        identity.relocatable == 0 && identity.dylink_section_count == 0,
        "pre-optimization requires a main executable"
    );
    ensure!(
        identity.memory_count == 1 && identity.memory64_count == 0,
        "pre-optimization requires a wasm32 executable"
    );
    ensure!(identity.imports_kernel_fork == 1, "pre-optimization requires kernel.kernel_fork");
    native::reject_instrumented_input(input)?;
    copy_without_custom(input, output, |name| {
        name == crate::facts::SECTION
            || name == crate::facts::CODE_HASH_SECTION
            || name == crate::debug_info::SECTION
            || name.starts_with(".debug_")
            || name.starts_with(".zdebug_")
    })
}
