use fork_instrument::streaming::*;
use std::collections::{BTreeMap, BTreeSet};
use wasm_encoder::{
    ExportKind, Function, Instruction, ValType,
    reencode::{Error, Reencode},
};

struct CallHooks<'a> {
    runtime: &'a mut NativeRuntime,
    routes: &'a [(ReferenceCallKind, u32)],
}
macro_rules! index {
    ($name:ident) => {
        fn $name(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
            self.runtime.$name(i)
        }
    };
}
impl Reencode for CallHooks<'_> {
    type Error = ImportIndexError;
    index!(function_index);
    index!(table_index);
    index!(memory_index);
    index!(global_index);
    index!(tag_index);
    index!(type_index);
}
impl ContinuationHooks for CallHooks<'_> {
    fn emit_continuation_call(
        &mut self,
        _: u32,
        call: &CallContinuation,
        _: &SourceInstruction<'_>,
        _: &FrameLayout,
        output: &mut Function,
        _: usize,
    ) -> anyhow::Result<()> {
        let target =
            if let Some((_, target)) = self.routes.iter().find(|(kind, _)| *kind == call.kind) {
                *target
            } else if let ReferenceCallKind::Direct(source) = call.kind {
                self.runtime.function_index(source)?
            } else {
                anyhow::bail!("fixture has no frozen route for {:?}", call.kind);
            };
        output.instruction(&Instruction::Call(target));
        Ok(())
    }
}
/// Test composition only: fixtures retain a few local plans so they can be
/// emitted twice for determinism checks. Production must discard each plan.
pub struct ActivationModule {
    pub runtime: NativeRuntime,
    pub exceptions: Option<NativeExceptionCodec>,
    pub support: FrozenActivationSupport,
    pub codecs: FrozenFrameCodecs,
    pub declarations: FrozenDeclarations,
    pub module: FrozenModuleDeclarations,
    pub plans: BTreeMap<u32, NativeActivationPlan>,
    pub emission: BTreeMap<u32, ActivationEmission>,
    pub routes: Vec<(ReferenceCallKind, u32)>,
    pub tails: BTreeMap<u32, TailTransferPlan>,
}
impl Reencode for ActivationModule {
    type Error = ImportIndexError;
    index!(function_index);
    index!(table_index);
    index!(memory_index);
    index!(global_index);
    index!(tag_index);
    index!(type_index);
}
impl FunctionTransform for ActivationModule {
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
        Some(Default::default())
    }
    fn transform_ir(&mut self, body: &FunctionIr<'_>, limit: usize) -> anyhow::Result<Function> {
        if let Some(plan) = self.plans.get(&body.function) {
            emit_native_activation(
                body,
                plan,
                self.emission[&body.function],
                &mut CallHooks {
                    runtime: &mut self.runtime,
                    routes: &self.routes,
                },
                DispatchLimits {
                    output_bytes: limit,
                    ..Default::default()
                },
            )
        } else if let Some(tails) = self.tails.get(&body.function) {
            tails.emit_function(body, &mut self.runtime, limit)
        } else {
            body.emit(self, limit)
        }
    }
    fn emit_helper(&mut self, ordinal: u32, limit: usize) -> anyhow::Result<Function> {
        if ordinal < 7 {
            return self.runtime.emit_control(ordinal, limit);
        }
        let mut ordinal = ordinal - 7;
        if let Some(exceptions) = &self.exceptions {
            let count = exceptions.declarations().function_count();
            if ordinal < count {
                return exceptions.emit_helper(ordinal, limit);
            }
            ordinal -= count;
        }
        if ordinal < self.support.declarations().function_count() {
            self.support.emit_helper(ordinal, limit)
        } else {
            self.codecs.emit_helper(
                ordinal - self.support.declarations().function_count(),
                limit,
            )
        }
    }
}

