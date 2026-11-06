#ifndef KANDELO_STAT_POLL_PORT_COMMON_H
#define KANDELO_STAT_POLL_PORT_COMMON_H
#define container_of(ptr,type,member) reinterpret_cast<type*>(reinterpret_cast<char*>(ptr)-offsetof(type,member))
#endif
