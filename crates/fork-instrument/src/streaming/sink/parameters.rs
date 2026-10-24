//! Direct argument proofs without recursively retaining caller bodies.

use anyhow::{Context, Result, ensure};
use rusqlite::params;

use super::{
    ALL_TAGS, CallEffect, Environment, Invocation, Limits, Options, Program, Value, evaluate,
};
use crate::streaming::{IrLimits, ProgramPoint};

#[derive(Clone, Copy, Debug)]
pub struct ParameterLimits {
    pub work: usize,
}

impl Default for ParameterLimits {
    fn default() -> Self {
        Self {
            work: super::DEFAULT_TOTAL_WORK_LIMIT,
        }
    }
}

#[derive(Debug, Default)]
pub struct ParameterReport {
    pub functions: usize,
    pub evaluations: usize,
    pub work_steps: usize,
    pub skipped_mutable_slots: bool,
}

impl Program<'_, '_> {
    /// Record a conservative union of arguments passed at every direct call,
    /// one body at a time. No indirect target matrix or nested caller IR is
    /// needed: a parameter proof is allowed only for nonescaping functions.
    pub fn record_parameter_values(
        &self,
        ir_limits: IrLimits,
        eval_limits: Limits,
        limits: ParameterLimits,
    ) -> Result<ParameterReport> {
        let progress = crate::progress::Progress::new("parameters");
        progress.note(format_args!("start, {} functions", self.functions.len()));
        self.parameters_ready.set(false);
        self.store
            .db
            .execute_batch(include_str!("parameters.sql"))?;
        let mut report = ParameterReport::default();
        if !self.constant_slots {
            report.skipped_mutable_slots = true;
            self.parameters_ready.set(true);
            return Ok(report);
        }
        let mut provider = self.original_scan().body_provider(ir_limits);
        for (index, function) in self.functions.iter().enumerate() {
            if function.imported {
                continue;
            }
            let body = provider.load(index as u32)?;
            // Batch argument writes for this body. The private connection is
            // serial, so runtime nesting checks suffice; Drop releases a failed
            // transaction and the ready flag still prevents partial proofs.
            let transaction = self.store.db.unchecked_transaction()?;
            let mut disable_frame_tracking = false;
            loop {
                self.store
                    .execute("DELETE FROM sink_value WHERE caller=?", [index as u32])?;
                let remaining = limits
                    .work
                    .checked_sub(report.work_steps)
                    .context("parameter analysis exceeds work budget")?;
                let mut environment = RecordEnvironment { program: self };
                let result = evaluate(
                    self.original_scan(),
                    &body,
                    &mut environment,
                    Options {
                        disable_frame_tracking,
                        ..Default::default()
                    },
                    Limits {
                        work: eval_limits.work.min(remaining),
                        ..eval_limits
                    },
                )?;
                report.evaluations += 1;
                report.work_steps = report
                    .work_steps
                    .checked_add(result.work_steps)
                    .context("parameter analysis work overflow")?;
                if result.frame_escaped && !disable_frame_tracking {
                    disable_frame_tracking = true;
                    continue;
                }
                self.store.execute(
                    "INSERT INTO sink_value_status VALUES(?,?)",
                    params![index as u32, result.unsupported],
                )?;
                break;
            }
            transaction.commit()?;
            report.functions += 1;
            if report.functions % 10_000 == 0 {
                progress.note(format_args!(
                    "{} functions complete, function {}, {} work units",
                    report.functions, index, report.work_steps,
                ));
            }
        }
        self.parameters_ready.set(true);
        progress.note(format_args!(
            "complete, {} functions, {} work units",
            report.functions, report.work_steps,
        ));
        Ok(report)
    }

