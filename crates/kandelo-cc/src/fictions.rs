//! Declared fictions: named, reviewed compromises a link opts into.
//!
//! A fiction is behaviour Kandelo cannot provide truthfully and reports as
//! provided anyway, for software that cannot run otherwise. The truthful
//! behaviour is always the default. A fiction applies only to a link that
//! selects it, with a configuration that bounds it, and the linked program
//! records the selection in its `kandelo.fictions` custom section.
//!
//! The registry of fictions is `sdk/fictions/<name>.toml`: what each fakes,
//! how that differs from POSIX, its risks, the intents a declaration may and
//! may not use it for, and its configuration schema. This module embeds the
//! schema part, because the driver runs where the repository is not (inside
//! Kandelo, from the guest SDK); a test keeps the two equal.
//!
//! Selection, by hand or from a package's `[[fictions]]` declaration (the
//! package build sets the environment variable):
//!
//! ```text
//! --kandelo-fiction=mprotect:prot_none=accept-unenforced,prot_none_max=65536
//! KANDELO_FICTIONS='mprotect:read_only=accept-unenforced'
//! ```
//!
//! Omitted keys take their (truthful) defaults. A selection that departs from
//! no default is refused: the truthful behaviour needs no declaration.
//! Selections apply to executable links; other invocations accept and ignore
//! them, so one flag or environment can cover a whole build.
//!
//! See docs/package-management.md ("Declared fictions") and
//! docs/plans/2026-11-17-declared-fictions-design.md.

use crate::Result;

/// The environment variable a package build sets from its declaration.
pub const ENV: &str = "KANDELO_FICTIONS";

/// The driver flag that selects a fiction for one invocation.
pub const FLAG: &str = "--kandelo-fiction";

/// The custom section a linked program carries for each fiction it links,
/// one line per fiction: the canonical selection followed by `\n`.
pub const STAMP_SECTION: &str = "kandelo.fictions";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    /// One of the listed words. The first is the truthful default.
    Enum(&'static [&'static str]),
    /// A byte count bounding the requests the named key accepts: a
    /// non-negative decimal integer, 0 meaning no bound. Meaningful only
    /// while that key departs from its default.
    Limit(&'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConfigKey {
    pub name: &'static str,
    pub kind: KeyKind,
    /// The truthful value, in canonical text form.
    pub default: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fiction {
    pub name: &'static str,
    /// Keys in canonical order.
    pub keys: &'static [ConfigKey],
}

const PROTECTION_ACTIONS: &[&str] = &["enotsup", "accept-unenforced"];

/// `sdk/fictions/mprotect.toml`.
pub const MPROTECT: Fiction = Fiction {
    name: "mprotect",
    keys: &[
        ConfigKey {
            name: "prot_none",
            kind: KeyKind::Enum(PROTECTION_ACTIONS),
            default: "enotsup",
        },
        ConfigKey {
            name: "prot_none_max",
            kind: KeyKind::Limit("prot_none"),
            default: "0",
        },
        ConfigKey {
            name: "read_only",
            kind: KeyKind::Enum(PROTECTION_ACTIONS),
            default: "enotsup",
        },
        ConfigKey {
            name: "read_only_max",
            kind: KeyKind::Limit("read_only"),
            default: "0",
        },
    ],
};

/// Every fiction the SDK implements.
pub const REGISTRY: &[Fiction] = &[MPROTECT];

/// One validated selection, with every key's value (defaults filled in) in
/// the fiction's canonical key order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    pub fiction: &'static Fiction,
    pub values: Vec<String>,
}

impl Selection {
    /// The canonical text: `name:key=value,...` with every key, in order.
    /// This is the stamp line and the cache identity of the selection.
    pub fn canonical(&self) -> String {
        let pairs: Vec<String> = self
            .fiction
            .keys
            .iter()
            .zip(&self.values)
            .map(|(key, value)| format!("{}={value}", key.name))
            .collect();
        format!("{}:{}", self.fiction.name, pairs.join(","))
    }

    pub fn value(&self, key: &str) -> &str {
        let index = self
            .fiction
            .keys
            .iter()
            .position(|k| k.name == key)
            .expect("a key of this fiction");
        &self.values[index]
    }
}

fn canonical_size(text: &str) -> Option<String> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u64>().ok().map(|n| n.to_string())
}

