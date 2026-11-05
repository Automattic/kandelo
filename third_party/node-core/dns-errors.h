// The pinned POSIX libuv EAI mapping, using actual compiler errno definitions.
// See upstream/dns-reference/deps/uv/src/unix/getaddrinfo.c and libuv's license.
#ifndef KANDELO_NODE_DNS_ERRORS_H
#define KANDELO_NODE_DNS_ERRORS_H
#include <netdb.h>
#include "kandelo-node-uv-errno.h"
namespace kandelo::dns {
inline int ErrorStatus(int status, int system_error) {
  switch (status) {
    case 0: return 0;
#if defined(EAI_ADDRFAMILY)
    case EAI_ADDRFAMILY: return UV__EAI_ADDRFAMILY;
#endif
#if defined(EAI_AGAIN)
    case EAI_AGAIN: return UV__EAI_AGAIN;
#endif
#if defined(EAI_BADFLAGS)
    case EAI_BADFLAGS: return UV__EAI_BADFLAGS;
#endif
#if defined(EAI_BADHINTS)
    case EAI_BADHINTS: return UV__EAI_BADHINTS;
#endif
#if defined(EAI_CANCELED)
    case EAI_CANCELED: return UV__EAI_CANCELED;
#endif
#if defined(EAI_FAIL)
    case EAI_FAIL: return UV__EAI_FAIL;
#endif
#if defined(EAI_FAMILY)
    case EAI_FAMILY: return UV__EAI_FAMILY;
#endif
#if defined(EAI_MEMORY)
    case EAI_MEMORY: return UV__EAI_MEMORY;
#endif
#if defined(EAI_NODATA)
    case EAI_NODATA: return UV__EAI_NODATA;
#endif
#if defined(EAI_NONAME) && (!defined(EAI_NODATA) || EAI_NODATA != EAI_NONAME)
    case EAI_NONAME: return UV__EAI_NONAME;
#endif
#if defined(EAI_OVERFLOW)
    case EAI_OVERFLOW: return UV__EAI_OVERFLOW;
#endif
#if defined(EAI_PROTOCOL)
    case EAI_PROTOCOL: return UV__EAI_PROTOCOL;
#endif
#if defined(EAI_SERVICE)
    case EAI_SERVICE: return UV__EAI_SERVICE;
#endif
#if defined(EAI_SOCKTYPE)
    case EAI_SOCKTYPE: return UV__EAI_SOCKTYPE;
#endif
    case EAI_SYSTEM: return system_error ? UV__ERR(system_error) : UV__EIO;
    default: return UV__UNKNOWN;
  }
}
}  // namespace kandelo::dns
#endif
