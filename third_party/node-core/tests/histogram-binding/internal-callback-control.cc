// The actual generic policy, not a JSAPI or Promise-hook execution claim.
#include "callback-scope.h"
#include <cassert>
#include <string>
struct Host {
  unsigned depth = 0;
  bool ready = true, stopping = false, error = false, retired = false;
  int checkpoint = 0, hooks = 0;
  std::string context = "prior", prior;
  bool Ready() const { return ready; }
  unsigned& Depth() { return depth; }
  bool Stopping() const { return stopping; }
  bool HasError() const { return error; }
  bool Before() { prior = context; context = "zero/default/object"; return true; }
  bool Recover() { return false; }
  bool After() { return true; } // IDs zero never emit AsyncWrap hooks.
  void Restore() { context = prior; }
  bool Checkpoint() { assert(retired && context == "prior"); ++checkpoint; return true; }
};
int main() {
  for (unsigned outer = 0; outer < 2; ++outer) {
    Host host; host.depth = outer;
    {
      kandelo::async::CallbackScope<Host> scope(host);
      assert(scope.Enter() && host.context == "zero/default/object");
      host.retired = true;
      assert(scope.Close() && scope.Close());
      assert(host.context == "prior" && host.hooks == 0);
      assert(host.checkpoint == (outer ? 0 : 1));
    }
    assert(host.depth == outer);
  }
  for (int failure = 0; failure < 3; ++failure) {
    Host host;
    {
      kandelo::async::CallbackScope<Host> scope(host);
      if (failure == 0) { host.error = true; assert(!scope.Enter()); }
      else {
        assert(scope.Enter());
        if (failure == 1) host.stopping = true;
        // An explicit failure models a JS exception: no after/checkpoint.
        scope.Close(false);
      }
    }
    assert(host.depth == 0 && host.context == "prior" && host.checkpoint == 0);
  }
}