/// Parse one selection: `name` or `name:key=value,key=value`.
pub fn parse_selection(text: &str) -> Result<Selection> {
    let (name, config) = match text.split_once(':') {
        Some((name, config)) => (name, Some(config)),
        None => (text, None),
    };
    let Some(fiction) = REGISTRY.iter().find(|f| f.name == name) else {
        let known: Vec<&str> = REGISTRY.iter().map(|f| f.name).collect();
        return Err(format!(
            "unknown fiction {name:?} in {text:?}; the SDK declares: {}",
            known.join(", ")
        ));
    };
    let mut values: Vec<Option<String>> = vec![None; fiction.keys.len()];
    for pair in config.into_iter().flat_map(|c| c.split(',')) {
        let Some((key, value)) = pair.split_once('=') else {
            return Err(format!(
                "fiction {name}: expected key=value, found {pair:?}"
            ));
        };
        let Some(index) = fiction.keys.iter().position(|k| k.name == key) else {
            let known: Vec<&str> = fiction.keys.iter().map(|k| k.name).collect();
            return Err(format!(
                "fiction {name} has no key {key:?}; its keys are: {}",
                known.join(", ")
            ));
        };
        if values[index].is_some() {
            return Err(format!("fiction {name}: key {key} given twice"));
        }
        let canonical = match fiction.keys[index].kind {
            KeyKind::Enum(choices) => choices
                .contains(&value)
                .then(|| value.to_string())
                .ok_or_else(|| {
                    format!(
                        "fiction {name}: {key} must be one of {}, not {value:?}",
                        choices.join(", ")
                    )
                })?,
            KeyKind::Limit(_) => canonical_size(value).ok_or_else(|| {
                format!("fiction {name}: {key} must be a byte count, not {value:?}")
            })?,
        };
        values[index] = Some(canonical);
    }
    let values: Vec<String> = values
        .into_iter()
        .zip(fiction.keys)
        .map(|(value, key)| value.unwrap_or_else(|| key.default.to_string()))
        .collect();
    let departs = |name: &str| {
        let index = fiction
            .keys
            .iter()
            .position(|k| k.name == name)
            .expect("limited key exists");
        values[index] != fiction.keys[index].default
    };
    for (key, value) in fiction.keys.iter().zip(&values) {
        if let KeyKind::Limit(limited) = key.kind
            && value != key.default
            && !departs(limited)
        {
            return Err(format!(
                "fiction {name}: {} bounds what {limited} accepts, but {limited} is the truthful default",
                key.name
            ));
        }
    }
    if !fiction
        .keys
        .iter()
        .any(|key| matches!(key.kind, KeyKind::Enum(_)) && departs(key.name))
    {
        return Err(format!(
            "fiction {name}: {text:?} departs from no truthful default; \
             a link that needs only the truthful behaviour declares nothing{}",
            if fiction.name == "mprotect" {
                " (link -lkandelo-mprotect)"
            } else {
                ""
            }
        ));
    }
    Ok(Selection { fiction, values })
}

/// The selections of one invocation: `KANDELO_FICTIONS` (whitespace- or
/// `;`-separated), then each `--kandelo-fiction`. A fiction selected twice
/// must be selected the same way.
pub fn selections(env: Option<&str>, flags: &[String]) -> Result<Vec<Selection>> {
    let mut out: Vec<Selection> = Vec::new();
    let from_env = env
        .unwrap_or("")
        .split(|c: char| c == ';' || c.is_whitespace())
        .filter(|s| !s.is_empty());
    for text in from_env.chain(flags.iter().map(String::as_str)) {
        let selection = parse_selection(text)?;
        match out
            .iter()
            .find(|s| s.fiction.name == selection.fiction.name)
        {
            Some(existing) if *existing != selection => {
                return Err(format!(
                    "fiction {} is selected twice, differently: {} and {}",
                    selection.fiction.name,
                    existing.canonical(),
                    selection.canonical()
                ));
            }
            Some(_) => {}
            None => out.push(selection),
        }
    }
    Ok(out)
}

/// The selections in effect for this process's invocation.
pub fn selections_from_environment(flags: &[String]) -> Result<Vec<Selection>> {
    let env = std::env::var(ENV).ok();
    selections(env.as_deref(), flags).map_err(|error| {
        let source = if flags.is_empty() {
            ENV.to_string()
        } else {
            format!("{FLAG} / {ENV}")
        };
        format!("{source}: {error}")
    })
}

/// The custom-section definition that stamps `selection` into whatever
/// program links the object holding it.
///
/// WHY assembly: clang places a C object with a `.custom_section.*` section
/// attribute in the data segment, not in a custom section. The assembler's
/// `.section .custom_section.<name>` makes a real custom section, which
/// wasm-ld concatenates across the linked objects (one line per fiction).
/// A canonical selection is lowercase words, digits and `:=,_-`, so it needs
/// no escaping inside the assembler string.
fn stamp_definition(selection: &Selection) -> String {
    let line = selection.canonical();
    debug_assert!(
        line.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b":=,_-".contains(&b))
    );
    format!(
        "__asm__(\".section .custom_section.{STAMP_SECTION},\\\"\\\",@\\n\"\n\
         \x20       \".ascii \\\"{line}\\\\n\\\"\\n\"\n\
         \x20       \".text\\n\");\n"
    )
}

