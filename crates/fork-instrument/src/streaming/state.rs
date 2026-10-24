//! Function-local port of the oracle's table barriers and segment-drop
//! tracking. Catalog ownership, snapshots and bootstrap planning remain a
//! separate module-wide pass; this module consumes their frozen hook indices.

use super::{FrozenDeclarations, FunctionIr, Scan, SourceTypes};
use anyhow::{Context, Result, ensure};
use std::collections::{BTreeMap, BTreeSet};
use wasm_encoder::{FuncType, Function, Instruction, reencode::Reencode};
use wasmparser::{Operator, Parser, Payload, ValType};

#[derive(Clone, Copy, Debug)]
pub struct TableMarkers {
    /// `(first: i64, count: i64) -> ()`, after a successful mutation.
    pub mark: u32,
    /// `(old_size_or_failure: i64, delta: i64) -> ()`.
    pub grow: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct DropBit {
    pub global: u32,
    pub mask: u32,
}

/// Hook indices are already final output indices. Original table/segment keys
/// remain in the source index spaces, independent of the output remapping.
#[derive(Clone, Debug)]
pub struct StateHooks {
    pub mutation_begin: u32,
    pub reconcile: u32,
    pub tables: BTreeMap<u32, TableMarkers>,
    pub data: BTreeMap<u32, DropBit>,
    pub elements: BTreeMap<u32, DropBit>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Key {
    Set(u32),
    Fill(u32),
    Copy { src: u32, dst: u32 },
    Init { table: u32, elem: u32 },
    Grow(u32),
    Get(u32),
    Size(u32),
    Indirect { table: u32, ty: u32 },
    TailIndirect { table: u32, ty: u32 },
}

impl Key {
    fn from_op(
        op: &Operator<'_>,
        synchronized: &BTreeSet<u32>,
        resume_table: Option<u32>,
    ) -> Option<Self> {
        Some(match *op {
            Operator::TableSet { table } => Self::Set(table),
            Operator::TableFill { table } => Self::Fill(table),
            Operator::TableCopy {
                src_table,
                dst_table,
            } => Self::Copy {
                src: src_table,
                dst: dst_table,
            },
            Operator::TableInit { table, elem_index } => Self::Init {
                table,
                elem: elem_index,
            },
            Operator::TableGrow { table } => Self::Grow(table),
            Operator::TableGet { table }
                if synchronized.contains(&table) && Some(table) != resume_table =>
            {
                Self::Get(table)
            }
            Operator::TableSize { table }
                if synchronized.contains(&table) && Some(table) != resume_table =>
            {
                Self::Size(table)
            }
            Operator::CallIndirect {
                type_index,
                table_index,
            } if synchronized.contains(&table_index) && Some(table_index) != resume_table => {
                Self::Indirect {
                    table: table_index,
                    ty: type_index,
                }
            }
            Operator::ReturnCallIndirect {
                type_index,
                table_index,
            } if synchronized.contains(&table_index) && Some(table_index) != resume_table => {
                Self::TailIndirect {
                    table: table_index,
                    ty: type_index,
                }
            }
            _ => return None,
        })
    }

    fn mutation_table(self) -> Option<u32> {
        match self {
            Self::Set(t) | Self::Fill(t) | Self::Grow(t) => Some(t),
            Self::Copy { dst, .. } => Some(dst),
            Self::Init { table, .. } => Some(table),
            _ => None,
        }
    }
}

/// Discover all source operation shapes before assigning any helper indices.
/// No activation filter is accepted: functions outside the fork closure need
/// exactly the same table/segment tracking as functions inside it.
pub struct StateRewrites {
    keys: BTreeSet<Key>,
    synchronized: BTreeSet<u32>,
    resume_table: Option<u32>,
}

impl StateRewrites {
    pub fn discover(
        scan: &Scan<'_>,
        synchronized: BTreeSet<u32>,
        resume_table: Option<u32>,
        helper_limit: usize,
    ) -> Result<Self> {
        let tables = scan.types.as_ref().table_count();
        ensure!(
            synchronized.iter().all(|&t| t < tables) && resume_table.is_none_or(|t| t < tables),
            "unknown table in state plan"
        );
        let mut keys = BTreeSet::new();
        for payload in Parser::new(0).parse_all(scan.input()) {
            if let Payload::CodeSectionEntry(body) = payload? {
                let mut reader = body.get_operators_reader()?;
                while !reader.eof() {
                    if let Some(key) = Key::from_op(&reader.read()?, &synchronized, resume_table) {
                        if !keys.contains(&key) {
                            ensure!(
                                keys.len() < helper_limit,
                                "state rewrite exceeds helper budget"
                            );
                            keys.insert(key);
                        }
                    }
                }
            }
        }
        Ok(Self {
            keys,
            synchronized,
            resume_table,
        })
    }

