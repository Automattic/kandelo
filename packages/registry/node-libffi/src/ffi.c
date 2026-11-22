/* Native ownership and dispatch for the Kandelo wasm32 libffi target.
 * Portable type/layout/preparation algorithms remain in original libffi.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#define _GNU_SOURCE 1
#include <ffi.h>
#include <ffi_common.h>
#include <kandelo_ffi_adapter.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

_Static_assert(sizeof(void *) == 4 && sizeof(ffi_arg) == 4, "real wasm32 ABI required");
_Static_assert(sizeof(ffi_type) == 12, "matching upstream ffi_type layout required");

struct module {
  void *handle;
  int fd;
};
struct adapter {
  struct adapter *next;
  size_t leases;
  unsigned result, count;
  struct module module;
  void (*invoke)(uintptr_t, void *, void **);
  unsigned types[];
};
struct closure_owner {
  struct module reservation, callback;
  uint32_t (*address)(void);
  void (*install)(uint32_t);
  _Alignas(8) unsigned char storage[]; /* Preserve all caller-requested bytes. */
};
static struct adapter *adapters;
static pthread_mutex_t owner_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t owner_once = PTHREAD_ONCE_INIT;
static int owner_error;
static _Thread_local char error_text[256];

static void note(const char *message) {
  snprintf(error_text, sizeof(error_text), "%s", message ? message : "unknown backend failure");
}
FFI_API const char *ffi_kandelo_last_error(void) { return error_text; }
static void lock_before_fork(void) { pthread_mutex_lock(&owner_lock); }
static void unlock_after_fork(void) { pthread_mutex_unlock(&owner_lock); }
static void initialize_owners(void) {
  owner_error = pthread_atfork(lock_before_fork, unlock_after_fork, unlock_after_fork);
}
static int lock_owners(void) {
  int error = pthread_once(&owner_once, initialize_owners);
  if (!error) error = owner_error;
  if (!error) error = pthread_mutex_lock(&owner_lock);
  if (error) { errno = error; note("cannot initialize/lock FFI resource owners"); return -1; }
  return 0;
}
static struct module empty_module(void) {
  struct module result = {NULL, -1};
  return result;
}
static void unload(struct module *module) {
  /* WHY: /dev/fd/N is the loader name. Closing N before successful unload
   * could let a new module hit the old name's live instance. */
  if (module->handle && dlclose(module->handle) != 0) {
    fprintf(stderr, "libffi: generated module cleanup failed: %s\n", dlerror());
    abort();
  }
  module->handle = NULL;
  if (module->fd >= 0) close(module->fd);
  module->fd = -1;
}
static int private_spool(void *unused) {
  (void)unused;
  return memfd_create("libffi-adapter", MFD_CLOEXEC);
}
static int load(unsigned mode, unsigned result, const unsigned *types,
                unsigned count, uintptr_t closure, struct module *module) {
  *module = empty_module();
  kandelo_fork_instrument_result *artifact = NULL;
  /* Existing libc dlopen imposes a64MiB artifact ceiling. This is not an
   * argument-count/signature family limit or a fake admission claim. */
  int status = kandelo_ffi_emit_adapter(mode, result, types, count, closure,
      64u * 1024u * 1024u, private_spool, NULL, &artifact);
  if (status != KANDELO_FORK_INSTRUMENT_OK) {
    note(artifact ? kandelo_fork_instrument_error(artifact) : "cannot emit FFI adapter");
    kandelo_fork_instrument_release(artifact);
    return -1;
  }
  size_t length = 0;
  const uint8_t *bytes = kandelo_fork_instrument_bytes(artifact, &length);
  if (!bytes || !length) {
    note("instrumenter returned an empty FFI artifact");
    kandelo_fork_instrument_release(artifact);
    return -1;
  }
  module->fd = private_spool(NULL);
  if (module->fd < 0) { note("cannot allocate FFI module descriptor"); goto failure; }
  for (size_t offset = 0; offset < length;) {
    ssize_t written = write(module->fd, bytes + offset, length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) { note("cannot write FFI module"); goto failure; }
    offset += (size_t)written;
  }
  if (lseek(module->fd, 0, SEEK_SET) < 0) { note("cannot rewind FFI module"); goto failure; }
  char path[48];
  snprintf(path, sizeof(path), "/dev/fd/%d", module->fd);
  module->handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!module->handle) { note(dlerror()); goto failure; }
  kandelo_fork_instrument_release(artifact);
  return 0;
