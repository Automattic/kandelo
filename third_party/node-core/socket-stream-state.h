// Generated from pinned Node StreamBaseStateFields; do not edit.
#ifndef KANDELO_NODE_SOCKET_STREAM_STATE_H_
#define KANDELO_NODE_SOCKET_STREAM_STATE_H_
#include <cstddef>
namespace kandelo::socket::state {
enum StreamBaseStateFields : size_t {
  kReadBytesOrError = 0,
  kArrayBufferOffset = 1,
  kBytesWritten = 2,
  kLastWriteWasAsync = 3,
  kLastWriteErr = 4,
  kNumStreamBaseStateFields = 5,
};
}  // namespace kandelo::socket::state
#endif
