/* Wasm floating-point environment.
 * Wasm FP is non-trapping IEEE 754, rounding mode is always round-to-nearest. */

#define FE_TONEAREST  0
#define FE_DOWNWARD   0x400
#define FE_UPWARD     0x800
#define FE_TOWARDZERO 0xc00

#define FE_INEXACT    32
#define FE_UNDERFLOW  16
#define FE_OVERFLOW   8
#define FE_DIVBYZERO  4
#define FE_INVALID    1

#define FE_ALL_EXCEPT 61

typedef unsigned short fexcept_t;

typedef struct {
	unsigned short __control_word;
	unsigned short __status_word;
} fenv_t;

#define FE_DFL_ENV ((const fenv_t *) -1)