failure:
  kandelo_fork_instrument_release(artifact);
  unload(module);
  return -1;
}
static int scalar(const ffi_type *type, int result) {
  if (!type) return 0;
  switch (type->type) {
  case FFI_TYPE_VOID: return result;
  case FFI_TYPE_INT:
  case FFI_TYPE_UINT8: case FFI_TYPE_SINT8:
  case FFI_TYPE_UINT16: case FFI_TYPE_SINT16:
  case FFI_TYPE_UINT32: case FFI_TYPE_SINT32:
  case FFI_TYPE_UINT64: case FFI_TYPE_SINT64:
  case FFI_TYPE_FLOAT: case FFI_TYPE_DOUBLE: case FFI_TYPE_POINTER: return 1;
  default: return 0;
  }
}
ffi_status ffi_prep_cif_machdep(ffi_cif *cif) {
  /* Original libffi prepares the portable layout first. No borrowed cif,
   * ffi_type or foreign-library pointer is retained by the shared cache. */
  cif->kandelo_owner = NULL;
  if (cif->abi != FFI_KANDELO_WASM32) return FFI_BAD_ABI;
  if (!scalar(cif->rtype, 1)) return FFI_BAD_TYPEDEF;
  for (unsigned i = 0; i < cif->nargs; ++i)
    if (!scalar(cif->arg_types[i], 0)) return FFI_BAD_TYPEDEF;
  if (cif->nargs > (SIZE_MAX - sizeof(struct adapter)) / sizeof(unsigned))
    return FFI_BAD_ARGTYPE;
  struct adapter *candidate = calloc(1, sizeof(*candidate) + cif->nargs * sizeof(unsigned));
  if (!candidate) { note("cannot allocate FFI signature owner"); return FFI_BAD_ARGTYPE; }
  candidate->module = empty_module();
  candidate->result = cif->rtype->type;
  candidate->count = cif->nargs;
  for (unsigned i = 0; i < cif->nargs; ++i) candidate->types[i] = cif->arg_types[i]->type;
  if (lock_owners() != 0) { free(candidate); return FFI_BAD_ARGTYPE; }
  for (struct adapter *entry = adapters; entry; entry = entry->next) {
    if (entry->result == candidate->result && entry->count == candidate->count &&
        !memcmp(entry->types, candidate->types, candidate->count * sizeof(unsigned))) {
      if (entry->leases == SIZE_MAX) {
        pthread_mutex_unlock(&owner_lock); free(candidate);
        note("FFI signature owner count overflow"); return FFI_BAD_ARGTYPE;
      }
      ++entry->leases;
      cif->kandelo_owner = entry;
      pthread_mutex_unlock(&owner_lock); free(candidate); return FFI_OK;
    }
  }
  if (load(KANDELO_FFI_CALL_ADAPTER, candidate->result, candidate->types,
           candidate->count, 0, &candidate->module) != 0) goto failed;
  candidate->invoke = (void (*)(uintptr_t, void *, void **))dlsym(candidate->module.handle, "kandelo_ffi_call");
  if (!candidate->invoke) { note(dlerror()); goto failed; }
  candidate->leases = 1;
  candidate->next = adapters;
  adapters = candidate;
  cif->kandelo_owner = candidate;
  pthread_mutex_unlock(&owner_lock);
  return FFI_OK;
failed:
  unload(&candidate->module);
  pthread_mutex_unlock(&owner_lock); free(candidate); return FFI_BAD_ARGTYPE;
}
ffi_status ffi_prep_cif_machdep_var(ffi_cif *cif, unsigned fixed, unsigned total) {
  (void)fixed; (void)total;
  cif->kandelo_owner = NULL;
  /* The pinned Node API does not expose variadic signatures. Do not pretend
   * its scalar adapter has a variadic calling convention. */
  return FFI_BAD_ABI;
}
FFI_API void ffi_kandelo_release_cif(ffi_cif *cif) {
  if (!cif || !cif->kandelo_owner) return;
  struct adapter *entry = cif->kandelo_owner;
  if (lock_owners() != 0) abort();
  struct adapter **position = &adapters;
  while (*position && *position != entry) position = &(*position)->next;
  if (!*position || !entry->leases) {
    fprintf(stderr, "libffi: invalid signature retirement\n"); abort();
  }
  cif->kandelo_owner = NULL;
  if (--entry->leases == 0) {
    *position = entry->next;
    unload(&entry->module);
    free(entry);
  }
  pthread_mutex_unlock(&owner_lock);
}
void ffi_call(ffi_cif *cif, void (*function)(void), void *result, void **arguments) {
  struct adapter *entry = cif->kandelo_owner;
  if (!entry || !function) { fprintf(stderr, "libffi: call without a prepared live signature\n"); abort(); }
  /* No cache lock crosses a foreign call or JavaScript callback. The cif's
   * original owner must remain alive, as required by libffi. SDK table guards
   * reconcile the owning Worker's actual dynamic module/table replica. */
  entry->invoke((uintptr_t)function, result, arguments);
}
FFI_API void *ffi_closure_alloc(size_t size, void **code) {
  if (!code || size < sizeof(ffi_closure) || size > SIZE_MAX - offsetof(struct closure_owner, storage)) return NULL;
  *code = NULL;
  if (lock_owners() != 0) return NULL;
  struct closure_owner *owner = calloc(1, offsetof(struct closure_owner, storage) + size);
  if (!owner) { note("cannot allocate FFI callback owner"); goto failure; }
  owner->reservation = empty_module(); owner->callback = empty_module();
  if (load(KANDELO_FFI_RESERVE_CALLBACK, 0, NULL, 0, 0, &owner->reservation) != 0) goto failure;
  owner->address = (uint32_t (*)(void))dlsym(owner->reservation.handle, "kandelo_ffi_slot");
  owner->install = (void (*)(uint32_t))dlsym(owner->reservation.handle, "kandelo_ffi_install");
  if (!owner->address || !owner->install) { note(dlerror()); goto failure; }
  uintptr_t address = owner->address();
  if (!address) { note("loader reserved null callback address"); goto failure; }
  ((ffi_closure *)owner->storage)->ftramp = (void *)address;
  *code = (void *)address;
  pthread_mutex_unlock(&owner_lock);
  return owner->storage;
failure:
  if (owner) { unload(&owner->reservation); free(owner); }
  pthread_mutex_unlock(&owner_lock); return NULL;
}
ffi_status ffi_prep_closure_loc(ffi_closure *closure, ffi_cif *cif,
    void (*function)(ffi_cif *, void *, void **, void *), void *data, void *code) {
  if (!closure || !cif || !function || !cif->kandelo_owner || cif->abi != FFI_KANDELO_WASM32)
    return FFI_BAD_TYPEDEF;
  struct closure_owner *owner = (void *)((unsigned char *)closure - offsetof(struct closure_owner, storage));
  if (closure->ftramp != code || owner->callback.handle) return FFI_BAD_TYPEDEF;
  struct adapter *shape = cif->kandelo_owner;
  if (lock_owners() != 0) return FFI_BAD_ARGTYPE;
  struct module callback = empty_module();
  if (load(KANDELO_FFI_CALLBACK_ADAPTER, shape->result, shape->types, shape->count,
           (uintptr_t)closure, &callback) != 0) goto failure;
  void *entry = dlsym(callback.handle, "kandelo_ffi_callback");
  if (!entry) { note(dlerror()); goto failure; }
  closure->cif = cif; closure->fun = function; closure->user_data = data;
  owner->install((uint32_t)(uintptr_t)entry);
  owner->callback = callback;
  pthread_mutex_unlock(&owner_lock);
  return FFI_OK;
failure:
  unload(&callback);
  pthread_mutex_unlock(&owner_lock); return FFI_BAD_ARGTYPE;
}
FFI_API void ffi_closure_free(void *allocation) {
  if (!allocation) return;
  struct closure_owner *owner = (void *)((unsigned char *)allocation - offsetof(struct closure_owner, storage));
  if (lock_owners() != 0) abort();
  /* Node forbids freeing a callback during its invocation. Unload its alias
   * before its provider so no live reserved slot points at a retired module. */
  unload(&owner->reservation);
  unload(&owner->callback);
  pthread_mutex_unlock(&owner_lock);
  free(owner);
}
/* Generated guest callback modules resolve this native dispatcher from the
 * executable. The SDK hides ordinary C symbols; export this entry explicitly. */
FFI_API __attribute__((visibility("default"), export_name("kandelo_ffi_dispatch_closure")))
void kandelo_ffi_dispatch_closure(uint32_t address, void *result, void **arguments) {
  ffi_closure *closure = (ffi_closure *)(uintptr_t)address;
  closure->fun(closure->cif, result, arguments, closure->user_data);
}