    /// None means that some incoming value is unknown, or the closed-world
    /// prerequisites do not hold. Some(empty) proves no callable table slot.
    /// Parameter forwarding/cycles are resolved by file-backed recursive sets;
    /// only the sorted final target group is returned to Rust.
    pub fn parameter_targets(&self, function: u32, parameter: u32) -> Result<Option<Vec<u32>>> {
        let info = self
            .functions
            .get(function as usize)
            .context("unknown parameter-proof function")?;
        let types = self.original_scan().types.as_ref();
        let ty = self.original_scan().functions[function as usize].ty;
        let arity = types
            .get(types.core_type_at_in_module(ty))
            .unwrap()
            .composite_type
            .unwrap_func()
            .params()
            .len();
        ensure!(
            (parameter as usize) < arity,
            "parameter proof outside original signature"
        );
        if !self.constant_slots || info.imported || info.escaping {
            return Ok(None);
        }
        ensure!(
            self.parameters_ready.get(),
            "parameter value recording has not completed"
        );
        self.store.charge_work(2)?;
        let bad: bool = self.store.db.query_row(&format!("{REACH}
          SELECT EXISTS(SELECT 1 FROM reach p JOIN sink_function f ON f.id=p.function
            WHERE f.escaping
            OR NOT EXISTS(SELECT 1 FROM sink_direct d WHERE d.callee=p.function)
            OR EXISTS(SELECT 1 FROM sink_direct d JOIN sink_value_status s ON s.function=d.caller
                WHERE d.callee=p.function AND s.unsupported)
            OR EXISTS(SELECT 1 FROM sink_value v WHERE v.callee=p.function AND v.parameter=p.parameter AND v.kind=0))"),params![function,parameter],|r|r.get(0))?;
        if bad {
            return Ok(None);
        }
        let mut query = self.store.db.prepare(&format!("{REACH}
          SELECT DISTINCT s.target FROM reach p JOIN sink_value v ON v.callee=p.function AND v.parameter=p.parameter
            JOIN sink_slot s ON s.slot=v.payload WHERE v.kind=1 ORDER BY s.target"))?;
        let mut rows = query.query(params![function, parameter])?;
        let mut output = Vec::new();
        while let Some(row) = rows.next()? {
            ensure!(
                output.len() < self.limits.metadata_bytes / 8,
                "parameter targets exceed resident budget"
            );
            output.push(row.get(0)?);
        }
        Ok(Some(output))
    }
}

const REACH: &str = "WITH RECURSIVE reach(function,parameter) AS (
  VALUES(?,?) UNION
  SELECT v.caller,v.payload FROM reach p JOIN sink_value v
    ON v.callee=p.function AND v.parameter=p.parameter WHERE v.kind=2
)";

struct RecordEnvironment<'p, 's, 'a> {
    program: &'p Program<'s, 'a>,
}

impl Environment for RecordEnvironment<'_, '_, '_> {
    fn call(
        &mut self,
        point: ProgramPoint,
        invocation: Invocation,
        _: Value,
        arguments: &[Value],
        _: bool,
    ) -> Result<CallEffect> {
        if let Invocation::Direct(callee) = invocation {
            for (parameter, &value) in arguments.iter().enumerate() {
                let (kind, payload) = match value {
                    Value::Constant(c) => (1, c),
                    Value::Parameter(p) => (2, i64::from(p)),
                    _ => (0, 0),
                };
                self.program.store.execute(
                    "INSERT OR IGNORE INTO sink_value VALUES(?,?,?,?,?)",
                    params![point.function, callee, parameter as u32, kind, payload],
                )?;
            }
        }
        // WHY: this proof needs every possible direct caller's argument,
        // including calls in handlers. A value-only pass that models all
        // callees as not throwing can silently omit those registrations.
        Ok(CallEffect {
            returned: Some(Value::Unknown),
            thrown: ALL_TAGS,
            targets: Vec::new(),
            external: false,
        })
    }
    fn global_constant(&self, global: u32) -> Option<i64> {
        self.program.global_constants[global as usize]
    }
    fn stack_pointer_global(&self) -> Option<u32> {
        self.program.stack_pointer_global
    }
}