    pub fn helper_count(&self) -> usize {
        self.keys.len()
    }

    /// First indices follow all source/private declarations already planned
    /// by the caller. This consumes discovery, making subsequent declaration
    /// changes unavailable to the body rewrite API.
    pub fn freeze<T: Reencode + ?Sized>(
        self,
        scan: &Scan<'_>,
        map: &mut T,
        first_type: u32,
        first_function: u32,
        hooks: StateHooks,
        metadata_budget: usize,
    ) -> Result<FrozenStateRewrites>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        for bit in hooks.data.values().chain(hooks.elements.values()) {
            ensure!(
                bit.mask.is_power_of_two(),
                "segment tracker mask must name one bit"
            );
        }
        let types = scan.types.as_ref();
        let source_types = SourceTypes::new(scan);
        let index_type = |t| {
            if types.table_at(t).table64 {
                ValType::I64
            } else {
                ValType::I32
            }
        };
        let reference = |t| ValType::Ref(types.table_at(t).element_type);
        let mut signatures = Vec::new();
        let mut functions = Vec::new();
        let mut helpers = Vec::new();
        let mut calls = BTreeMap::new();
        let mut values = 0usize;
        for (ordinal, &key) in self.keys.iter().enumerate() {
            let (params, results) = match key {
                Key::Set(t) => (vec![index_type(t), reference(t)], vec![]),
                Key::Fill(t) => (vec![index_type(t), reference(t), index_type(t)], vec![]),
                Key::Copy { src, dst } => {
                    let count = if types.table_at(src).table64 && types.table_at(dst).table64 {
                        ValType::I64
                    } else {
                        ValType::I32
                    };
                    (vec![index_type(dst), index_type(src), count], vec![])
                }
                Key::Init { table, .. } => {
                    (vec![index_type(table), ValType::I32, ValType::I32], vec![])
                }
                Key::Grow(t) => (vec![reference(t), index_type(t)], vec![index_type(t)]),
                Key::Get(t) => (vec![index_type(t)], vec![reference(t)]),
                Key::Size(t) => (vec![], vec![index_type(t)]),
                Key::Indirect { table, ty } | Key::TailIndirect { table, ty } => {
                    let ty = types
                        .get(types.core_type_at_in_module(ty))
                        .unwrap()
                        .composite_type
                        .unwrap_func();
                    ensure!(
                        ty.params().len() + ty.results().len()
                            < (metadata_budget / 16).saturating_sub(values),
                        "state helpers exceed metadata budget"
                    );
                    let mut params = ty.params().to_vec();
                    params.push(index_type(table));
                    (params, ty.results().to_vec())
                }
            };
            values = values
                .checked_add(params.len() + results.len())
                .context("state helper signature overflow")?;
            ensure!(
                values <= metadata_budget / 16,
                "state helpers exceed metadata budget"
            );
            let mapped_params = params
                .iter()
                .map(|&ty| source_types.value_type(map, ty))
                .collect::<Result<Vec<_>>>()?;
            let mapped_results = results
                .iter()
                .map(|&ty| source_types.value_type(map, ty))
                .collect::<Result<Vec<_>>>()?;
            signatures.push(FuncType::new(mapped_params, mapped_results));
            let ordinal = u32::try_from(ordinal)?;
            functions.push(
                first_type
                    .checked_add(ordinal)
                    .context("state helper type index overflow")?,
            );
            calls.insert(
                key,
                first_function
                    .checked_add(ordinal)
                    .context("state helper function index overflow")?,
            );
            let operation = match key {
                Key::Set(t) => Instruction::TableSet(map.table_index(t)?),
                Key::Fill(t) => Instruction::TableFill(map.table_index(t)?),
                Key::Copy { src, dst } => Instruction::TableCopy {
                    src_table: map.table_index(src)?,
                    dst_table: map.table_index(dst)?,
                },
                Key::Init { table, elem } => Instruction::TableInit {
                    table: map.table_index(table)?,
                    elem_index: map.element_index(elem)?,
                },
                Key::Grow(t) => Instruction::TableGrow(map.table_index(t)?),
                Key::Get(t) => Instruction::TableGet(map.table_index(t)?),
                Key::Size(t) => Instruction::TableSize(map.table_index(t)?),
                Key::Indirect { table, ty } => Instruction::CallIndirect {
                    table_index: map.table_index(table)?,
                    type_index: map.type_index(ty)?,
                },
                Key::TailIndirect { table, ty } => Instruction::ReturnCallIndirect {
                    table_index: map.table_index(table)?,
                    type_index: map.type_index(ty)?,
                },
            };
            let marker = key
                .mutation_table()
                .map(|t| {
                    hooks
                        .tables
                        .get(&t)
                        .copied()
                        .context("missing source table dirty marker")
                })
                .transpose()?;
            helpers.push(Helper {
                key,
                params,
                operation,
                marker,
            });
        }
        let declarations = FrozenDeclarations::new(signatures, functions, metadata_budget)?;
        Ok(FrozenStateRewrites {
            declarations,
            helpers,
            calls,
            synchronized: self.synchronized,
            resume_table: self.resume_table,
            hooks,
        })
    }
}

struct Helper {
    key: Key,
    params: Vec<ValType>,
    operation: Instruction<'static>,
    marker: Option<TableMarkers>,
}

pub struct FrozenStateRewrites {
    declarations: FrozenDeclarations,
    helpers: Vec<Helper>,
    calls: BTreeMap<Key, u32>,
    synchronized: BTreeSet<u32>,
    resume_table: Option<u32>,
    hooks: StateHooks,
}

impl FrozenStateRewrites {
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }

