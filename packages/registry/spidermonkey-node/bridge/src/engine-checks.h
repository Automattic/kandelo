#ifndef KANDELO_ENGINE_CHECKS_H
#define KANDELO_ENGINE_CHECKS_H
#include "kandelo/v8-native-fatal.h"
#define CHECK(expr) do {if(!(expr))kandelo_v8_graceful_fatal("Native engine invariant: " #expr);} while(false)
#define CHECK_EQ(a,b) CHECK((a)==(b))
#define CHECK_NE(a,b) CHECK((a)!=(b))
#define CHECK_GE(a,b) CHECK((a)>=(b))
#define CHECK_GT(a,b) CHECK((a)>(b))
#define CHECK_LE(a,b) CHECK((a)<=(b))
#define CHECK_LT(a,b) CHECK((a)<(b))
#define CHECK_NULL(a) CHECK(!(a))
#define CHECK_NOT_NULL(a) CHECK(a)
#define CHECK_IMPLIES(a,b) CHECK(!(a)||(b))
#endif
