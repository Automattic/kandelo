//! Admission for interfaces explicitly required by versioned Wasm imports.
use crate::facts::{ArtifactFacts, DescriptorKind};
use alloc::{format, string::String, vec::Vec};
use wasm_posix_program_abi::program_extensions::{
    extension_import, is_extension_import_name, klog_v1 as klog, stack_v1 as stack,
    memory_group_growth_v1 as growth,
    loader_v1 as loader,
