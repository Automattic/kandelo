//! One process-memory binding shared by runtime controls and typed providers.
//! A memoryless source can receive an explicit staging import before freezing.
use super::{FrozenImports, RuntimeInputs, Scan};
use anyhow::{Context, Result, ensure};
use wasm_encoder::{EntityType, MemoryType, ValType};

#[derive(Clone, Copy)]
pub(super) struct ProcessMemory {
    imported: Option<(u32, MemoryType)>,
    pub pointer: ValType,
}
impl RuntimeInputs {
    pub(super) fn process_memory_binding(&self, scan: &Scan<'_>) -> Result<Option<ProcessMemory>> {
        let types = scan.types.as_ref();
        if let Some(ordinal) = self.staging_memory {
            ensure!(
                types.memory_count() == 0,
                "staging memory cannot replace source memory"
            );
            let import = self
                .imports
                .get(ordinal as usize)
                .context("unknown staging memory import")?;
            let EntityType::Memory(memory) = import.ty else {
                anyhow::bail!("staging import is not a memory")
            };
            return Ok(Some(ProcessMemory {
                imported: Some((ordinal, memory)),
                pointer: if memory.memory64 {
                    ValType::I64
                } else {
                    ValType::I32
                },
            }));
        }
        Ok((types.memory_count() != 0).then(|| ProcessMemory {
            imported: None,
            pointer: if types.memory_at(0).memory64 {
                ValType::I64
            } else {
                ValType::I32
            },
        }))
    }
}
impl ProcessMemory {
    pub fn resolve(self, imports: &FrozenImports) -> Result<u32> {
        if let Some((ordinal, expected)) = self.imported {
            let (index, actual) = imports.memory_import(ordinal)?;
            ensure!(
                actual == expected,
                "process-memory import changed after reservation"
            );
            Ok(index)
        } else {
            Ok(imports.mapped_memory_index(0)?)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::streaming::{NativeRuntime, PlannedImport, scan};
    fn memory() -> MemoryType {
        MemoryType {
            minimum: 0,
            maximum: Some(65536),
            memory64: true,
            shared: true,
            page_size_log2: None,
        }
    }
    #[test]
    fn planned_memory_rejects_wrong_entities_source_overrides_and_changed_types() {
        let input = wat::parse_str("(module)").unwrap();
        let scan = scan(&input).unwrap();
        let mut inputs = RuntimeInputs {
            staging_memory: Some(0),
            ..Default::default()
        };
        assert!(
            inputs
                .process_memory_binding(&scan)
                .err()
                .unwrap()
                .to_string()
                .contains("unknown staging")
        );
        inputs.imports.push(PlannedImport {
            module: "env".into(),
            name: "memory".into(),
            ty: EntityType::Function(0),
        });
        assert!(
            inputs
                .process_memory_binding(&scan)
                .err()
                .unwrap()
                .to_string()
                .contains("not a memory")
        );
        inputs.imports[0].ty = EntityType::Memory(memory());
        let binding = inputs.process_memory_binding(&scan).unwrap().unwrap();
        let mut changed = memory();
        changed.minimum = 1;
        inputs.imports[0].ty = EntityType::Memory(changed);
        let frozen = FrozenImports::new(&scan, inputs.imports.clone(), 1 << 20).unwrap();
        assert!(
            binding
                .resolve(&frozen)
                .err()
                .unwrap()
                .to_string()
                .contains("changed after reservation")
        );
        let source = wat::parse_str("(module (memory 1))").unwrap();
        let source = self::scan(&source).unwrap();
        assert!(
            inputs
                .process_memory_binding(&source)
                .err()
                .unwrap()
                .to_string()
                .contains("cannot replace source")
        );
    }
    #[test]
    fn staged_frame_environment_uses_process_width_without_inventing_source_scratch() {
        let input = wat::parse_str(
            "(module (global (export \"__stack_pointer\") (mut i32) (i32.const 1024)))",
        )
        .unwrap();
        let scan = scan(&input).unwrap();
        let inputs = RuntimeInputs {
            staging_memory: Some(0),
            imports: vec![PlannedImport {
                module: "env".into(),
                name: "memory".into(),
                ty: EntityType::Memory(memory()),
            }],
            ..Default::default()
        };
        let mut runtime = NativeRuntime::plan(&scan, inputs, 1 << 20).unwrap();
        let environment = runtime.frame_environment(&scan, 1 << 20).unwrap();
        assert_eq!(environment.memory, Some(0));
        assert_eq!(environment.pointer, ValType::I64);
        assert_eq!(environment.stack_pointer, None);
    }
}
