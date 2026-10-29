use fork_instrument::{
    Options,
    contract_inventory::{ArtifactAbiVersion, artifact_identity},
    native,
    streaming::*,
};
use wasm_encoder::{CustomSection, Encode};

#[test]
fn leading_dylink_selects_state_only_side_role_and_invalid_abi_is_rejected() {
    for malformed_marker in [false, true] {
        let marker = if malformed_marker {
            "(func (export \"__abi_version\"))"
        } else {
            ""
        };
        let plain = wat::parse_str(format!("(module (func (export \"probe\")) {marker})")).unwrap();
        let mut input = plain[..8].to_vec();
        input.push(0);
        CustomSection {
            name: "dylink.0".into(),
            data: (&[1, 4, 0, 0, 0, 0][..]).into(),
        }
        .encode(&mut input);
        input.extend_from_slice(&plain[8..]);
        let analysis = native::analyze(&input, &Options::default(), Default::default()).unwrap();
        assert!(analysis.decision.participates && analysis.decision.side_module);
        assert!(analysis.reaching.activations.is_empty());
        let planned = analysis.freeze(Default::default());
        if malformed_marker {
            assert!(
                planned
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("invalid __abi_version")
            );
            continue;
        }
        let (mut pipeline, _) = planned.unwrap();
        let mut output = Vec::new();
        pipeline.emit(&mut output).unwrap();
        wasmparser::Validator::new_with_features(features())
            .validate_all(&output)
            .unwrap();
        assert!(
            matches!(wasmparser::Parser::new(0).parse_all(&output).nth(1).unwrap().unwrap(),
            wasmparser::Payload::CustomSection(section) if section.name() == "dylink.0")
        );
        assert_eq!(
            artifact_identity(&output).unwrap().abi_version,
            ArtifactAbiVersion::Present(wasm_posix_program_abi::ABI_VERSION)
        );
        assert!(
            scan(&output)
                .unwrap()
                .exports
                .iter()
                .any(|(name, _, _)| name == "wpk_fork_module_state_save")
        );
    }
}
