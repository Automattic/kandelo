#include <stdlib.h>
#include <string.h>
#include <errno.h>

/* Inline types — musl doesn't have ndbm.h during its own build */
typedef unsigned mode_t;

typedef struct {
	void *dptr;
	unsigned long dsize;
} datum;

#define DBM_INSERT  0
#define DBM_REPLACE 1

struct ndbm_entry {
	struct ndbm_entry *next;
	void *key;
	unsigned long ksize;
	void *val;
	unsigned long vsize;
};

struct __DBM {
	struct ndbm_entry *head;
	struct ndbm_entry *iter;
	int err;
};

typedef struct __DBM DBM;

static struct ndbm_entry *find_entry(DBM *db, datum key)
{
	for (struct ndbm_entry *e = db->head; e; e = e->next)
		if (e->ksize == key.dsize && !memcmp(e->key, key.dptr, key.dsize))
			return e;
	return 0;
}

DBM *dbm_open(const char *file, int open_flags, mode_t file_mode)
{
	DBM *db = calloc(1, sizeof *db);
	if (!db) errno = ENOMEM;
	return db;
}

void dbm_close(DBM *db)
{
	if (!db) return;
	struct ndbm_entry *e = db->head;
	while (e) {
		struct ndbm_entry *next = e->next;
		free(e->key);
		free(e->val);
		free(e);
		e = next;
	}
	free(db);
}

int dbm_store(DBM *db, datum key, datum content, int store_mode)
{
	struct ndbm_entry *e = find_entry(db, key);
	if (e) {
		if (store_mode == DBM_INSERT) return 1;
		void *nv = malloc(content.dsize);
		if (!nv) { db->err = 1; return -1; }
		free(e->val);
		e->val = nv;
		memcpy(e->val, content.dptr, content.dsize);
		e->vsize = content.dsize;
		return 0;
	}
	e = malloc(sizeof *e);
	if (!e) { db->err = 1; return -1; }
	e->key = malloc(key.dsize);
	e->val = malloc(content.dsize);
	if (!e->key || !e->val) {
		free(e->key);
		free(e->val);
		free(e);
		db->err = 1;
		return -1;
	}
	memcpy(e->key, key.dptr, key.dsize);
	e->ksize = key.dsize;
	memcpy(e->val, content.dptr, content.dsize);
	e->vsize = content.dsize;
	e->next = db->head;
	db->head = e;
	return 0;
}

datum dbm_fetch(DBM *db, datum key)
{
	datum d = { 0, 0 };
	struct ndbm_entry *e = find_entry(db, key);
	if (e) {
		d.dptr = e->val;
		d.dsize = e->vsize;
	}
	return d;
}

int dbm_delete(DBM *db, datum key)
{
	struct ndbm_entry **pp = &db->head;
	for (; *pp; pp = &(*pp)->next) {
		struct ndbm_entry *e = *pp;
		if (e->ksize == key.dsize && !memcmp(e->key, key.dptr, key.dsize)) {
			*pp = e->next;
			free(e->key);
			free(e->val);
			free(e);
			return 0;
		}
	}
	return -1;
}

datum dbm_firstkey(DBM *db)
{
	datum d = { 0, 0 };
	db->iter = db->head;
	if (db->iter) {
		d.dptr = db->iter->key;
		d.dsize = db->iter->ksize;
	}
	return d;
}

datum dbm_nextkey(DBM *db)
{
	datum d = { 0, 0 };
	if (db->iter)
		db->iter = db->iter->next;
	if (db->iter) {
		d.dptr = db->iter->key;
		d.dsize = db->iter->ksize;
	}
	return d;
}

int dbm_error(DBM *db)
{
	return db->err;
}

int dbm_clearerr(DBM *db)
{
	db->err = 0;
	return 0;
}
