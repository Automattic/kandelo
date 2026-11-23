//! Resolve private SDK linker symbols before process-fork instrumentation.
use super::*;
use crate::{
    artifact_io::{ArtifactSpool, MappedArtifact},
    native::Limits,
};
use anyhow::{Context, Result, ensure};
use std::collections::{BTreeMap, BTreeSet};
use wasm_encoder::{
    ConstExpr, ExportSection, Function, Instruction,
    reencode::{self, Reencode},
};
use wasmparser::{ExternalKind, Parser, Payload};

mod generated;

const PREFIX: &str = "__kandelo_local_continuation_";
const CONTROLS: u32 = 7;

pub(crate) fn prepare(input: &[u8], limits: Limits) -> Result<Option<MappedArtifact>> {
    // Ordinary guest binaries only need a cheap section-header scan here.
    let mut selected = false;
    for payload in Parser::new(0).parse_all(input) {
        match payload? {
            Payload::ExportSection(exports) => {
                for export in exports {
                    if export?.name.starts_with(PREFIX) {
                        selected = true;
                        break;
                    }
                }
                break;
            }
            Payload::CodeSectionStart { .. } | Payload::End(_) => break,
            _ => {}
        }
    }
    if !selected {
        return Ok(None);
    }

    let scan = scan(input)?;
    crate::native::reject_instrumented_input(input)?;
    let mut emitter = Emitter::plan(&scan, limits.pipeline)?;
    let mut raw = ArtifactSpool::new(limits.output_bytes)?;
    emit_remapped(&scan, &mut emitter, &mut raw, limits.pipeline.emission)?;
    let raw = raw.freeze()?;
    let mut declared = ArtifactSpool::new(limits.output_bytes)?;
    crate::target_features::write_declared_features(
        raw.bytes(),
        &mut declared,
        limits.pipeline.emission.max_metadata_section_bytes,
    )?;
    let artifact = declared.freeze()?;
    crate::native::validate(artifact.bytes())
        .context("validate guest-local continuation lowering")?;
    Ok(Some(artifact))
}

struct Emitter<'s, 'a> {
    scan: &'s Scan<'a>,
    runtime: NativeRuntime,
    activations: NativeActivations<'a>,
    declarations: FrozenDeclarations,
    module: FrozenModuleDeclarations,
    aliases: BTreeMap<u32, (u32, u32)>,
    generated: Option<generated::Generated>,
    ir_limits: IrLimits,
}

