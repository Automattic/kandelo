//! Original function identities survive conversion from imports to locals.
use super::*;
use crate::streaming::FrozenDeclarations;

#[derive(Clone, Copy, Debug)]
pub struct FunctionAdapter {
    pub source_function: u32,
    /// Relative to FrozenImports::helper_function_base(), not a final index.
    pub helper_ordinal: u32,
}

pub(super) fn validate(scan: &Scan<'_>, adapters: &[FunctionAdapter], imported: u32) -> Result<()> {
    let mut previous = None;
    for adapter in adapters {
        ensure!(
            adapter.source_function < imported
                && scan.functions[adapter.source_function as usize]
                    .body
                    .is_none(),
            "function adapter does not replace an original import"
        );
        ensure!(
            previous.is_none_or(|source| source < adapter.source_function),
            "function adapters must be in strict original import order"
        );
        previous = Some(adapter.source_function);
    }
    Ok(())
}

impl FrozenImports {
    pub(super) fn mapped_function(&self, index: u32) -> Result<u32, Error<ImportIndexError>> {
        let invalid = || {
            Error::UserError(ImportIndexError {
                space: "function",
                index,
            })
        };
        if index >= self.source.functions {
            return Err(invalid());
        }
        let rank = self
            .adapters
            .partition_point(|adapter| adapter.source_function < index);
        if let Some(adapter) = self
            .adapters
            .get(rank)
            .filter(|adapter| adapter.source_function == index)
        {
            return self
                .helper_function_base()
                .checked_add(adapter.helper_ordinal)
                .ok_or_else(invalid);
        }
        if index < self.imported.functions {
            return Ok(index - rank as u32);
        }
        u32::try_from(
            i64::from(index) + i64::from(self.total.functions) - i64::from(self.source.functions),
        )
        .map_err(|_| invalid())
    }

    pub(in crate::streaming) fn validate_adapters<T: Reencode>(
        &self,
        scan: &Scan<'_>,
        map: &mut T,
        declarations: Option<&FrozenDeclarations>,
    ) -> Result<()>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        for adapter in &self.adapters {
            let declared = declarations
                .and_then(|declarations| declarations.function_type(adapter.helper_ordinal))
                .context("function adapter has no declared local helper")?;
            ensure!(
                declared == map.type_index(scan.functions[adapter.source_function as usize].ty)?,
                "function adapter changed its original function type"
            );
            self.helper_function_base()
                .checked_add(adapter.helper_ordinal)
                .context("function adapter index overflow")?;
        }
        Ok(())
    }

    /// Preserve per-import reencoding hooks and original entity order while
    /// omitting only the function imports explicitly converted to locals.
    pub(in crate::streaming) fn parse_source_imports<T: Reencode>(
        &self,
        map: &mut T,
        section: &mut ImportSection,
        source: wasmparser::ImportSectionReader<'_>,
    ) -> Result<()>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        if self.adapters.is_empty() {
            map.parse_import_section(section, source)?;
            return Ok(());
        }
        let mut function = 0;
        let mut adapters = self.adapters.iter().peekable();
        for import in source.into_imports() {
            let import = import?;
            if matches!(import.ty, TypeRef::Func(_) | TypeRef::FuncExact(_)) {
                let removed = adapters
                    .peek()
                    .is_some_and(|adapter| adapter.source_function == function);
                function += 1;
                if removed {
                    adapters.next();
                    continue;
                }
            }
            map.parse_import(section, import)?;
        }
        ensure!(
            adapters.next().is_none(),
            "function adapter import was not emitted"
        );
        Ok(())
    }
}
