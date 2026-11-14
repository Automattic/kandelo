#include <ctype.h>
#include <libintl.h>
#include <locale.h>
#include <stdio.h>
#include <string.h>
#include "config.h"
#include "parse.h"
#include "keywords.h"

#ifndef GREETING
#error "GREETING comes from greeting.pc through pkg-config"
#endif

int yylex(void) {
    int c;
    while ((c = getchar()) == ' ') {}
    if (isdigit(c)) {
        ungetc(c, stdin);
        if (scanf("%d", &yylval) != 1) return 0;
        return NUMBER;
    }
    if (isalpha(c)) {
        char word[32];
        size_t n = 0;
        while (isalpha(c) && n < sizeof word - 1) { word[n++] = (char)c; c = getchar(); }
        word[n] = '\0';
        ungetc(c, stdin);
        const struct keyword *k = keyword_lookup(word, n);
        if (k == NULL) return 0;
        yylval = k->value;
        return NUMBER;
    }
    return c == EOF ? 0 : c;
}

void yyerror(const char *message) { fprintf(stderr, "calc: %s\n", message); }

int main(int argc, char **argv) {
    setlocale(LC_ALL, "");
    bindtextdomain(PACKAGE, argc > 2 ? argv[2] : LOCALEDIR);
    textdomain(PACKAGE);
    if (argc > 1 && strcmp(argv[1], "--help") == 0) {
        printf("Usage: calc\nEvaluate one sum or product per line of standard input.\n");
        return 0;
    }
    if (argc > 1 && strcmp(argv[1], "--greet") == 0) {
        printf("%s\n", gettext("Hello"));
        return 0;
    }
    if (argc > 1 && strcmp(argv[1], "--version") == 0) {
        printf("calc (%s) %s\n%s\n", PACKAGE_NAME, PACKAGE_VERSION, GREETING);
        return 0;
    }
    return yyparse();
}
