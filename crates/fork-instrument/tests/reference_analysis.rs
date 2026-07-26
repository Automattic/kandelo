// Keep the reference planner independently compilable until its facts are
// wired into the transform. This avoids creating a temporary public API in
// `lib.rs` while still running the module's focused unit tests in CI.
#[path = "../src/reference_analysis.rs"]
mod reference_analysis;
