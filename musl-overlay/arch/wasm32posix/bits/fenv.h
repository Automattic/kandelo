/* Wasm floating-point environment.
 * Wasm FP is non-trapping IEEE 754, rounding mode is always round-to-nearest.
 * No FP exception flags or alternate rounding modes are available. */

#define FE_ALL_EXCEPT 0
#define FE_TONEAREST  0

typedef unsigned short fexcept_t;

typedef struct {
	unsigned short __control_word;
	unsigned short __status_word;
} fenv_t;

#define FE_DFL_ENV ((const fenv_t *) -1)
