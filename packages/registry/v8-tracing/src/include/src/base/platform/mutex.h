#pragma once
#include "node_mutex.h"
namespace v8::base {
class Mutex: public ::node::Mutex {};
class MutexGuard: public ::node::Mutex::ScopedLock {
 public: explicit MutexGuard(Mutex* mutex): ::node::Mutex::ScopedLock(*mutex) {}
};
}
