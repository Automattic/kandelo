#include "async-default-trigger.h"
#include <cassert>
#include <cstdio>
using kandelo::async::DefaultTrigger;
using kandelo::async::DefaultTriggerScope;
int main() {
 DefaultTrigger owner; assert(owner.Raw() == -1 && owner.Resolve(123) == 123);
 { DefaultTriggerScope outer(owner,77); assert(outer.Ready() && owner.Resolve(123)==77);
   try { DefaultTriggerScope nested(owner,88); assert(nested.Ready() && owner.Resolve(123)==88); throw 1; }
   catch(int) { assert(owner.Resolve(123)==77); }
   { DefaultTriggerScope invalid(owner,0.5); assert(!invalid.Ready() && owner.Resolve(123)==77); }
   { DefaultTriggerScope clear(owner,-1); assert(clear.Ready() && owner.Resolve(123)==123); }
   assert(owner.Resolve(123)==77);
 }
 assert(owner.Raw()==-1 && owner.Resolve(123)==123);
 std::puts("actual default-trigger numeric owner: native RAII nesting/throw/clear/invalid/restoration PASS");
}
