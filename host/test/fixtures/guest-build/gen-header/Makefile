# The shape of a build that generates code with a helper program it builds
# first (NetHack's makedefs, for example). Built inside Kandelo by
# host/test/guest-build-make.test.ts, the helper must run on the target.
CC ?= cc

all: hello.wasm

gen: gen.c
	$(CC) -O2 -o $@ gen.c

generated.h: gen
	./gen > $@

main.o: main.c generated.h
	$(CC) -O2 -c main.c

util.o: util.c
	$(CC) -O2 -c util.c

hello.wasm: main.o util.o
	$(CC) -o $@ main.o util.o

clean:
	rm -f gen generated.h main.o util.o hello.wasm

.PHONY: all clean
