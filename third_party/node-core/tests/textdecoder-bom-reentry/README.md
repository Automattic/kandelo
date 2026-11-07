# Reentrant decoder BOM and nonstream retirement

The stream getter completes before the fatal rollback BOM snapshot is
captured, because it can reenter the same receiver and commit newer state.
Successful nonstream conversion constructs its current output with the
correct established BOM suppression, then retires pending/BOM state before
returning. A fatal nonstream conversion also retires state; only streaming
failure restores BOM state committed before that conversion. Input/options
chronology and encoding repertoire remain independently incomplete.

control.cjs observes actual production decode against the pinned native owner.
Both candidate modes execute the same extracted byte/state source; fast mode
supplies only explicit native validated-UTF8 conversion/isUtf8 dependencies.
Production never delegates to a native-host decoder. Native VM/byte fixture
results do not prove guest/GC/native primitive or four-host behavior.

Final focused controls compare all9reentry cases and the original20fatal-state
cases in both available candidate modes. Strict intermediate single-flush
nonpasses and original proposal regressions remain sealed as earlier evidence;
no assertion was weakened or failure renamed. The final source retirement
control report identifies actual pass/nonpass counts and exact source/binary
identities. These cases do not establish complete TextDecoder semantics.
