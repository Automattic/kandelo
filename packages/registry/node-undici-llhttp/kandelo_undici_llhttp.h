#ifndef KANDELO_UNDICI_LLHTTP_H
#define KANDELO_UNDICI_LLHTTP_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum kandelo_undici_callback {
  KUL_URL,
  KUL_STATUS,
  KUL_HEADER_FIELD,
  KUL_HEADER_VALUE,
  KUL_HEADERS_COMPLETE,
  KUL_MESSAGE_BEGIN,
  KUL_BODY,
  KUL_MESSAGE_COMPLETE
};

/* Synchronous callbacks borrow span bytes only until this call returns.
 * No C++ exception may cross this ABI. The owning JS adapter records a thrown
 * exception/termination, returns a real parser stop code, then propagates that
 * original failure after the C call returns. */
typedef int32_t (*kandelo_undici_dispatch)(
    void* owner, uint32_t operation, const uint8_t* span, size_t length,
    uint32_t status, uint32_t upgrade, uint32_t keep_alive);

typedef struct kandelo_undici_llhttp_api_v1 {
  uint32_t abi_version;
  uint32_t structure_size;
  uint32_t parser_version;
  uint32_t pointer_size;
  size_t parser_allocation_size;
  void* (*create)(uint32_t type, kandelo_undici_dispatch dispatch, void* owner);
  void (*destroy)(void* parser);
  int32_t (*execute)(void* parser, const uint8_t* bytes, size_t length);
  int32_t (*finish)(void* parser);
  void (*resume)(void* parser);
  const uint8_t* (*error_position)(const void* parser);
  const char* (*error_reason)(const void* parser);
} kandelo_undici_llhttp_api_v1;

/* The sole public provider entrypoint. Original llhttp symbols are prefixed
 * during compilation and are not published as another process-wide llhttp. */
const kandelo_undici_llhttp_api_v1* kandelo_undici_llhttp_get_api_v1(void);

#ifdef __cplusplus
}
#endif
#endif