fn protection_action(value: &str) -> &'static str {
    match value {
        "accept-unenforced" => "KANDELO_MPROTECT_ACCEPT_UNENFORCED",
        _ => "KANDELO_MPROTECT_ENOTSUP",
    }
}

/// The generated source for a selection: a public symbol with the declared
/// configuration, and the stamp. The SDK links it lazily, ahead of the
/// caller's inputs, so it is linked exactly when the program uses the
/// interface, and then in place of the truthful definition.
pub fn source(selection: &Selection) -> String {
    match selection.fiction.name {
        "mprotect" => format!(
            "/* Generated by the Kandelo SDK driver for the declared fiction\n\
             \x20* {canonical}\n\
             \x20* (sdk/fictions/mprotect.toml). */\n\
             #include <stddef.h>\n\
             #include \"kandelo_mprotect_policy.h\"\n\
             \n\
             static const struct __kandelo_mprotect_policy declared = {{\n\
             \t.version = KANDELO_MPROTECT_POLICY_VERSION,\n\
             \t.prot_none = {prot_none},\n\
             \t.read_only = {read_only},\n\
             \t.prot_none_max = {prot_none_max}ull,\n\
             \t.read_only_max = {read_only_max}ull,\n\
             }};\n\
             \n\
             int mprotect(void *addr, size_t len, int prot)\n\
             {{\n\
             \treturn __kandelo_mprotect_with_policy(addr, len, prot, &declared);\n\
             }}\n\
             \n\
             {stamp}",
            canonical = selection.canonical(),
            prot_none = protection_action(selection.value("prot_none")),
            read_only = protection_action(selection.value("read_only")),
            prot_none_max = selection.value("prot_none_max"),
            read_only_max = selection.value("read_only_max"),
            stamp = stamp_definition(selection),
        ),
        other => unreachable!("fiction {other} has no source generator"),
    }
}

/// The SDK library holding what a fiction's generated source calls.
pub fn support_library(selection: &Selection) -> &'static str {
    match selection.fiction.name {
        "mprotect" => "-lkandelo-mprotect",
        other => unreachable!("fiction {other} has no support library"),
    }
}

