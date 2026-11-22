#ifndef KANDELO_ENGINE_SHARED_CONVEYOR_DATA_H
#define KANDELO_ENGINE_SHARED_CONVEYOR_DATA_H
#include "engine-native-api.h"
namespace v8::internal {
// This payload is exclusively V8's experimental shared-GC-heap handles. There
// is no producer in this engine: SpiderMonkey values cannot cross runtimes as
// raw GC pointers. Keep that invariant compile-enforced instead of inventing a
// successful shared-object transfer. Node's optional conveyor still needs the
// original move/destruction operations even when it never contains a value.
// SharedArrayBuffer transport uses its real shared backing owner separately.
class SharedObjectConveyorHandles final {
 public:
  SharedObjectConveyorHandles()=delete;
  SharedObjectConveyorHandles(const SharedObjectConveyorHandles&)=delete;
  SharedObjectConveyorHandles& operator=(const SharedObjectConveyorHandles&)=delete;
};
}
#endif
