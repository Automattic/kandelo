//! A registered cleanup handler is the caller's own translation unit's
//! function, not every function sharing its (static) name.
use fork_instrument::{Options, facts, native};
use wasm_encoder::{CustomSection, Encode};

fn append(bytes: &mut Vec<u8>, name: &str, data: &[u8]) {
    bytes.push(0);
    CustomSection {
        name: name.into(),
        data: data.into(),
    }
    .encode(bytes);
}

fn fixture() -> Vec<u8> {
    let plain = wat::parse_str(include_str!("fixtures/cleanup_handler_identity.wat")).unwrap();
    let mut input = plain.clone();
    append(
        &mut input,
        facts::SECTION,
        include_bytes!("fixtures/cleanup_handler_identity.calltypes"),
    );
    append(
        &mut input,
        facts::CODE_HASH_SECTION,
        &facts::code_sha256(&plain).unwrap(),
    );
    input
}

#[test]
fn same_named_static_cleanup_handlers_resolve_within_the_registering_unit() {
    let input = fixture();
    // Before the fix this failed with "activation has no ordinary call
    // landings": `caller` was kept, but its only call goes to a frame that
    // cannot reach fork.
    native::instrument(&input, &Options::default(), Default::default())
        .expect("instrumenting with same-named static cleanup handlers");
    let analysis = native::analyze(&input, &Options::default(), Default::default()).unwrap();
    assert_eq!(analysis.decision.source, fork_instrument::PlanSource::Facts);
    let name = |f: u32| analysis.scan.functions[f as usize].name.clone();
    let caller = (0..analysis.scan.functions.len() as u32)
        .find(|&f| name(f).as_deref() == Some("caller"))
        .unwrap();
    // a.c's handler cannot fork, so neither can `caller`.
    assert!(
        !analysis.reaching.activations.contains(&caller),
        "caller kept through another unit's same-named handler"
    );
}