/// The generated source's file name.
pub fn source_name(selection: &Selection) -> String {
    format!("kandelo_fiction_{}.c", selection.fiction.name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn canonical_form_fills_defaults_in_key_order() {
        let s =
            parse_selection("mprotect:prot_none_max=65536,prot_none=accept-unenforced").unwrap();
        assert_eq!(
            s.canonical(),
            "mprotect:prot_none=accept-unenforced,prot_none_max=65536,read_only=enotsup,read_only_max=0"
        );
    }

    #[test]
    fn sizes_are_canonical_decimal() {
        let s = parse_selection("mprotect:read_only=accept-unenforced,read_only_max=000131072")
            .unwrap();
        assert_eq!(s.value("read_only_max"), "131072");
        for bad in ["-1", "64K", "", "0x10000", "18446744073709551616"] {
            let text = format!("mprotect:read_only=accept-unenforced,read_only_max={bad}");
            assert!(parse_selection(&text).is_err(), "{bad} accepted");
        }
    }

    #[test]
    fn refuses_unknown_names_keys_values_and_repeats() {
        assert!(
            parse_selection("mmap:x=1")
                .unwrap_err()
                .contains("unknown fiction")
        );
        assert!(
            parse_selection("mprotect:exec=accept-unenforced")
                .unwrap_err()
                .contains("no key")
        );
        assert!(
            parse_selection("mprotect:prot_none=yes")
                .unwrap_err()
                .contains("one of")
        );
        assert!(
            parse_selection("mprotect:prot_none")
                .unwrap_err()
                .contains("key=value")
        );
        assert!(
            parse_selection("mprotect:prot_none=accept-unenforced,prot_none=enotsup")
                .unwrap_err()
                .contains("twice")
        );
    }

    #[test]
    fn refuses_a_selection_that_is_the_truthful_default() {
        for text in ["mprotect", "mprotect:prot_none=enotsup,read_only_max=0"] {
            let error = parse_selection(text).unwrap_err();
            assert!(error.contains("no truthful default"), "{text}: {error}");
            assert!(error.contains("-lkandelo-mprotect"), "{text}: {error}");
        }
        // A bound on a class that is not accepted bounds nothing.
        let error = parse_selection("mprotect:read_only=accept-unenforced,prot_none_max=65536")
            .unwrap_err();
        assert!(
            error.contains("prot_none_max bounds what prot_none accepts"),
            "{error}"
        );
    }

    #[test]
    fn merges_environment_and_flags() {
        let env = "mprotect:prot_none=accept-unenforced";
        assert_eq!(selections(Some(env), &[]).unwrap().len(), 1);
        assert_eq!(selections(None, &[]).unwrap(), Vec::<Selection>::new());
        assert_eq!(
            selections(Some("  ;\n"), &[]).unwrap(),
            Vec::<Selection>::new()
        );
        // The same selection twice is one selection.
        let same = selections(
            Some(env),
            &flags(&["mprotect:prot_none=accept-unenforced,read_only=enotsup"]),
        )
        .unwrap();
        assert_eq!(same.len(), 1);
        let error =
            selections(Some(env), &flags(&["mprotect:read_only=accept-unenforced"])).unwrap_err();
        assert!(error.contains("selected twice"), "{error}");
    }

    #[test]
    fn generated_source_carries_the_policy_and_the_stamp() {
        let s =
            parse_selection("mprotect:prot_none=accept-unenforced,prot_none_max=65536").unwrap();
        let c = source(&s);
        assert!(c.contains(".prot_none = KANDELO_MPROTECT_ACCEPT_UNENFORCED,"));
        assert!(c.contains(".read_only = KANDELO_MPROTECT_ENOTSUP,"));
        assert!(c.contains(".prot_none_max = 65536ull,"));
        assert!(c.contains(".read_only_max = 0ull,"));
        assert!(
            c.contains(&format!(
                "__asm__(\".section .custom_section.kandelo.fictions,\\\"\\\",@\\n\"\n\
             \x20       \".ascii \\\"{}\\\\n\\\"\\n\"\n\
             \x20       \".text\\n\");\n",
                s.canonical()
            )),
            "{c}"
        );
        assert_eq!(support_library(&s), "-lkandelo-mprotect");
    }

    /// The embedded schema is `sdk/fictions/*.toml`'s `[config.*]` tables.
    /// A deliberately small reader: the registry files are reviewed, plain
    /// TOML, and this crate keeps its dependency set minimal.
    #[test]
    fn embedded_schema_matches_the_registry() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sdk/fictions");
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.ends_with(".toml"))
            .map(|n| n.trim_end_matches(".toml").to_string())
            .collect();
        names.sort();
        let mut embedded: Vec<String> = REGISTRY.iter().map(|f| f.name.to_string()).collect();
        embedded.sort();
        assert_eq!(
            names, embedded,
            "sdk/fictions and fictions::REGISTRY list different fictions"
        );

        for fiction in REGISTRY {
            let text = std::fs::read_to_string(dir.join(format!("{}.toml", fiction.name))).unwrap();
            assert!(text.contains(&format!("name = \"{}\"", fiction.name)));
            let mut keys: Vec<(String, String, Option<String>, String)> = Vec::new();
            // `type` carries the limited key for a limit: "size:<key>".
            for line in text.lines() {
                let line = line.trim();
                if let Some(key) = line
                    .strip_prefix("[config.")
                    .and_then(|l| l.strip_suffix(']'))
                {
                    keys.push((key.to_string(), String::new(), None, String::new()));
                } else if line.starts_with('[') {
                    assert!(keys.is_empty(), "[config.*] tables must come last");
                } else if let Some(current) = keys.last_mut() {
                    if let Some(v) = line.strip_prefix("type = ") {
                        current.1 = v.trim_matches('"').to_string();
                    } else if let Some(v) = line.strip_prefix("values = ") {
                        current.2 = Some(v.to_string());
                    } else if let Some(v) = line.strip_prefix("limits = ") {
                        current.1 = format!("{}:{}", current.1, v.trim_matches('"'));
                    } else if let Some(v) = line.strip_prefix("default = ") {
                        current.3 = v.trim_matches('"').to_string();
                    }
                }
            }
            let expected: Vec<(String, String, Option<String>, String)> = fiction
                .keys
                .iter()
                .map(|key| match key.kind {
                    KeyKind::Enum(choices) => (
                        key.name.to_string(),
                        "enum".to_string(),
                        Some(format!(
                            "[{}]",
                            choices
                                .iter()
                                .map(|c| format!("\"{c}\""))
                                .collect::<Vec<_>>()
                                .join(", ")
                        )),
                        key.default.to_string(),
                    ),
                    KeyKind::Limit(limited) => (
                        key.name.to_string(),
                        format!("size:{limited}"),
                        None,
                        key.default.to_string(),
                    ),
                })
                .collect();
            assert_eq!(keys, expected, "sdk/fictions/{}.toml", fiction.name);
        }
    }
}
