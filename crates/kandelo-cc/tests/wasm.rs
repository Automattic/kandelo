//! The post-link module edits, checked against the fork instrumenter that
//! reads them.

use kandelo_cc::driver::is_fork_capable;
use kandelo_cc::wasm::{with_code_hash_section, without_custom_section, CALLTYPES_CODE_HASH_SECTION, CALLTYPES_SECTION};

fn module(wat: &str) -> Vec<u8> {
    wat::parse_str(wat).unwrap()
}

/// `bytes` with a custom section appended.
fn with_custom(mut bytes: Vec<u8>, name: &str, payload: &[u8]) -> Vec<u8> {
    let mut body = vec![name.len() as u8];
    body.extend_from_slice(name.as_bytes());
    body.extend_from_slice(payload);
    bytes.push(0);
    bytes.push(body.len() as u8);
    bytes.extend(body);
    bytes
}

/// The custom sections of `bytes`, read independently of the crate under test.
fn custom_sections(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut offset = 8;
    while offset < bytes.len() {
        let id = bytes[offset];
        let (size, body) = leb(bytes, offset + 1);
        if id == 0 {
            let (name_len, name_start) = leb(bytes, body);
            let name = String::from_utf8(bytes[name_start..name_start + name_len].to_vec()).unwrap();
            out.push((name, bytes[name_start + name_len..body + size].to_vec()));
        }
        offset = body + size;
    }
    out
}

fn leb(bytes: &[u8], mut offset: usize) -> (usize, usize) {
    let (mut value, mut shift) = (0usize, 0);
    loop {
        let byte = bytes[offset];
        offset += 1;
        value |= ((byte & 0x7f) as usize) << shift;
        shift += 7;
        if byte & 0x80 == 0 {
            return (value, offset);
        }
    }
}

const FORK_MODULE: &str = r#"(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (memory 1)
  (func (export "_start") (drop (call $fork))))"#;

#[test]
fn the_code_hash_is_the_one_the_instrumenter_checks() {
    let linked = with_custom(module(FORK_MODULE), CALLTYPES_SECTION, b"facts");
    let hashed = with_code_hash_section(&linked).unwrap().expect("module has code");
    let sections = custom_sections(&hashed);
    let (_, recorded) = sections.iter().find(|(name, _)| name == CALLTYPES_CODE_HASH_SECTION).unwrap();
    assert_eq!(recorded.as_slice(), fork_instrument::facts::code_sha256(&hashed).unwrap().as_slice());
    assert_eq!(CALLTYPES_CODE_HASH_SECTION, fork_instrument::facts::CODE_HASH_SECTION);
    assert_eq!(CALLTYPES_SECTION, fork_instrument::facts::SECTION);
    // The facts themselves stay for the instrumenter.
    assert!(sections.iter().any(|(name, payload)| name == CALLTYPES_SECTION && payload == b"facts"));
}

#[test]
fn rewriting_the_code_hash_replaces_the_old_one() {
    let linked = with_custom(module(FORK_MODULE), CALLTYPES_CODE_HASH_SECTION, &[0; 32]);
    let hashed = with_code_hash_section(&linked).unwrap().unwrap();
    let hashes: Vec<_> = custom_sections(&hashed)
        .into_iter()
        .filter(|(name, _)| name == CALLTYPES_CODE_HASH_SECTION)
        .collect();
    assert_eq!(hashes.len(), 1);
    assert_ne!(hashes[0].1, vec![0; 32]);
}

#[test]
fn a_module_without_code_is_left_alone() {
    assert_eq!(with_code_hash_section(&module("(module (memory 1))")).unwrap(), None);
}

#[test]
fn stripping_the_facts_keeps_every_other_byte() {
    let plain = module(FORK_MODULE);
    let linked = with_custom(with_custom(plain.clone(), CALLTYPES_SECTION, b"a"), CALLTYPES_SECTION, b"b");
    assert_eq!(without_custom_section(&linked, CALLTYPES_SECTION).unwrap(), Some(plain.clone()));
    assert_eq!(without_custom_section(&plain, CALLTYPES_SECTION).unwrap(), None);
}

#[test]
fn fork_capability_is_the_kernel_fork_import() {
    assert!(is_fork_capable(&module(FORK_MODULE)).unwrap());
    let other = r#"(module
      (import "kernel" "kernel_forks" (func (result i32)))
      (import "env" "kernel_fork" (func (result i32)))
      (import "env" "memory" (memory 1 1 shared))
      (import "env" "g" (global i32))
      (func (export "_start")))"#;
    assert!(!is_fork_capable(&module(other)).unwrap());
    assert!(!is_fork_capable(&module("(module (func (export \"_start\")))")).unwrap());
}
