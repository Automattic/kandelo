#ifndef _NDBM_H
#define _NDBM_H

#ifdef __cplusplus
extern "C" {
#endif

#define __NEED_size_t
#define __NEED_mode_t
#include <bits/alltypes.h>

typedef struct {
	void *dptr;
	size_t dsize;
} datum;

typedef struct __DBM DBM;

#define DBM_INSERT  0
#define DBM_REPLACE 1

int       dbm_clearerr(DBM *);
void      dbm_close(DBM *);
int       dbm_delete(DBM *, datum);
int       dbm_error(DBM *);
datum     dbm_fetch(DBM *, datum);
datum     dbm_firstkey(DBM *);
datum     dbm_nextkey(DBM *);
DBM      *dbm_open(const char *, int, mode_t);
int       dbm_store(DBM *, datum, datum, int);

#ifdef __cplusplus
}
#endif

#endif
