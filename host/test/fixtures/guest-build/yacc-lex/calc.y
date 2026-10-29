%{
#include <stdio.h>
int yylex(void);
void yyerror(const char *message) { fprintf(stderr, "error: %s\n", message); }
%}
%token NUMBER
%left '+' '-'
%left '*' '/'
%%
lines : /* empty */
      | lines expr '\n' { printf("%d\n", $2); }
      ;
expr  : NUMBER
      | expr '+' expr { $$ = $1 + $3; }
      | expr '-' expr { $$ = $1 - $3; }
      | expr '*' expr { $$ = $1 * $3; }
      | expr '/' expr { $$ = $1 / $3; }
      | '(' expr ')'  { $$ = $2; }
      ;
%%
int main(void) { return yyparse(); }
