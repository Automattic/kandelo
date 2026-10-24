//! Scalar-only host dependencies reserved before runtime import freezing.
use super::*;

pub struct NativeExceptionImports {
    activation: ActivationImport,
    functions: [u32; 11],
}
enum ActivationImport {
    Source(u32),
    Planned(u32),
}
#[derive(Clone, Copy)]
pub(super) struct ExceptionHost {
    pub activation: u32,
    pub lookup: u32,
    pub claim: u32,
    pub define: u32,
    pub load: u32,
    pub route: u32,
    pub cache_index: u32,
    pub broker_encode: u32,
    pub broker_throw: u32,
    pub ingress_throw: u32,
    pub reserve: u32,
    pub release: u32,
}
impl NativeExceptionImports {
    pub fn append(scan: &Scan<'_>, inputs: &mut RuntimeInputs, budget: usize) -> Result<Self> {
        ensure!(
            inputs
                .imports
                .len()
                .checked_add(12)
                .is_some_and(|count| count <= budget / 256),
            "exception imports exceed metadata budget"
        );
        let pointer = if scan.types.as_ref().memory_count() != 0
            && scan.types.as_ref().memory_at(0).memory64
        {
            ValType::I64
        } else {
            ValType::I32
        };
        let activation = activation_import(scan, inputs)?;
        let mut functions = [0; 11];
        let i = ValType::I32;
        let transfer = vec![i, i, i, i, pointer, i, pointer, i];
        for (ordinal, (name, params, results)) in [
            (abi::IMPORT_LOOKUP, vec![i], vec![i]),
            (abi::IMPORT_CLAIM, vec![i], vec![i]),
            (abi::IMPORT_DEFINE, transfer.clone(), vec![]),
            (abi::IMPORT_LOAD, transfer, vec![i]),
            (abi::IMPORT_ROUTE, vec![i, i], vec![i]),
            (abi::IMPORT_CACHE_INDEX, vec![i], vec![i]),
            (abi::IMPORT_BROKER_ENCODE, vec![i], vec![i]),
            (abi::IMPORT_BROKER_THROW_RECIPE, vec![i], vec![]),
            (abi::IMPORT_INGRESS_THROW, vec![i], vec![]),
            (abi::IMPORT_SCRATCH_RESERVE, vec![pointer], vec![pointer]),
            (abi::IMPORT_SCRATCH_RELEASE, vec![pointer, pointer], vec![]),
        ]
        .into_iter()
        .enumerate()
        {
            ensure!(
                inputs.imports.len() < budget / 256,
                "exception imports exceed metadata budget"
            );
            let ty = type_index(
                &mut inputs.types,
                scan.types.as_ref().core_type_count_in_module(),
                &params,
                &results,
                budget,
            )?;
            functions[ordinal] = u32::try_from(inputs.imports.len())?;
            inputs.imports.push(PlannedImport {
                module: abi::HOST_IMPORT_MODULE.into(),
                name: name.into(),
                ty: EntityType::Function(ty),
            });
        }
        Ok(Self {
            activation,
            functions,
        })
    }
    pub(super) fn resolve(&self, imports: &FrozenImports) -> Result<ExceptionHost> {
        let index = |ordinal| {
            imports
                .index(ordinal)
                .context("exception import was not frozen")
        };
        Ok(ExceptionHost {
            activation: match self.activation {
                // Appended imports never shift earlier imported globals.
                ActivationImport::Source(index) => index,
                ActivationImport::Planned(ordinal) => index(ordinal)?,
            },
            lookup: index(self.functions[0])?,
            claim: index(self.functions[1])?,
            define: index(self.functions[2])?,
            load: index(self.functions[3])?,
            route: index(self.functions[4])?,
            cache_index: index(self.functions[5])?,
            broker_encode: index(self.functions[6])?,
            broker_throw: index(self.functions[7])?,
            ingress_throw: index(self.functions[8])?,
            reserve: index(self.functions[9])?,
            release: index(self.functions[10])?,
        })
    }
}

fn activation_import(scan: &Scan<'_>, inputs: &mut RuntimeInputs) -> Result<ActivationImport> {
    let mut global_index = 0u32;
    for payload in wasmparser::Parser::new(0).parse_all(scan.input()) {
        if let wasmparser::Payload::ImportSection(section) = payload? {
            for import in section.into_imports() {
                let import = import?;
                if import.module == abi::HOST_IMPORT_MODULE && import.name == abi::IMPORT_ACTIVATION
                {
                    ensure!(
                        matches!(import.ty, wasmparser::TypeRef::Global(global)
                        if global.content_type == wasmparser::ValType::I32 && !global.mutable && !global.shared),
                        "exception activation import must be an immutable i32 global"
                    );
                    return Ok(ActivationImport::Source(global_index));
                }
                if matches!(import.ty, wasmparser::TypeRef::Global(_)) {
                    global_index += 1;
                }
            }
        }
    }
    if let Some((ordinal, import)) = inputs.imports.iter().enumerate().find(|(_, import)| {
        import.module == abi::HOST_IMPORT_MODULE && import.name == abi::IMPORT_ACTIVATION
    }) {
        ensure!(
            matches!(import.ty, EntityType::Global(global) if global.val_type == ValType::I32 && !global.mutable && !global.shared),
            "planned exception activation import must be an immutable i32 global"
        );
        return Ok(ActivationImport::Planned(u32::try_from(ordinal)?));
    }
    let ordinal = u32::try_from(inputs.imports.len())?;
    inputs.imports.push(PlannedImport {
        module: abi::HOST_IMPORT_MODULE.into(),
        name: abi::IMPORT_ACTIVATION.into(),
        ty: EntityType::Global(GlobalType {
            val_type: ValType::I32,
            mutable: false,
            shared: false,
        }),
    });
    Ok(ActivationImport::Planned(ordinal))
}
