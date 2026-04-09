/*
 * Minimal termcap.h for less cross-compilation.
 * Provides declarations for termcap functions implemented in termcap-stub.c.
 */

#ifndef _TERMCAP_H
#define _TERMCAP_H

int tgetent(char *bp, const char *name);
int tgetflag(const char *id);
int tgetnum(const char *id);
char *tgetstr(const char *id, char **area);
int tputs(const char *str, int affcnt, int (*putc_func)(int));
char *tgoto(const char *cap, int col, int row);

#endif /* _TERMCAP_H */
