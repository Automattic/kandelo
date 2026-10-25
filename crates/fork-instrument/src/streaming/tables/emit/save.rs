use super::*;
pub(super) fn table(body: &mut Body<'_>, table: &Table) -> Result<()> {
    body.emit([I::TableSize(table.index)])?;
    body.from_index(table)?;
    body.emit([
        I::LocalSet(LEN),
        I::I32Const(table.owner as i32),
        I::Call(body.plan.host.dirty_count),
        I::LocalSet(PAGES),
        I::I32Const(i32::from(abi::WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE)),
        I::LocalGet(ACTIVATION),
        I::I32Const(table.owner as i32),
    ])?;
    body.ptr(i64::from(
        abi::WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE,
    ))?;
    body.emit([I::Call(body.plan.records.reserve), I::LocalSet(PAYLOAD)])?;
    for (value, store) in [
        (if table.wide { 8 } else { 4 }, I::I32Store8(body.arg(0))),
        (SHIFT as i32, I::I32Store8(body.arg(1))),
        (
            abi::WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES as i32,
            I::I32Store16(body.arg(2)),
        ),
    ] {
        body.emit([I::LocalGet(PAYLOAD), I::I32Const(value), store])?;
    }
    body.emit([
        I::LocalGet(PAYLOAD),
        I::LocalGet(PAGES),
        I::I32Store(body.arg(4)),
        I::LocalGet(PAYLOAD),
        I::LocalGet(LEN),
        I::I64Store(body.arg(8)),
        I::LocalGet(PAYLOAD),
        I::I64Const(table.baseline_len as i64),
        I::I64Store(body.arg(16)),
    ])?;
    for (chunk, bytes) in table.fingerprint.chunks_exact(8).enumerate() {
        body.emit([
            I::LocalGet(PAYLOAD),
            I::I64Const(i64::from_le_bytes(bytes.try_into().unwrap())),
            I::I64Store(body.arg(24 + chunk as u64 * 8)),
        ])?;
    }
    body.emit([
        I::LocalGet(PAYLOAD),
        I::Call(body.plan.records.commit),
        I::I32Const(0),
        I::LocalSet(ORDINAL),
        I::Block(BlockType::Empty),
        I::Loop(BlockType::Empty),
        I::LocalGet(ORDINAL),
        I::LocalGet(PAGES),
        I::I32GeU,
        I::BrIf(1),
        I::I32Const(table.owner as i32),
        I::LocalGet(ORDINAL),
        I::Call(body.plan.host.dirty_page),
        I::LocalSet(PAGE),
    ])?;
    body.page_start(table)?;
    page(body, table)?;
    body.emit([
        I::LocalGet(ORDINAL),
        I::I32Const(1),
        I::I32Add,
        I::LocalSet(ORDINAL),
        I::Br(0),
        I::End,
        I::End,
    ])
}
fn page(body: &mut Body<'_>, table: &Table) -> Result<()> {
    body.emit([
        I::I32Const(i32::from(abi::WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE)),
        I::LocalGet(ACTIVATION),
        I::I32Const(table.owner as i32),
        I::LocalGet(COUNT),
        I::I64Const(4),
        I::I64Mul,
        I::I64Const(RECIPES as i64),
        I::I64Add,
    ])?;
    body.wide_to_ptr()?;
    body.emit([
        I::Call(body.plan.records.reserve),
        I::LocalSet(PAYLOAD),
        I::LocalGet(PAYLOAD),
        I::LocalGet(PAGE),
        I::I64Store(body.arg(0)),
        I::LocalGet(PAYLOAD),
        I::I32Const(1),
        I::I32Store(body.arg(8)),
        I::LocalGet(PAYLOAD),
        I::LocalGet(COUNT),
        I::I32WrapI64,
        I::I32Store(body.arg(12)),
        I::LocalGet(PAYLOAD),
        I::I32Const(0),
        I::I32Store(body.arg(16)),
        I::LocalGet(PAYLOAD),
        I::LocalGet(COUNT),
        I::I32WrapI64,
        I::I32Store(body.arg(20)),
        I::I64Const(0),
        I::LocalSet(INDEX),
        I::Block(BlockType::Empty),
        I::Loop(BlockType::Empty),
        I::LocalGet(INDEX),
        I::LocalGet(COUNT),
        I::I64GeU,
        I::BrIf(1),
    ])?;
    body.recipe_address()?;
    body.emit([I::LocalGet(START), I::LocalGet(INDEX), I::I64Add])?;
    body.to_index(table)?;
    body.emit([
        I::TableGet(table.index),
        I::Call(table.class.encoder(body.plan.codecs)),
        I::I32Store(body.arg(0)),
        I::LocalGet(INDEX),
        I::I64Const(1),
        I::I64Add,
        I::LocalSet(INDEX),
        I::Br(0),
        I::End,
        I::End,
        I::LocalGet(PAYLOAD),
        I::Call(body.plan.records.commit),
    ])
}
