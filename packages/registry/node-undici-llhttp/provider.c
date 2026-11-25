/* Native ownership/ABI around the complete pinned Undici llhttp sources.
 * Parsing, status transitions, callbacks and errors remain in api.c/http.c/
 * llhttp.c. The Node adapter owns every opaque instance and its JS roots. */
#include "kandelo_undici_llhttp.h"
#include "llhttp.h"
#include <stdlib.h>

typedef struct native_parser {
  llhttp_t parser;
  kandelo_undici_dispatch dispatch;
  void* owner;
} native_parser;

_Static_assert(offsetof(native_parser, parser) == 0,
               "Original llhttp_free must receive the allocation base");

/* This is the original api.c callback settings object, not a second policy. */
extern const llhttp_settings_t wasm_settings;

static int dispatch_span(llhttp_t* parser, uint32_t operation,
                         const char* span, size_t length) {
  native_parser* instance = parser->data;
  return instance->dispatch(instance->owner, operation,
                            (const uint8_t*)span, length, 0, 0, 0);
}

int wasm_on_url(llhttp_t* parser, const char* span, size_t length) {
  return dispatch_span(parser, KUL_URL, span, length);
}
int wasm_on_status(llhttp_t* parser, const char* span, size_t length) {
  return dispatch_span(parser, KUL_STATUS, span, length);
}
int wasm_on_header_field(llhttp_t* parser, const char* span, size_t length) {
  return dispatch_span(parser, KUL_HEADER_FIELD, span, length);
}
int wasm_on_header_value(llhttp_t* parser, const char* span, size_t length) {
  return dispatch_span(parser, KUL_HEADER_VALUE, span, length);
}
int wasm_on_body(llhttp_t* parser, const char* span, size_t length) {
  return dispatch_span(parser, KUL_BODY, span, length);
}
int wasm_on_message_begin(llhttp_t* parser) {
  return dispatch_span(parser, KUL_MESSAGE_BEGIN, NULL, 0);
}
int wasm_on_message_complete(llhttp_t* parser) {
  return dispatch_span(parser, KUL_MESSAGE_COMPLETE, NULL, 0);
}
int wasm_on_headers_complete(llhttp_t* parser, int status,
                             uint8_t upgrade, int keep_alive) {
  native_parser* instance = parser->data;
  return instance->dispatch(instance->owner, KUL_HEADERS_COMPLETE, NULL, 0,
                            status, upgrade, keep_alive);
}

static void* create(uint32_t type, kandelo_undici_dispatch dispatch, void* owner) {
  if (dispatch == NULL || type > HTTP_RESPONSE) return NULL;
  native_parser* instance = malloc(sizeof(*instance));
  if (instance == NULL) return NULL;
  /* Native ownership adds the per-instance callback edge. Initialization uses
   * the original initializer/settings; no parser algorithm is reimplemented. */
  llhttp_init(&instance->parser, (llhttp_type_t)type, &wasm_settings);
  instance->dispatch = dispatch;
  instance->owner = owner;
  instance->parser.data = instance;
  return instance;
}
static void destroy(void* parser) {
  llhttp_free(parser);
}
static int32_t execute(void* parser, const uint8_t* bytes, size_t length) {
  return llhttp_execute(parser, (const char*)bytes, length);
}
static int32_t finish(void* parser) {
  return llhttp_finish(parser);
}
static void resume(void* parser) {
  llhttp_resume(parser);
}
static const uint8_t* error_position(const void* parser) {
  return (const uint8_t*)llhttp_get_error_pos(parser);
}
static const char* error_reason(const void* parser) {
  return llhttp_get_error_reason(parser);
}

__attribute__((visibility("default")))
const kandelo_undici_llhttp_api_v1* kandelo_undici_llhttp_get_api_v1(void) {
  static const kandelo_undici_llhttp_api_v1 api = {
    1, sizeof(api),
    (LLHTTP_VERSION_MAJOR << 16) | (LLHTTP_VERSION_MINOR << 8) | LLHTTP_VERSION_PATCH,
    sizeof(void*), sizeof(native_parser),
    create, destroy, execute, finish, resume, error_position, error_reason
  };
  return &api;
}
