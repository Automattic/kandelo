#include "kandelo/v8-native-fatal.h"

#include "src/base/logging.h"

extern "C" [[noreturn]] void kandelo_v8_graceful_fatal(const char* reason) {
  GRACEFUL_FATAL("%s", reason);
}
