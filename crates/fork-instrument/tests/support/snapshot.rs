//! Fixed expectations captured from the validated native implementation.
use sha2::{Digest, Sha256};

pub fn check(input: &[u8], variant: &str, value: impl std::fmt::Debug) {
    let digest = format!("{:x}", Sha256::digest(input));
    let name = std::thread::current().name().unwrap().to_owned();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/snapshots")
        .join(format!("{name}.txt"));
    let actual = format!("{value:#?}\n");
    let expected = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("missing regression expectation {}: {error}", path.display())
    });
    let marker = format!("=== {variant} {} ===\n", &digest[..12]);
    let section = expected
        .split_once(&marker)
        .unwrap_or_else(|| panic!("missing {marker:?} in {}", path.display()))
        .1;
    let expected = section
        .split_once("\n=== ")
        .map_or(section, |(value, _)| value);
    assert_eq!(actual, expected, "{}: {marker}", path.display());
}