impl<'s, 'a> Emitter<'s, 'a> {
    fn plan(scan: &'s Scan<'a>, limits: PipelineLimits) -> Result<Self> {
        let budget = limits.metadata_bytes;
        let export = |suffix: &str, expected| -> Result<u32> {
            let (_, kind, index) = scan
                .exports
                .iter()
                .find(|(name, _, _)| name.strip_prefix(PREFIX) == Some(suffix))
                .with_context(|| {
                    format!("missing local continuation link symbol {PREFIX}{suffix}")
                })?;
            ensure!(*kind == expected, "wrong entity kind for {PREFIX}{suffix}");
            Ok(*index)
        };
        let local_fn = |suffix| {
            let index = export(suffix, ExternalKind::Func)?;
            ensure!(
                scan.functions[index as usize].body.is_some(),
                "{PREFIX}{suffix} is imported"
            );
            Ok(index)
        };
        let suspend = local_fn("suspend")?;
        let sdk = scan
            .exports
            .iter()
            .any(|(name, _, _)| name.strip_prefix(PREFIX) == Some("dispatch_v1"));
        let dispatch = local_fn(if sdk { "dispatch_v1" } else { "dispatch" })?;
        // These callbacks drive capture/replay and are entered with the
        // corresponding runtime state already set. Capturing their own
        // activations would recursively call the same provider.
        let boundaries: BTreeSet<_> = scan
            .exports
            .iter()
            .filter(|(name, kind, _)| name.starts_with(PREFIX) && *kind == ExternalKind::Func)
            .map(|(_, _, index)| *index)
            .collect();
        let mut reaching = scan.reaching_until([suspend], false, &boundaries)?;
        // The suspend function starts or ends replay. It is the callee of
        // the innermost saved activation and must execute normally on replay.
        reaching.activations.remove(&suspend);
        let entities = if sdk {
            LocalContinuationEntities::Generated {
                resume_slots: u32::try_from(reaching.activations.len())?
                    .checked_add(1)
                    .context("local continuation resume table overflow")?,
            }
        } else {
            LocalContinuationEntities::Linked {
                resume_table: export("resume_table", ExternalKind::Table)?,
                unwind_tag: export("unwind_tag", ExternalKind::Tag)?,
            }
        };
        let frames = LocalFrameTransport {
            reserve: local_fn("reserve")?,
            commit: local_fn("commit")?,
            next: local_fn("next")?,
            peek: local_fn("peek")?,
            resume_peek: local_fn("resume_peek")?,
            vector_begin: local_fn("vector_begin")?,
            vector_append: local_fn("vector_append")?,
            vector_finish: local_fn("vector_finish")?,
            vector_get: local_fn("vector_get")?,
            entities,
        };
        // All reference bindings are source-local. There are no appended
        // imports, so original function indices also name final functions.
        let codec = |encode, decode| -> Result<Option<CodecPair>> {
            Ok(Some(CodecPair {
                encode: local_fn(encode)?,
                decode: local_fn(decode)?,
            }))
        };
        let inputs = RuntimeInputs {
            local_frames: Some(frames),
            codecs: if sdk {
                Default::default()
            } else {
                NativeCodecOverrides {
                    funcref: codec("encode_funcref", "decode_funcref")?,
                    externref: codec("encode_externref", "decode_externref")?,
                    exnref: codec("encode_exnref", "decode_exnref")?,
                    anyref: codec("encode_anyref", "decode_anyref")?,
                    cleanup: None,
                }
            },
            helper_codecs: if sdk {
                generated::codec_bindings()
            } else {
                Default::default()
            },
            ..Default::default()
        };
        let mut runtime = NativeRuntime::plan(scan, inputs, budget)?;
        let first_type = scan.types.as_ref().core_type_count_in_module()
            + runtime.function_declarations().type_count();
        let first_function = runtime.imports_plan().helper_function_base() + CONTROLS;
        let mut module = ModuleDeclarationBuilder::from_frozen(
            scan,
            Some(runtime.imports_plan()),
            runtime.local_declarations().clone(),
            budget,
        )?;
        let generated = if sdk {
            Some(generated::Generated::plan(
                scan,
                &runtime,
                &mut module,
                first_type,
                dispatch,
                local_fn("dispatch_finish")?,
                local_fn("track_reference")?,
                local_fn("clear_reference")?,
                budget,
            )?)
        } else {
            None
        };
        let generated_types = generated
            .as_ref()
            .map_or(0, |p| p.declarations.type_count());
        let generated_functions = generated
            .as_ref()
            .map_or(0, |p| p.declarations.function_count());
        let activations = NativeActivations::plan(
            scan,
            &mut runtime,
            reaching,
            first_type + generated_types,
            first_function + generated_functions,
            ActivationModuleOptions {
                shared_codecs: true,
                ..Default::default()
            },
            limits.activations,
        )?;
        let controls = runtime.indices();
        let aliases = [
            ("unwind_begin", (controls.unwind_begin, 1)),
            ("unwind_end", (controls.unwind_end, 0)),
            ("rewind_begin", (controls.rewind_begin, 1)),
            ("rewind_end", (controls.rewind_end, 0)),
        ]
        .into_iter()
        .map(|(name, binding)| Ok((local_fn(name)?, binding)))
        .collect::<Result<_>>()?;
        let mut parts = vec![runtime.function_declarations()];
        if let Some(plan) = &generated {
            parts.push(&plan.declarations);
        }
        parts.push(activations.declarations());
        let declarations = FrozenDeclarations::concatenate(&parts, budget)?;
        let resumes: Vec<_> = activations
            .entries()
            .map(|(_, entry)| entry.resume)
            .collect();
        if let LocalContinuationEntities::Linked { resume_table, .. } = entities {
            let ty = scan.types.as_ref().table_at(resume_table);
            ensure!(
                !ty.table64 && ty.element_type == wasmparser::RefType::FUNCREF,
                "local continuation resume table must hold funcrefs with i32 indices"
            );
            ensure!(
                scan.elements.iter().all(|element| {
                    element
                        .active
                        .is_none_or(|(table, _)| table != resume_table)
                }),
                "local continuation resume table already has active elements"
            );
            ensure!(
                ty.initial > resumes.len() as u64,
                "local continuation resume table is too small"
            );
        }
        module.element(
            ElementMode::Active {
                table: controls.resume_table,
                offset: ConstExpr::i32_const(1),
            },
            ElementValues::Functions(resumes),
        )?;
        Ok(Self {
            scan,
            runtime,
            activations,
            declarations,
            module: module.freeze(),
            aliases,
            generated,
            ir_limits: limits.activations.ir,
        })
    }
}