/// Linked catch fixture with one I32-to-I32 root and h.fork at source index 0.
#[allow(dead_code)] // Other integration targets use only ActivationModule.
pub fn emit_catch_fixture(
    input: &[u8],
    source_function: u32,
    shared: bool,
    with_recipes: bool,
) -> (Vec<u8>, u32) {
    let scan = scan(input).unwrap();
    let types = SourceTypes::new(&scan);
    let mut inputs = RuntimeInputs::default();
    let exception_imports = with_recipes.then(|| {
        let host = NativeExceptionImports::append(&scan, &mut inputs, 1 << 20).unwrap();
        inputs.helper_codecs.exnref = Some(CodecPair {
            encode: 7,
            decode: 8,
        });
        inputs.helper_codecs.cleanup = Some(13);
        host
    });
    let mut runtime = NativeRuntime::plan(&scan, inputs, 1 << 20).unwrap();
    let imports = runtime.imports_plan().clone();
    let mut module = ModuleDeclarationBuilder::from_frozen(
        &scan,
        Some(&imports),
        runtime.local_declarations().clone(),
        1 << 20,
    )
    .unwrap();
    let mut first_type = scan.types.as_ref().core_type_count_in_module()
        + runtime.function_declarations().type_count();
    let mut first_function = imports.helper_function_base() + 7;
    let exceptions = exception_imports.as_ref().map(|host| {
        let references = runtime.indices().codecs;
        let codec = NativeExceptionCodec::plan(
            &scan,
            &types,
            &mut runtime,
            host,
            &imports,
            references,
            &mut module,
            first_type,
            first_function,
            Default::default(),
        )
        .unwrap();
        first_type += codec.declarations().type_count();
        first_function += codec.declarations().function_count();
        codec
    });
    let environment = FrameEnvironment::discover(&scan, &mut runtime, 1 << 20).unwrap();
    let body = scan
        .body_provider(Default::default())
        .load(source_function)
        .unwrap();
    let mut plan = NativeActivationPlan::plan(
        &scan,
        &body,
        &types,
        &mut runtime,
        environment,
        &BTreeSet::from([0]),
        Default::default(),
    )
    .unwrap();
    assert!(!plan.catches.regions.is_empty());
    assert!(plan.catches.selector.is_some());
    if with_recipes {
        let kinds = FrozenReferenceKinds::new(&scan, &mut runtime, 1 << 20).unwrap();
        plan.bind_reference_io(&kinds, 1 << 20).unwrap();
    } else {
        assert!(plan.continuation.references.slots.is_empty());
    }
    let catch_offset = plan
        .continuation
        .frame
        .catch
        .iter()
        .flat_map(|arm| &arm.fields)
        .next()
        .map_or(0, |field| field.offset);
    let mut support = ActivationSupportCatalog::new(
        environment,
        runtime.indices(),
        runtime.frames_start_offset(),
        first_type,
        first_function,
        1 << 20,
    )
    .unwrap();
    let frame_select = support.frame_select();
    let transport = support
        .transport(
            ActivationCallTarget::Direct(0),
            &[ValType::I32],
            &[ValType::I32],
        )
        .unwrap();
    let resume = support
        .resume_thunk(
            runtime.function_index(source_function).unwrap(),
            &[ValType::I32],
            &plan.results,
            &plan.continuation.frame,
        )
        .unwrap();
    let result_block = support.result_block(&plan.results).unwrap();
    plan.catches.bind_types(&mut support).unwrap();
    let support = support.freeze().unwrap();
    plan.catches.bind_frozen_types(&support).unwrap();
    let mut codecs = FrameCodecCatalog::new(
        environment,
        runtime.indices(),
        first_type + support.declarations().type_count(),
        first_function + support.declarations().function_count(),
        1 << 20,
    )
    .unwrap();
    let shape = plan
        .continuation
        .frame
        .codec_shape(true, &plan.continuation.references)
        .unwrap();
    assert!(
        !shape.commits,
        "catch payload must be complete before commit"
    );
    let pair = codecs.request(&shape).unwrap();
    let codecs = codecs.freeze().unwrap();
    let mut parts = vec![runtime.function_declarations()];
    if let Some(exceptions) = &exceptions {
        parts.push(exceptions.declarations());
    }
    parts.extend([support.declarations(), codecs.declarations()]);
    let declarations = FrozenDeclarations::concatenate(&parts, 1 << 20).unwrap();
    module
        .export("unwind_tag", ExportKind::Tag, runtime.indices().unwind_tag)
        .unwrap();
    module
        .export("resume_root", ExportKind::Func, resume)
        .unwrap();
    let emission = ActivationEmission {
        runtime: runtime.indices(),
        frame_select,
        function_ordinal: 0,
        result_block,
        scalar_codecs: shared.then_some(pair),
        boundary: None,
    };
    let mut transform = ActivationModule {
        runtime,
        exceptions,
        support,
        codecs,
        declarations,
        module: module.freeze(),
        plans: BTreeMap::from([(source_function, plan)]),
        emission: BTreeMap::from([(source_function, emission)]),
        routes: vec![(ReferenceCallKind::Direct(0), transport)],
        tails: BTreeMap::new(),
    };
    let mut output = Vec::new();
    emit_remapped(&scan, &mut transform, &mut output, Default::default()).unwrap();
    if let Some(codec) = &transform.exceptions {
        let mut metadata = wasm_encoder::Module::new();
        metadata.section(&wasm_encoder::CustomSection {
            name: fork_instrument::module_exception_codec::FORMAT_SECTION.into(),
            data: codec.descriptor().unwrap().into(),
        });
        output.extend_from_slice(&metadata.finish()[8..]);
    }
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    (output, catch_offset)
}
