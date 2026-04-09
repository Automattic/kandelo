/*
 * Minimal termcap stubs for less cross-compilation.
 * less falls back to hardcoded ANSI terminal sequences when tgetent
 * fails, so these stubs just need to exist at link time and return
 * appropriate "not found" values at runtime.
 */

/* tgetent: load terminal entry. Return 0 = not found. */
int tgetent(char *bp, const char *name) {
    (void)bp;
    (void)name;
    return 0;
}

/* tgetflag: get boolean capability. Return 0 = not set. */
int tgetflag(const char *id) {
    (void)id;
    return 0;
}

/* tgetnum: get numeric capability. Return -1 = not found. */
int tgetnum(const char *id) {
    (void)id;
    return -1;
}

/* tgetstr: get string capability. Return NULL = not found. */
char *tgetstr(const char *id, char **area) {
    (void)id;
    (void)area;
    return (char *)0;
}

/* tputs: output a terminal string with padding. */
int tputs(const char *str, int affcnt, int (*putc_func)(int)) {
    (void)affcnt;
    if (str) {
        while (*str) {
            putc_func((unsigned char)*str++);
        }
    }
    return 0;
}

/* tgoto: cursor motion string. Return empty string. */
char *tgoto(const char *cap, int col, int row) {
    (void)cap;
    (void)col;
    (void)row;
    return "";
}
