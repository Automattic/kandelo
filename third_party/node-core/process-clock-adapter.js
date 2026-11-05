// Pinned public hrtime tuple/borrow/validation over real monotonic nanoseconds.
// Native kernel time is independent of Date and virtual test clocks.
function _createNodeProcessClock(platform) {
    'use strict';
    const { Uint32Array, BigUint64Array, Number, ObjectAssign } = _createNodePrimordials();
    const hrValues = new Uint32Array(3);
    const hrBigintValues = new BigUint64Array(hrValues.buffer, 0, 1);
    const binding = {
        hrtime() {
            const value = platform.native.hrtime();
            const seconds = value / 1000000000n;
            hrValues[0] = Number(seconds >> 32n);
            hrValues[1] = Number(seconds & 0xffffffffn);
            hrValues[2] = Number(value % 1000000000n);
        },
        hrtimeBigInt() { hrBigintValues[0] = platform.native.hrtime(); },
    };
    const validateArray = (value, name) => platform.getValues().validators.validateArray(value, name);
    const ERR_OUT_OF_RANGE = function(...args) { return new (platform.getValues().errors.codes.ERR_OUT_OF_RANGE)(...args); };
    /* NODE_HRTIME_ALGORITHMS */
    return { hrtime: ObjectAssign(hrtime, { bigint: hrtimeBigInt }) };
}
