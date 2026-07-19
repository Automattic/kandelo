#[cfg(test)]
mod tests {
    use jsonschema::JSONSchema;
    use serde_json::{Value, json};
    use std::fs;
    use std::path::PathBuf;

    fn repo_path(rel: &str) -> PathBuf {
        crate::repo_root().join(rel)
    }

    fn load_json(rel: &str) -> Value {
        let path = repo_path(rel);
        let text =
            fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
    }

    fn compile_schema(rel: &str) -> JSONSchema {
        let schema = load_json(rel);
        JSONSchema::compile(&schema).unwrap_or_else(|e| panic!("compile schema {rel}: {e}"))
    }

    fn validation_errors(schema: &JSONSchema, instance: &Value) -> Vec<String> {
        match schema.validate(instance) {
            Ok(()) => Vec::new(),
            Err(errors) => errors.map(|e| e.to_string()).collect(),
        }
    }

    fn assert_valid(schema_rel: &str, instance_rel: &str) {
        let schema = compile_schema(schema_rel);
        let instance = load_json(instance_rel);
        let errors = validation_errors(&schema, &instance);
        assert!(
            errors.is_empty(),
            "{} should validate against {}:\n{}",
            instance_rel,
            schema_rel,
            errors.join("\n")
        );
    }

    fn assert_invalid(schema_rel: &str, mut instance: Value, mutate: impl FnOnce(&mut Value)) {
        let schema = compile_schema(schema_rel);
        mutate(&mut instance);
        let errors = validation_errors(&schema, &instance);
        assert!(
            !errors.is_empty(),
            "mutated fixture should not validate against {schema_rel}"
        );
    }

    fn schema_rel(name: &str) -> String {
        format!("homebrew/homebrew-tap-core/Kandelo/{name}.schema.json")
    }

    fn example_rel(path: &str) -> String {
        format!("homebrew/homebrew-tap-core/Kandelo/examples/{path}")
    }

    #[test]
    fn homebrew_examples_validate_against_schemas() {
        let cases = [
            (schema_rel("metadata"), example_rel("metadata.json")),
            (schema_rel("formula"), example_rel("formula/hello.json")),
            (
                schema_rel("link-manifest"),
                example_rel("link/hello-2.12.1-rebuild0-wasm32.json"),
            ),
            (
                schema_rel("provenance"),
                example_rel("reports/hello-2.12.1-rebuild0-wasm32.provenance.json"),
            ),
        ];

        for (schema, instance) in cases {
            assert_valid(&schema, &instance);
        }
    }

    #[test]
    fn homebrew_metadata_rejects_arch_tag_mismatch() {
        let instance = load_json(&example_rel("metadata.json"));
        assert_invalid(&schema_rel("metadata"), instance, |value| {
            *value
                .pointer_mut("/packages/0/bottles/0/bottle_tag")
                .expect("bottle tag fixture path") = json!("wasm64_kandelo");
        });
    }

    #[test]
    fn homebrew_metadata_rejects_browser_claim_without_browser_runtime() {
        let instance = load_json(&example_rel("metadata.json"));
        assert_invalid(&schema_rel("metadata"), instance, |value| {
            *value
                .pointer_mut("/packages/0/bottles/0/browser_compatible")
                .expect("browser_compatible fixture path") = json!(true);
        });
    }

    #[test]
    fn link_manifest_rejects_absolute_link_targets() {
        let instance = load_json(&example_rel("link/hello-2.12.1-rebuild0-wasm32.json"));
        assert_invalid(&schema_rel("link-manifest"), instance, |value| {
            *value
                .pointer_mut("/links/0/target")
                .expect("link target fixture path") = json!("/bin/hello");
        });
    }

    #[test]
    fn link_manifest_accepts_posix_bracket_utility_paths() {
        let schema = compile_schema(&schema_rel("link-manifest"));
        let mut instance = load_json(&example_rel("link/hello-2.12.1-rebuild0-wasm32.json"));
        *instance
            .pointer_mut("/links/0/source")
            .expect("link source fixture path") =
            json!("Cellar/coreutils/9.5/bin/[");
        *instance
            .pointer_mut("/links/0/target")
            .expect("link target fixture path") = json!("bin/[");

        let errors = validation_errors(&schema, &instance);
        assert!(
            errors.is_empty(),
            "POSIX bracket utility paths should validate:\n{}",
            errors.join("\n")
        );
    }

    #[test]
    fn link_manifest_rejects_malformed_bottle_sha() {
        let instance = load_json(&example_rel("link/hello-2.12.1-rebuild0-wasm32.json"));
        assert_invalid(&schema_rel("link-manifest"), instance, |value| {
            *value
                .pointer_mut("/bottle/sha256")
                .expect("bottle sha fixture path") = json!("not-a-sha");
        });
    }

    #[test]
    fn scaffold_paths_exist_for_semantic_validator_handoff() {
        let expected = [
            "homebrew/homebrew-tap-core/Formula",
            "homebrew/homebrew-tap-core/Kandelo/examples/formula",
            "homebrew/homebrew-tap-core/Kandelo/examples/link",
            "homebrew/homebrew-tap-core/Kandelo/examples/reports",
        ];

        for rel in expected {
            let path = repo_path(rel);
            assert!(
                path.is_dir(),
                "expected scaffold directory {}",
                path.display()
            );
        }
    }
}
