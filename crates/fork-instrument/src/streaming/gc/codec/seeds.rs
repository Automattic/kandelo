//! Temporary typed inhabitants for mutable non-GC fields. They never enter
//! original function/tag catalogs and are replaced during the fill phase.
use super::super::provenance::signatures::Signatures;
use super::*;
use wasm_encoder::{AbstractHeapType, HeapType, TagKind, TagType};

pub(super) struct Seeds {
    functions: BTreeMap<u32, u32>,
    abstract_func: u32,
    exception: u32,
    exception_ordinal: u32,
    tag_type: u32,
    pub tag: Option<u32>,
}
#[derive(Clone, Copy)]
pub(super) enum Seed {
    Function(u32),
    External,
    Exception(u32),
    Uninhabited,
}
impl Seeds {
    pub fn reserve(
        plan: &NativeGcPlan,
        inputs: &mut RuntimeInputs,
        signatures: &mut Signatures,
        functions: &mut Vec<u32>,
        budget: &mut Budget,
    ) -> Result<Self> {
        budget.charge(1024)?;
        let tag_type = signatures.intern(inputs, vec![], vec![])?;
        let abstract_func = u32::try_from(functions.len())?;
        functions.push(tag_type);
        let mut concrete = BTreeMap::new();
        for layout in &plan.layouts {
            budget.step(layout.fields.len().saturating_add(1))?;
            for field in &layout.fields {
                if field.class != Some(NativeReferenceClass::Func) {
                    continue;
                }
                if let StorageType::Val(ValType::Ref(reference)) = field.field.element_type {
                    if let HeapType::Concrete(ty) | HeapType::Exact(ty) = reference.heap_type {
                        if !concrete.contains_key(&ty) {
                            budget.charge(128)?;
                            concrete.insert(ty, u32::try_from(functions.len())?);
                            // Keep the original nominal function type. Recreating
                            // a signature can lose recursive/subtype identity.
                            functions.push(ty);
                        }
                    }
                }
            }
        }
        let exception_ordinal = u32::try_from(functions.len())?;
        functions.push(signatures.intern(
            inputs,
            vec![],
            vec![ValType::Ref(RefType {
                nullable: false,
                heap_type: RefType::EXNREF.heap_type,
            })],
        )?);
        Ok(Self {
            functions: concrete,
            abstract_func,
            exception: exception_ordinal,
            exception_ordinal,
            tag_type,
            tag: None,
        })
    }
    pub fn freeze(
        &mut self,
        first: u32,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
    ) -> Result<()> {
        let index = |ordinal: u32| {
            first
                .checked_add(ordinal)
                .context("GC seed function index overflow")
        };
        self.abstract_func = index(self.abstract_func)?;
        self.exception = index(self.exception)?;
        for function in self.functions.values_mut() {
            *function = index(*function)?;
        }
        self.tag = Some(module.tag(TagType {
            kind: TagKind::Exception,
            func_type_idx: self.tag_type,
        })?);
        let values = std::iter::once(self.abstract_func)
            .chain(self.functions.values().copied())
            .collect();
        module.element(ElementMode::Declared, ElementValues::Functions(values))?;
        Ok(())
    }
    pub fn get(&self, reference: RefType) -> Result<Seed> {
        Ok(match reference.heap_type {
            HeapType::Concrete(ty) | HeapType::Exact(ty) if self.functions.contains_key(&ty) => {
                Seed::Function(self.functions[&ty])
            }
            HeapType::Abstract {
                ty: AbstractHeapType::Func,
                ..
            } => Seed::Function(self.abstract_func),
            HeapType::Abstract {
                ty: AbstractHeapType::Extern,
                ..
            } => Seed::External,
            HeapType::Abstract {
                ty: AbstractHeapType::Exn,
                ..
            } => Seed::Exception(self.exception),
            _ => Seed::Uninhabited,
        })
    }
    pub fn is_exception(&self, ordinal: u32) -> bool {
        ordinal == self.exception_ordinal
    }
}
