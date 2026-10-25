//! Visit original operators under the instrumenter lexical retention policy.

/// Visit one original operator at a time under the lexical retention policy. This is distinct from semantic control reachability.
pub(crate) fn visit_retained_operators(
    scan: &crate::streaming::Scan<'_>,
    control_frames: usize,
    mut visit: impl FnMut(usize, &wasmparser::Operator<'_>) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    use wasmparser::{Parser, Payload};
    let mut function = scan.imported_functions as usize;
    for payload in Parser::new(0).parse_all(scan.input()) {
        let Payload::CodeSectionEntry(body) = payload? else {
            continue;
        };
        let mut retention = crate::streaming::LexicalRetention::new(control_frames)?;
        let mut reader = body.get_operators_reader()?;
        while !reader.eof() {
            let op = reader.read()?;
            if retention.visit(&op)? {
                visit(function, &op)?;
            }
        }
        function += 1;
    }
    Ok(())
}
