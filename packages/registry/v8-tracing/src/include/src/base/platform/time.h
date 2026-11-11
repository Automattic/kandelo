#pragma once
#include <cstdint>
namespace v8::base {
class TimeTicks {
 int64_t value_; explicit TimeTicks(int64_t value):value_(value){}
 public: static TimeTicks Now(); int64_t ToInternalValue() const{return value_;}
};
class ThreadTicks {
 int64_t value_; explicit ThreadTicks(int64_t value):value_(value){}
 public: static ThreadTicks Now(); int64_t ToInternalValue() const{return value_;}
};
}
