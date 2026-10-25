//! Versioned claims describe this invocation's completed native rewrite.
use super::Decision;
use crate::{
    Options,
    linked_frames::{self, FrameFormatDescriptor, PointerWidth},
    streaming::NativeRuntime,
};
use anyhow::{Result, ensure};
use std::io::Write;
use wasm_encoder::{CustomSection, Encode, ValType};
use wasm_posix_shared::abi;

pub(super) fn write(
    runtime: &NativeRuntime,
    decision: &Decision,
    options: &Options,
    output: &mut impl Write,
    budget: usize,
) -> Result<()> {
    let width = if runtime.pointer_type() == ValType::I64 {
        PointerWidth::Wasm64
    } else {
        PointerWidth::Wasm32
    };
    let mut capabilities = abi::WPK_FORK_CAP_ACTIVATION_STATE_SAFE;
    if decision.side_module {
        capabilities |= abi::WPK_FORK_CAP_SIDE_ENTRY;
    }
    if !decision.side_module
        && decision.dynamic_linker
        && !decision.entry_imports.is_empty()
        && options.entry_import == "kernel.kernel_fork"
    {
        capabilities |= abi::WPK_FORK_CAP_DYLINK_MAIN;
    }
    for (name, data) in [
        (
            abi::WPK_FORK_CAPABILITIES_SECTION,
            vec![abi::WPK_FORK_CAPABILITIES_VERSION, capabilities],
        ),
        (
            linked_frames::LINKED_FRAME_FORMAT_SECTION,
            FrameFormatDescriptor::current(width, runtime.fixed_prefix_size())
                .encode()
                .to_vec(),
        ),
        (
            abi::WPK_FORK_MODULE_STATE_FORMAT_SECTION,
            crate::module_state_descriptor(width),
        ),
        (
            crate::UNWIND_TRANSPORT_SECTION,
            vec![
                crate::UNWIND_TRANSPORT_VERSION,
                abi::WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY,
            ],
        ),
    ] {
        section(output, name, &data, budget)?;
    }
    if let Some(contract) = &decision.dlopen_contract {
        section(
            output,
            crate::DLOPEN_CONTRACT_SECTION,
            contract.as_bytes(),
            budget,
        )?;
    }
    Ok(())
}

fn section(output: &mut impl Write, name: &str, data: &[u8], budget: usize) -> Result<()> {
    ensure!(
        name.len()
            .checked_add(data.len())
            .and_then(|n| n.checked_add(16))
            .is_some_and(|bytes| bytes <= budget),
        "native artifact metadata exceeds budget"
    );
    let mut bytes = vec![0];
    CustomSection {
        name: name.into(),
        data: data.into(),
    }
    .encode(&mut bytes);
    output.write_all(&bytes)?;
    Ok(())
}