impl NativeSourceHooks for reencode::RoundtripReencoder {}

impl Reencode for Emitter<'_, '_> {
    type Error = std::convert::Infallible;

    fn parse_export_section(
        &mut self,
        exports: &mut ExportSection,
        source: wasmparser::ExportSectionReader<'_>,
    ) -> Result<(), reencode::Error<Self::Error>> {
        for export in source {
            let export = export?;
            if !export.name.starts_with(PREFIX) {
                self.parse_export(exports, export)?;
            }
        }
        Ok(())
    }

    fn parse_custom_section(
        &mut self,
        module: &mut wasm_encoder::Module,
        section: wasmparser::CustomSectionReader<'_>,
    ) -> Result<(), reencode::Error<Self::Error>> {
        // The second pass must analyze the new identities and body offsets.
        if !section.name().starts_with(".debug_")
            && !matches!(
                section.name(),
                crate::facts::SECTION
                    | crate::facts::CODE_HASH_SECTION
                    | crate::debug_info::SECTION
            )
        {
            reencode::utils::parse_custom_section(self, module, section)?;
        }
        Ok(())
    }
}

impl FunctionTransform for Emitter<'_, '_> {
    fn imports(&self) -> Option<&FrozenImports> {
        Some(self.runtime.imports_plan())
    }
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.declarations)
    }
    fn module_declarations(&self) -> Option<&FrozenModuleDeclarations> {
        Some(&self.module)
    }
    fn function_ir_limits(&self) -> Option<IrLimits> {
        Some(self.ir_limits)
    }

    fn transform_ir(&mut self, body: &FunctionIr<'_>, limit: usize) -> Result<Function> {
        if let Some(plan) = &self.generated
            && let Some(function) = plan.replace(body.function, limit)?
        {
            return Ok(function);
        }
        if let Some(&(target, params)) = self.aliases.get(&body.function) {
            let mut function = Function::new([]);
            for i in 0..params {
                function.instruction(&Instruction::LocalGet(i));
            }
            function.instruction(&Instruction::Call(target));
            function.instruction(&Instruction::End);
            return Ok(function);
        }
        self.activations
            .emit_function(self.scan, body, &mut reencode::RoundtripReencoder, limit)
    }

    fn emit_helper(&mut self, helper: u32, limit: usize) -> Result<Function> {
        if helper < CONTROLS {
            return self.runtime.emit_control(helper, limit);
        }
        let mut ordinal = helper - CONTROLS;
        if let Some(plan) = &self.generated {
            let count = plan.declarations.function_count();
            if ordinal < count {
                return plan.emit_helper(ordinal, limit);
            }
            ordinal -= count;
        }
        self.activations.emit_helper(ordinal, limit)
    }
}
