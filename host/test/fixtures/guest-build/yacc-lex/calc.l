%{
#include <stdlib.h>
#include "y.tab.h"
/* Without %union, y.tab.h need not declare yylval (POSIX yacc). */
extern int yylval;
%}
%option noyywrap
%%
[0-9]+          { yylval = atoi(yytext); return NUMBER; }
[-+*/()\n]      { return yytext[0]; }
[ \t]           ;
%%
