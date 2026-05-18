#include <stdio.h>
#include <sqlite3.h>

int main(void)
{
    sqlite3 *db;
    int rc = sqlite3_open(":memory:", &db);
    if (rc != SQLITE_OK) {
        printf("FAIL: sqlite3_open: %s\n", sqlite3_errmsg(db));
        return 1;
    }
    printf("OK: sqlite3_open succeeded\n");
    printf("SQLite version: %s\n", sqlite3_libversion());

    rc = sqlite3_exec(db, "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)", NULL, NULL, NULL);
    if (rc != SQLITE_OK) {
        printf("FAIL: CREATE TABLE: %s\n", sqlite3_errmsg(db));
        sqlite3_close(db);
        return 1;
    }
    printf("OK: CREATE TABLE succeeded\n");

    rc = sqlite3_exec(db, "INSERT INTO t VALUES(1, 'hello')", NULL, NULL, NULL);
    if (rc != SQLITE_OK) {
        printf("FAIL: INSERT: %s\n", sqlite3_errmsg(db));
        sqlite3_close(db);
        return 1;
    }
    printf("OK: INSERT succeeded\n");

    sqlite3_stmt *stmt;
    rc = sqlite3_prepare_v2(db, "SELECT name FROM t WHERE id=1", -1, &stmt, NULL);
    if (rc != SQLITE_OK) {
        printf("FAIL: prepare: %s\n", sqlite3_errmsg(db));
        sqlite3_close(db);
        return 1;
    }

    rc = sqlite3_step(stmt);
    if (rc == SQLITE_ROW) {
        const char *name = (const char *)sqlite3_column_text(stmt, 0);
        printf("OK: SELECT returned '%s'\n", name);
    } else {
        printf("FAIL: SELECT step returned %d\n", rc);
        sqlite3_finalize(stmt);
        sqlite3_close(db);
        return 1;
    }

    sqlite3_finalize(stmt);
    sqlite3_close(db);
    printf("PASS\n");
    return 0;
}
