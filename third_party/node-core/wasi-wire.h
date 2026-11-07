// C linkage for the unchanged pinned uvwasi wire serializers. The imported
// header is staged under third_party and uses its declared include directory.
#ifndef KANDELO_NODE_WASI_WIRE_H
#define KANDELO_NODE_WASI_WIRE_H
extern "C" {
#include <wasi_serdes.h>
}
#endif
