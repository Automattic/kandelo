mod effects;
mod origins;
mod regions;
pub use effects::CallPolicy;
pub use origins::analyze as analyze_origins;
pub use origins::analyze_constants;
pub use regions::{analyze as analyze_regions, analyze_with_calls as analyze_regions_with_calls};

#[cfg(test)]
mod origins_tests;

#[cfg(test)]
mod constants_tests;
