/*
 * The native host's copy of the concurrent-pthread fixture.
 *
 * The behaviour under test is a *divergence between hosts*, so the two hosts
 * must run byte-identical source: if this file and the Node/browser fixture
 * drifted, a green pair would stop proving the hosts agree. The two hosts
 * have separate fixture build recipes -- `scripts/build-programs.sh` sweeps
 * every `.c` under `examples/`, `fixtures/build-fixtures.sh` sweeps this
 * directory -- and neither can build from the other's tree, so the single
 * source is shared by inclusion rather than copied.
 *
 * See `examples/pthread-concurrent-slots.c` for what the fixture asserts and
 * why the native host could not pass it while it placed thread slots itself.
 */
#include "../../../examples/pthread-concurrent-slots.c"
