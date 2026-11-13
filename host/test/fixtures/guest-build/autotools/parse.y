%{
#include <stdio.h>
#include "ops.h"
int yylex(void);
void yyerror(const char *message);
%}
%define parse.error verbose
%token NUMBER
%left '+'
%left '*'
%%
input: %empty | input line ;
line: expr '\n' { printf("%d\n", $1); } ;
expr: NUMBER
    | expr '+' expr { $$ = ops_apply('+', $1, $3); }
    | expr '*' expr { $$ = ops_apply('*', $1, $3); }
    ;
%%
