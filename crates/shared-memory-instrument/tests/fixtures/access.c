#include <stdint.h>
#include <wasm_simd128.h>
#define EXPORT(name) __attribute__((export_name(name)))
EXPORT("__abi_version") int abi_version(void) {return ABI_VERSION;}
static volatile uint32_t initialized=0x2468ace;
EXPORT("initialized") uint32_t initial_data(void){return initialized;}
EXPORT("set_initialized") void set_initialized(uint32_t value){initialized=value;}
EXPORT("read32") uint32_t read32(uint32_t p){return *(uint32_t*)(uintptr_t)p;}
EXPORT("write32") void write32(uint32_t p,uint32_t v){*(uint32_t*)(uintptr_t)p=v;}
EXPORT("read64") uint64_t read64(uint32_t p){return *(uint64_t*)(uintptr_t)p;}
EXPORT("write64") void write64(uint32_t p,uint64_t v){*(uint64_t*)(uintptr_t)p=v;}
EXPORT("copy") void copy(uint32_t d,uint32_t s,uint32_t n){__builtin_memmove((void*)(uintptr_t)d,(void*)(uintptr_t)s,n);}
EXPORT("fill") void fill(uint32_t d,uint32_t v,uint32_t n){__builtin_memset((void*)(uintptr_t)d,v,n);}
EXPORT("simd_copy") void simd_copy(uint32_t d,uint32_t s){wasm_v128_store((void*)(uintptr_t)d,wasm_v128_load((void*)(uintptr_t)s));}
EXPORT("atomic_add") uint32_t atomic_add(uint32_t p,uint32_t v){return __atomic_fetch_add((uint32_t*)(uintptr_t)p,v,__ATOMIC_SEQ_CST);}
EXPORT("wait32") uint32_t wait32(uint32_t p,uint32_t v,int64_t t){return __builtin_wasm_memory_atomic_wait32((int*)(uintptr_t)p,v,t);}
EXPORT("wait64") uint32_t wait64(uint32_t p,int64_t v,int64_t t){return __builtin_wasm_memory_atomic_wait64((int64_t*)(uintptr_t)p,v,t);}
EXPORT("notify") uint32_t notify(uint32_t p,uint32_t n){return __builtin_wasm_memory_atomic_notify((int*)(uintptr_t)p,n);}
EXPORT("size") uint32_t size(void){return __builtin_wasm_memory_size(0);}
EXPORT("grow") uint32_t grow(uint32_t n){return __builtin_wasm_memory_grow(0,n);}
EXPORT("spin") void spin(uint32_t p){for(;;)(*(volatile uint32_t*)(uintptr_t)p)++;}
