#ifndef KANDELO_AMARO_VALUES_H
#define KANDELO_AMARO_VALUES_H
#include "kandelo_amaro.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct {
  uint32_t value;
  uint32_t flag;
  double number;
  size_t length;
} kandelo_amaro_value_reply;
/* All handles belong to one synchronous caller-owned rooted arena. 0..3 are
 * undefined/null/false/true. Inputs and outputs never transfer an allocator.
 * invoke returns normally on JS failure; the enclosing engine catcher retains
 * the actual thrown value, stack and termination. Rust unwinds only after that
 * return and catches its private abrupt marker before returning to C++.
 */
typedef struct {
  uint32_t version;
  size_t size;
  void *owner;
  int (*invoke)(void *, uint32_t, uint32_t, uint32_t, uint32_t,
                uint8_t *, size_t, double, kandelo_amaro_value_reply *);
} kandelo_amaro_value_operations;
enum kandelo_amaro_value_op {
  KA_TYPE=1, KA_NUMBER, KA_STRING_LENGTH, KA_STRING_COPY, KA_NEW_STRING,
  KA_NEW_NUMBER, KA_NEW_BIGINT, KA_BIGINT_STRING, KA_LOOSE_EQ, KA_IN, KA_GET,
  KA_SET, KA_NEW_OBJECT, KA_OBJECT_ENTRIES, KA_NEW_ARRAY, KA_ARRAY_LENGTH,
  KA_ARRAY_GET, KA_ARRAY_SET, KA_ARRAY_FROM, KA_IS_SAFE_INTEGER, KA_NEW_MAP,
  KA_MAP_SET, KA_ITERATOR_SYMBOL, KA_TRY_ITER, KA_ITER_NEXT, KA_NEW_BYTES,
  KA_COPY_BYTES_LENGTH, KA_COPY_BYTES, KA_NEW_UINT8_ARRAY, KA_NEW_ERROR,
  KA_DISPLAY, KA_DEBUG, KA_UINT8_STRING, KA_FALSY, KA_STRING_UTF16_LENGTH,
  KA_CODE_POINT_AT
};
enum { KA_VALUE_OK=0, KA_VALUE_THROW=1, KA_VALUE_ABRUPT=2,
       KA_VALUE_ABI_ERROR=3, KA_VALUE_PANIC=4, KA_VALUE_RESOURCE_ERROR=5 };
int kandelo_amaro_transform_values(const kandelo_amaro_value_operations *,
                                  uint32_t, uint32_t, uint32_t *,
                                  kandelo_amaro_result **);
#ifdef __cplusplus
}
#endif
#endif
