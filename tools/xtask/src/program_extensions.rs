//! Generate independently versioned extension contracts without changing the
//! frozen base program snapshot or its digest. Imports declare requirements.
use wasm_posix_shared::program_extensions::{self, klog_v1 as klog, loader_v1 as loader, stack_v1 as stack, memory_group_v3 as group, memory_group_growth_v1 as growth};
