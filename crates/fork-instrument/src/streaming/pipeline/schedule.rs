//! Checked declaration cursor. Body generation can only consume this schedule.
use super::*;
use anyhow::Context;

pub(super) struct Cursor {
    pub ty: u32,
    pub function: u32,
}
impl Cursor {
    pub fn new(scan: &Scan<'_>, imports: &FrozenImports) -> Self {
        Self {
            ty: scan.types.as_ref().core_type_count_in_module(),
            function: imports.helper_function_base(),
        }
    }
    pub fn advance(&mut self, declarations: &FrozenDeclarations) -> Result<()> {
        self.ty = self
            .ty
            .checked_add(declarations.type_count())
            .context("native pipeline type index overflow")?;
        self.function = self
            .function
            .checked_add(declarations.function_count())
            .context("native pipeline function index overflow")?;
        Ok(())
    }
}
