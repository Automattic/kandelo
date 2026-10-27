# POSIX make's default rules turn calc.y and calc.l into C with $(YACC) and
# $(LEX); spelled out here so the test names exactly what runs.
calc.wasm: y.tab.o lex.yy.o
	$(CC) -o $@ y.tab.o lex.yy.o

y.tab.c y.tab.h: calc.y
	yacc -d calc.y

lex.yy.c: calc.l y.tab.h
	lex calc.l
