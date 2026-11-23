module quad_precision;

static assert(real.mant_dig == 113, "Kandelo real requires a binary128 target");
static assert(0x1p-16494L > 0,
    "Building Kandelo D requires a host LDC that preserves binary128 subnormals. Use an ARM64 Linux build host.");
static assert(1.0L + 0x1p-112L > 1.0L,
    "Building Kandelo D requires all 113 binary128 significand bits at compile time.");
