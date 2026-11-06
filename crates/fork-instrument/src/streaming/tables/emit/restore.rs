use super::*;
pub(super) fn table(body: &mut Body<'_>, table: &Table) -> Result<()> {
    body.find(
        abi::WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE,
        table.owner,
        I::I32Const(0),
    )?;
    body.emit([
        I::LocalGet(PAYLOAD),
        I::I64Load(body.arg(8)),
        I::LocalSet(LEN),
        I::LocalGet(PAYLOAD),
        I::I32Load(body.arg(4)),
        I::LocalSet(PAGES),
    ])?;
    for (offset, expected) in std::iter::once((16, table.baseline_len as i64)).chain(
        table
            .fingerprint
            .chunks_exact(8)
            .enumerate()
            .map(|(chunk, bytes)| {
                (
                    24 + chunk as u64 * 8,
                    i64::from_le_bytes(bytes.try_into().unwrap()),
                )
            }),
    ) {
        body.emit([
            I::LocalGet(PAYLOAD),
            I::I64Load(body.arg(offset)),
            I::I64Const(expected),
            I::I64Ne,
        ])?;
        body.trap_if()?;
    }
    if !table.wide {
        body.emit([
            I::LocalGet(LEN),
            I::I64Const(i64::from(u32::MAX)),
            I::I64GtU,
        ])?;
        body.trap_if()?;
    }
    body.emit([I::TableSize(table.index)])?;
    body.from_index(table)?;
    body.emit([
        I::LocalSet(CURRENT),
        I::LocalGet(CURRENT),
        I::LocalGet(LEN),
        I::I64GtU,
    ])?;
    body.trap_if()?;
    body.emit([
        I::I32Const(0),
        I::LocalSet(ORDINAL),
        I::Block(BlockType::Empty),
        I::Loop(BlockType::Empty),
        I::LocalGet(ORDINAL),
        I::LocalGet(PAGES),
        I::I32GeU,
        I::BrIf(1),
    ])?;
    body.find(
        abi::WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE,
        table.owner,
        I::LocalGet(ORDINAL),
    )?;
    body.emit([
        I::LocalGet(PAYLOAD),
        I::I64Load(body.arg(0)),
        I::LocalSet(PAGE),
    ])?;
    body.page_start(table)?;
    validate_page(body)?;
    grow(body, table)?;
    entries(body, table)?;
    body.emit([
        I::I32Const(table.owner as i32),
        I::LocalGet(PAGE),
        I::I64Const(1),
        I::Call(body.plan.host.dirty_mark),
        I::LocalGet(ORDINAL),
        I::I32Const(1),
        I::I32Add,
        I::LocalSet(ORDINAL),
        I::Br(0),
        I::End,
        I::End,
        I::LocalGet(CURRENT),
        I::LocalGet(LEN),
        I::I64Ne,
    ])?;
    body.trap_if()
}
fn validate_page(body: &mut Body<'_>) -> Result<()> {
    for (offset, value) in [
        (8, I::I32Const(1)),
        (16, I::I32Const(0)),
        (12, I::LocalGet(COUNT)),
        (20, I::LocalGet(COUNT)),
    ] {
        let count = matches!(value, I::LocalGet(_));
        body.emit([I::LocalGet(PAYLOAD), I::I32Load(body.arg(offset)), value])?;
        if count {
            body.emit([I::I32WrapI64])?;
        }
        body.emit([I::I32Ne])?;
        body.trap_if()?;
    }
    Ok(())
}
fn grow(body: &mut Body<'_>, table: &Table) -> Result<()> {
    // A successful parent grow dirties the page spanning the old end. Its
    // saved entry is a valid initializer even for a non-nullable typed table.
    body.emit([
        I::LocalGet(CURRENT),
        I::LocalGet(LEN),
        I::I64LtU,
        I::If(BlockType::Empty),
        I::LocalGet(CURRENT),
        I::LocalGet(START),
        I::I64GeU,
        I::LocalGet(CURRENT),
        I::LocalGet(START),
        I::LocalGet(COUNT),
        I::I64Add,
        I::I64LtU,
        I::I32And,
        I::If(BlockType::Empty),
        I::LocalGet(CURRENT),
        I::LocalGet(START),
        I::I64Sub,
        I::LocalSet(INDEX),
    ])?;
    body.recipe_address()?;
    body.decode(table)?;
    body.emit([I::LocalGet(LEN), I::LocalGet(CURRENT), I::I64Sub])?;
    body.to_index(table)?;
    body.emit([I::TableGrow(table.index)])?;
    body.from_index(table)?;
    body.emit([
        I::I64Const(if table.wide { -1 } else { i64::from(u32::MAX) }),
        I::I64Eq,
    ])?;
    body.trap_if()?;
    body.emit([I::LocalGet(LEN), I::LocalSet(CURRENT), I::End, I::End])
}
fn entries(body: &mut Body<'_>, table: &Table) -> Result<()> {
    body.emit([
        I::I64Const(0),
        I::LocalSet(INDEX),
        I::Block(BlockType::Empty),
        I::Loop(BlockType::Empty),
        I::LocalGet(INDEX),
        I::LocalGet(COUNT),
        I::I64GeU,
        I::BrIf(1),
        I::LocalGet(START),
        I::LocalGet(INDEX),
        I::I64Add,
    ])?;
    body.to_index(table)?;
    body.recipe_address()?;
    body.decode(table)?;
    body.emit([
        I::TableSet(table.index),
        I::LocalGet(INDEX),
        I::I64Const(1),
        I::I64Add,
        I::LocalSet(INDEX),
        I::Br(0),
        I::End,
        I::End,
    ])
}
