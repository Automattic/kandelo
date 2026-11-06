//! Definition-only compiler facts for binding the original binary.
//!
//! Unlike `call_facts`, this pass never expands call-site, cast, slot-flow or
//! registry graphs. Those relations belong to the subsequent sink analysis.

use anyhow::{Context, Result, ensure};

/// The only definition fields needed by the existing linker-order binder.
#[derive(Debug, PartialEq, Eq)]
pub struct Definition {
    pub name: String,
    pub nparams: usize,
}

#[derive(Debug, Default)]
pub struct DefinitionIndex {
    pub chunks: Vec<Vec<Definition>>,
    pub decoded_bytes: u64,
}

impl DefinitionIndex {
    /// Decode bounded lines across concatenated facts sections. Compressed
    /// objects are never materialized in full. Retain only binding metadata.
    pub fn read<'a>(sections: impl IntoIterator<Item = &'a [u8]>) -> Result<Self> {
        Self::read_with_limits(sections, super::stream::ReadLimits::default())
    }

    pub fn read_with_limits<'a>(
        sections: impl IntoIterator<Item = &'a [u8]>,
        limits: super::stream::ReadLimits,
    ) -> Result<Self> {
        let mut out = Self::default();
        let mut current: Option<Definition> = None;
        let report = super::stream::visit_lines(sections, limits, |event| {
            use super::stream::Event;
            match event {
                Event::Begin { .. } => out.chunks.push(Vec::new()),
                Event::End { .. } => {
                    ensure!(current.is_none(), "facts chunk ends inside definition")
                }
                Event::Line { number, text, .. } => {
                    let mut fields = text.split('\t');
                    match fields.next() {
                        Some("F") => {
                            ensure!(current.is_none(), "facts line {number}: nested definition");
                            let name = fields.next().context("definition missing name")?.to_owned();
                            let nparams = fields
                                .next()
                                .context("definition missing parameter count")?
                                .parse()
                                .context("invalid definition parameter count")?;
                            current = Some(Definition { name, nparams });
                        }
                        Some("D") => {
                            let name = fields.next().context("definition end missing name")?;
                            let definition =
                                current.take().context("definition end outside function")?;
                            ensure!(definition.name == name, "definition end name mismatch");
                            fields
                                .next()
                                .context("definition end missing indirect count")?;
                            let _: usize = fields
                                .next()
                                .context("definition end missing site count")?
                                .parse()
                                .context("invalid definition site count")?;
                            out.chunks.last_mut().unwrap().push(definition);
                        }
                        _ => {}
                    }
                }
            }
            Ok(())
        })?;
        out.decoded_bytes = report.decoded_bytes;
        Ok(out)
    }

    pub fn bind(&self, module: &[super::bind::Item<'_>]) -> Vec<Vec<(usize, usize)>> {
        let chunks: Vec<_> = self
            .chunks
            .iter()
            .map(|defs| {
                defs.iter()
                    .map(|d| super::bind::Item {
                        name: &d.name,
                        nparams: d.nparams,
                        ..Default::default()
                    })
                    .collect()
            })
            .collect();
        super::bind::bind(module, &chunks)
    }
}