    pub fn emit_function<T: Reencode + ?Sized>(
        &self,
        source: &FunctionIr<'_>,
        map: &mut T,
        limit: usize,
    ) -> Result<Function>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        let mut output = map.new_function_with_parsed_locals(&source.source)?;
        for instruction in &source.instructions {
            let op = &instruction.operation;
            if let Some(key) = Key::from_op(op, &self.synchronized, self.resume_table) {
                let function = *self
                    .calls
                    .get(&key)
                    .context("state operation was not discovered before freezing")?;
                if matches!(key, Key::TailIndirect { .. }) {
                    output.instruction(&Instruction::ReturnCall(function));
                } else {
                    output.instruction(&Instruction::Call(function));
                }
            } else {
                output.instruction(&map.instruction(op.clone())?);
                let bit = match *op {
                    Operator::DataDrop { data_index } => self.hooks.data.get(&data_index),
                    Operator::ElemDrop { elem_index } => self.hooks.elements.get(&elem_index),
                    _ => None,
                };
                if let Some(bit) = bit {
                    output
                        .instruction(&Instruction::GlobalGet(bit.global))
                        .instruction(&Instruction::I32Const(bit.mask as i32))
                        .instruction(&Instruction::I32Or)
                        .instruction(&Instruction::GlobalSet(bit.global));
                }
            }
            ensure!(
                output.byte_len() <= limit,
                "state rewrite exceeds function output budget"
            );
        }
        Ok(output)
    }

    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        let helper = self
            .helpers
            .get(ordinal as usize)
            .context("unknown frozen state helper")?;
        let grow_type = if let Key::Grow(_) = helper.key {
            Some(helper.params[1])
        } else {
            None
        };
        let locals = grow_type.map(|t| {
            (
                1,
                if t == ValType::I64 {
                    wasm_encoder::ValType::I64
                } else {
                    wasm_encoder::ValType::I32
                },
            )
        });
        let mut output = Function::new(locals.into_iter());
        output.instruction(&Instruction::Call(if helper.marker.is_some() {
            self.hooks.mutation_begin
        } else {
            self.hooks.reconcile
        }));
        for i in 0..helper.params.len() as u32 {
            output.instruction(&Instruction::LocalGet(i));
        }
        output.instruction(&helper.operation);
        if let Some(marker) = helper.marker {
            if let Some(index_type) = grow_type {
                let result = helper.params.len() as u32;
                output.instruction(&Instruction::LocalSet(result));
                as_i64(&mut output, result, index_type);
                as_i64(&mut output, 1, index_type);
                output
                    .instruction(&Instruction::Call(marker.grow))
                    .instruction(&Instruction::LocalGet(result));
            } else {
                as_i64(&mut output, 0, helper.params[0]);
                if matches!(helper.key, Key::Set(_)) {
                    output.instruction(&Instruction::I64Const(1));
                } else {
                    as_i64(&mut output, 2, helper.params[2]);
                }
                output.instruction(&Instruction::Call(marker.mark));
            }
        }
        output.instruction(&Instruction::End);
        ensure!(
            output.byte_len() <= limit,
            "state helper exceeds function output budget"
        );
        Ok(output)
    }
}

fn as_i64(output: &mut Function, local: u32, ty: ValType) {
    output.instruction(&Instruction::LocalGet(local));
    if ty == ValType::I32 {
        output.instruction(&Instruction::I64ExtendI32U);
    }
}
