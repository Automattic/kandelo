#include <errno.h>
#include <stddef.h>

/* Inline the types from our ndbm.h overlay — musl doesn't have ndbm.h */
typedef unsigned mode_t;

typedef struct {
	void *dptr;
	unsigned long dsize;
} datum;

typedef struct __DBM DBM;

int dbm_clearerr(DBM *db)
{
	return 0;
}

void dbm_close(DBM *db)
{
}

int dbm_delete(DBM *db, datum key)
{
	return -1;
}

int dbm_error(DBM *db)
{
	return 0;
}

datum dbm_fetch(DBM *db, datum key)
{
	datum d = { NULL, 0 };
	return d;
}

datum dbm_firstkey(DBM *db)
{
	datum d = { NULL, 0 };
	return d;
}

datum dbm_nextkey(DBM *db)
{
	datum d = { NULL, 0 };
	return d;
}

DBM *dbm_open(const char *file, int open_flags, mode_t file_mode)
{
	errno = ENOSYS;
	return NULL;
}

int dbm_store(DBM *db, datum key, datum content, int store_mode)
{
	return -1;
}
