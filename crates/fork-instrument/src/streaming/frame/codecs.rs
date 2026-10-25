//! Interned scalar frame I/O helpers; recipes retain no source instructions.
use super::{
    FRAME_CALL_OFFSET, FRAME_CATCH_OFFSET, FRAME_FUNCTION_OFFSET, FRAME_HEADER_SIZE,
    FRAME_REFERENCE_OFFSET, FrameCodecShape, FrameEnvironment, scalar_size,
};
use crate::streaming::{
    FrozenDeclarations, NativeRuntimeIndices,
    runtime::{load, store},
};
use anyhow::{Context, Result, ensure};
use std::collections::BTreeMap;
use wasm_encoder::{FuncType, Function, Instruction, MemArg, ValType};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameCodecPair {
    pub save: u32,
    pub restore: u32,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Recipe {
    Save {
        scalars: Vec<ValType>,
        selector: bool,
        commits: bool,
    },
    Restore {
        scalars: Vec<ValType>,
        selector: bool,
    },
}

pub struct FrameCodecCatalog {
    environment: FrameEnvironment,
    runtime: NativeRuntimeIndices,
    first_type: u32,
    first_function: u32,
    types: Vec<FuncType>,
    functions: Vec<u32>,
    recipes: Vec<Recipe>,
    helpers: BTreeMap<Recipe, u32>,
    signatures: BTreeMap<(Vec<ValType>, Vec<ValType>), u32>,
    estimated: usize,
    budget: usize,
}

impl FrameCodecCatalog {
    pub fn new(
        environment: FrameEnvironment,
        runtime: NativeRuntimeIndices,
        first_type: u32,
        first_function: u32,
        budget: usize,
    ) -> Result<Self> {
        ensure!(
            environment.memory.is_some()
                && matches!(environment.pointer, ValType::I32 | ValType::I64),
            "frame codecs require the primary linear memory"
        );
        Ok(Self {
            environment,
            runtime,
            first_type,
            first_function,
            types: Vec::new(),
            functions: Vec::new(),
            recipes: Vec::new(),
            helpers: BTreeMap::new(),
            signatures: BTreeMap::new(),
            estimated: 0,
            budget,
        })
    }
    pub fn request(&mut self, shape: &FrameCodecShape) -> Result<FrameCodecPair> {
        ensure!(
            shape.scalars.len() <= 900
                && shape
                    .scalars
                    .iter()
                    .all(|ty| !matches!(ty, ValType::Ref(_))),
            "invalid scalar frame codec shape"
        );
        ensure!(
            shape.restored_scalars == usize::from(!shape.catch_selector).min(shape.scalars.len()),
            "frame restore must return at most one value"
        );
        let save = Recipe::Save {
            scalars: shape.scalars.clone(),
            selector: shape.catch_selector,
            commits: shape.commits,
        };
        let restore = Recipe::Restore {
            scalars: shape.scalars.clone(),
            selector: shape.catch_selector,
        };
        let missing = [&save, &restore]
            .into_iter()
            .filter(|key| !self.helpers.contains_key(*key))
            .count();
        let charge = shape
            .scalars
            .len()
            .checked_mul(std::mem::size_of::<ValType>().saturating_mul(16).max(128))
            .and_then(|n| n.checked_add(512))
            .and_then(|n| n.checked_mul(missing))
            .context("frame codec metadata overflow")?;
        let estimated = self
            .estimated
            .checked_add(charge)
            .context("frame codec metadata overflow")?;
        ensure!(
            estimated <= self.budget,
            "frame codecs exceed metadata budget"
        );
        let total = u32::try_from(
            self.recipes
                .len()
                .checked_add(missing)
                .context("frame codec count overflow")?,
        )?;
        self.first_function
            .checked_add(total)
            .context("frame codec function index overflow")?;
        self.first_type
            .checked_add(u32::try_from(
                self.types
                    .len()
                    .checked_add(missing)
                    .context("frame codec type count overflow")?,
            )?)
            .context("frame codec type index overflow")?;
        self.estimated = estimated;
        let save = self.intern(save);
        let restore = self.intern(restore);
        Ok(FrameCodecPair { save, restore })
    }
    fn intern(&mut self, recipe: Recipe) -> u32 {
        if let Some(&index) = self.helpers.get(&recipe) {
            return index;
        }
        let (params, results) = match &recipe {
            Recipe::Save {
                scalars, selector, ..
            } => {
                let mut params = vec![ValType::I32];
                if *selector {
                    params.push(ValType::I32);
                }
                params.extend_from_slice(scalars);
                (params, vec![])
            }
            Recipe::Restore { scalars, selector } => {
                let results = if *selector {
                    vec![ValType::I32]
                } else {
                    scalars.first().copied().into_iter().collect()
                };
                (vec![self.environment.pointer], results)
            }
        };
        let signature = (params, results);
        let ty = if let Some(&index) = self.signatures.get(&signature) {
            index
        } else {
            let index = self.first_type + self.types.len() as u32;
            self.types.push(FuncType::new(
                signature.0.iter().copied(),
                signature.1.iter().copied(),
            ));
            self.signatures.insert(signature, index);
            index
        };
        let index = self.first_function + self.recipes.len() as u32;
        self.functions.push(ty);
        self.recipes.push(recipe.clone());
        self.helpers.insert(recipe, index);
        index
    }
    pub fn freeze(self) -> Result<FrozenFrameCodecs> {
        Ok(FrozenFrameCodecs {
            declarations: FrozenDeclarations::new(self.types, self.functions, self.budget)?,
            recipes: self.recipes,
            environment: self.environment,
            runtime: self.runtime,
            helpers: self.helpers,
        })
    }
}

pub struct FrozenFrameCodecs {
    declarations: FrozenDeclarations,
    recipes: Vec<Recipe>,
    environment: FrameEnvironment,
    runtime: NativeRuntimeIndices,
    helpers: BTreeMap<Recipe, u32>,
}
impl FrozenFrameCodecs {
    /// Resolve a shape while rebuilding one activation during emission.
    /// This lookup cannot extend the frozen declaration catalog.
    pub fn lookup(&self, shape: &FrameCodecShape) -> Result<FrameCodecPair> {
        ensure!(
            shape.scalars.len() <= 900
                && shape
                    .scalars
                    .iter()
                    .all(|ty| !matches!(ty, ValType::Ref(_))),
            "invalid scalar frame codec shape"
        );
        ensure!(
            shape.restored_scalars == usize::from(!shape.catch_selector).min(shape.scalars.len()),
            "frame restore must return at most one value"
        );
        let save = Recipe::Save {
            scalars: shape.scalars.clone(),
            selector: shape.catch_selector,
            commits: shape.commits,
        };
        let restore = Recipe::Restore {
            scalars: shape.scalars.clone(),
            selector: shape.catch_selector,
        };
        Ok(FrameCodecPair {
            save: *self
                .helpers
                .get(&save)
                .context("frame save shape was not frozen")?,
            restore: *self
                .helpers
                .get(&restore)
                .context("frame restore shape was not frozen")?,
        })
    }
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        let recipe = self
            .recipes
            .get(ordinal as usize)
            .context("unknown scalar frame codec helper")?;
        let memory = self.environment.memory.unwrap();
        let pointer = self.environment.pointer;
        let r = self.runtime;
        let arg = |ty, offset| MemArg {
            offset,
            align: scalar_size(ty).trailing_zeros(),
            memory_index: memory,
        };
        let mut f = Function::new([(1, pointer)]);
        match recipe {
            Recipe::Save {
                scalars,
                selector,
                commits,
            } => {
                let first_scalar = if *selector { 2 } else { 1 };
                let frame = first_scalar + scalars.len() as u32;
                f.instruction(&Instruction::GlobalGet(r.buf_global));
                f.instruction(&load(pointer, arg(pointer, 0)));
                f.instruction(&Instruction::LocalSet(frame));
                f.instruction(&Instruction::LocalGet(frame));
                f.instruction(&Instruction::LocalGet(0));
                f.instruction(&store(
                    ValType::I32,
                    arg(ValType::I32, FRAME_FUNCTION_OFFSET),
                ));
                f.instruction(&Instruction::LocalGet(frame));
                f.instruction(&if *selector {
                    Instruction::LocalGet(1)
                } else {
                    Instruction::I32Const(0)
                });
                f.instruction(&store(ValType::I32, arg(ValType::I32, FRAME_CATCH_OFFSET)));
                f.instruction(&Instruction::LocalGet(frame));
                f.instruction(&Instruction::I32Const(0));
                f.instruction(&store(
                    ValType::I32,
                    arg(ValType::I32, FRAME_REFERENCE_OFFSET),
                ));
                let mut offset = FRAME_HEADER_SIZE;
                for (i, &ty) in scalars.iter().enumerate() {
                    f.instruction(&Instruction::LocalGet(frame));
                    f.instruction(&Instruction::LocalGet(first_scalar + i as u32));
                    f.instruction(&store(ty, arg(ty, u64::from(offset))));
                    offset += scalar_size(ty);
                    ensure!(
                        f.byte_len() <= limit,
                        "scalar frame codec exceeds output budget"
                    );
                }
                if *commits {
                    f.instruction(&Instruction::LocalGet(frame));
                    f.instruction(&Instruction::Call(r.frame_commit));
                }
            }
            Recipe::Restore { scalars, selector } => {
                f.instruction(&Instruction::GlobalGet(r.buf_global));
                f.instruction(&Instruction::LocalGet(0));
                f.instruction(&Instruction::Call(r.frame_next));
                f.instruction(&Instruction::LocalTee(1));
                f.instruction(&store(pointer, arg(pointer, 0)));
                f.instruction(&Instruction::LocalGet(1));
                f.instruction(&load(ValType::I32, arg(ValType::I32, FRAME_CALL_OFFSET)));
                f.instruction(&Instruction::GlobalSet(r.call_index_global));
                f.instruction(&Instruction::LocalGet(1));
                f.instruction(&Instruction::GlobalSet(r.frame_global));
                if *selector {
                    f.instruction(&Instruction::LocalGet(1));
                    f.instruction(&load(ValType::I32, arg(ValType::I32, FRAME_CATCH_OFFSET)));
                } else if let Some(&ty) = scalars.first() {
                    f.instruction(&Instruction::LocalGet(1));
                    f.instruction(&load(ty, arg(ty, u64::from(FRAME_HEADER_SIZE))));
                }
            }
        }
        f.instruction(&Instruction::End);
        ensure!(
            f.byte_len() <= limit,
            "scalar frame codec exceeds output budget"
        );
        Ok(f)
    }
}
