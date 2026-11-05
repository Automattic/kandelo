use super::*;
const HEADER: u64 = 8;

pub(super) fn save(body: &mut Body<'_>, tracker: &SegmentTracker, kind: u16) -> Result<()> {
    if tracker.count == 0 {
        return Ok(());
    }
    let bytes = tracker.count.div_ceil(8);
    body.reserve(
        kind,
        1,
        bytes
            .checked_add(8)
            .context("segment bitmap size overflow")?,
    )?;
    body.emit([
        Instruction::LocalGet(PAYLOAD),
        Instruction::I32Const(tracker.count as i32),
        Instruction::I32Store(body.arg(0)),
        Instruction::LocalGet(PAYLOAD),
        Instruction::I32Const(bytes as i32),
        Instruction::I32Store(body.arg(4)),
    ])?;
    for byte in 0..bytes {
        body.emit([
            Instruction::LocalGet(PAYLOAD),
            Instruction::GlobalGet(tracker.words[(byte / 4) as usize]),
        ])?;
        if byte % 4 != 0 {
            body.emit([
                Instruction::I32Const((byte % 4 * 8) as i32),
                Instruction::I32ShrU,
            ])?;
        }
        body.emit([Instruction::I32Store8(body.arg(HEADER + u64::from(byte)))])?;
    }
    body.emit([
        Instruction::LocalGet(PAYLOAD),
        Instruction::Call(body.plan.host.commit),
    ])
}
pub(super) fn restore(
    body: &mut Body<'_>,
    tracker: &SegmentTracker,
    kind: u16,
    elements: bool,
) -> Result<()> {
    if tracker.count == 0 {
        return Ok(());
    }
    body.find(kind, 1)?;
    let bytes = tracker.count.div_ceil(8) as usize;
    for (index, global) in tracker.words.iter().enumerate() {
        body.emit([Instruction::I32Const(0)])?;
        // Never load allocator padding after a short final bitmap word.
        for byte in 0..bytes.saturating_sub(index * 4).min(4) {
            body.emit([
                Instruction::LocalGet(PAYLOAD),
                Instruction::I32Load8U(body.arg(HEADER + (index * 4 + byte) as u64)),
            ])?;
            if byte != 0 {
                body.emit([
                    Instruction::I32Const((byte * 8) as i32),
                    Instruction::I32Shl,
                ])?;
            }
            body.emit([Instruction::I32Or])?;
        }
        let remaining = tracker.count.saturating_sub(index as u32 * 32);
        if remaining < 32 {
            body.emit([
                Instruction::I32Const(((1u32 << remaining) - 1) as i32),
                Instruction::I32And,
            ])?;
        }
        body.emit([Instruction::GlobalSet(*global)])?;
    }
    for segment in 0..tracker.count {
        let bit = tracker.bit(segment).unwrap();
        body.emit([
            Instruction::GlobalGet(bit.global),
            Instruction::I32Const(bit.mask as i32),
            Instruction::I32And,
            Instruction::If(BlockType::Empty),
            if elements {
                Instruction::ElemDrop(segment)
            } else {
                Instruction::DataDrop(segment)
            },
            Instruction::End,
        ])?;
    }
    Ok(())
}
