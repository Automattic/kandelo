#include "optimization.h"
// Separate translation unit deliberately exposes the visibility/LTO question.
uint32_t opaque_read(uint32_t p, uint32_t root) { return read32(p, root); }
void opaque_write(uint32_t p, uint32_t v, uint32_t root) { write32(p, v, root); }
