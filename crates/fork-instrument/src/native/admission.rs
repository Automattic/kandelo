//! Raw input must not carry a previous activation or private recipe runtime.
use crate::{
    instrument, linked_frames, module_exception_codec, module_gc_codec, runtime::names,
    static_reference_catalog, streaming::Scan,
};
use anyhow::{Result, ensure};
use wasm_posix_shared::abi;
use wasmparser::{Parser, Payload};

pub(super) fn reject_instrumented(scan: &Scan<'_>) -> Result<()> {
    let export_collision = scan.exports.iter().any(|(name, _, _)| {
        abi::WPK_FORK_REQUIRED_EXPORTS
            .iter()
            .any(|entry| entry.name == name)
            || matches!(
                name.as_str(),
                crate::FUNCTION_CATALOG_EXPORT
                    | instrument::RESUME_CATALOG_EXPORT
                    | instrument::RESUME_START_EXPORT
                    | instrument::RESUME_THREAD_EXPORT
                    | instrument::RESUME_SINK_EXPORT
                    | static_reference_catalog::EXPORT
                    | static_reference_catalog::HARVEST_EXPORT
            )
            || name.starts_with(abi::WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX)
            || name.starts_with(abi::WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX)
    });
    let metadata_collision = scan.custom_sections.iter().any(|(name, _)| {
        matches!(
            *name,
            abi::WPK_FORK_CAPABILITIES_SECTION
                | linked_frames::LINKED_FRAME_FORMAT_SECTION
                | module_exception_codec::FORMAT_SECTION
                | module_gc_codec::FORMAT_SECTION
                | abi::WPK_FORK_MODULE_STATE_FORMAT_SECTION
                | abi::WPK_FORK_IMPORTED_TABLES_SECTION
                | abi::WPK_FORK_IMPORTED_GLOBALS_SECTION
                | instrument::RESUME_CATALOG_SECTION
                | static_reference_catalog::FORMAT_SECTION
                | instrument::BOUNDARIES_SECTION
                | crate::UNWIND_TRANSPORT_SECTION
                | crate::DLOPEN_CONTRACT_SECTION
        )
    });
    ensure!(
        !export_collision && !metadata_collision,
        "fork-instrument: input already contains wasm-fork-instrument exports or metadata; rebuild the raw linker output"
    );
    for payload in Parser::new(0).parse_all(scan.input()) {
        if let Payload::ImportSection(section) = payload? {
            for import in section.into_imports() {
                let import = import?;
                ensure!(
                    !abi::WPK_FORK_REQUIRED_IMPORTS
                        .iter()
                        .any(|entry| entry.module == import.module && entry.name == import.name),
                    "fork-instrument: input already contains wasm-fork-instrument imports; rebuild the raw linker output"
                );
                let reserved = import.module == names::IMPORT_UNWIND_TAG_MODULE
                    && (module_exception_codec::is_reserved_host_import(import.name)
                        || matches!(
                            import.name,
                            names::IMPORT_UNWIND_TAG
                                | names::IMPORT_REF_ENCODE_FUNCREF
                                | names::IMPORT_REF_DECODE_FUNCREF
                                | names::IMPORT_REF_ENCODE_EXTERNREF
                                | names::IMPORT_REF_DECODE_EXTERNREF
                                | names::IMPORT_REF_ENCODE_EXNREF
                                | names::IMPORT_REF_DECODE_EXNREF
                                | names::IMPORT_REF_ENCODE_ANYREF
                                | names::IMPORT_REF_DECODE_ANYREF
                        ));
                ensure!(
                    !reserved,
                    "fork-instrument: input imports a reserved private fork runtime hook from env"
                );
            }
        }
    }
    Ok(())
}
