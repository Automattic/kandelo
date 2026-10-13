package main

/*
#cgo LDFLAGS: -L${SRCDIR}/lib -lphp -licui18n -licuio -licuuc -licudata -lc++ -lc++abi -lcurl -lzip -lxml2 -lssl -lcrypto -lsqlite3 -liconv -lz -lkandelo-ucontext-unsupported
#include <sapi/embed/php_embed.h>
#include <php.h>
static int run_php(void) {
    char *args[] = {"php-embed-probe", NULL};
    if (php_embed_init(1, args) != SUCCESS) return 1;
    zend_eval_string("echo 'PHP EMBED PASS', PHP_EOL;", NULL, "probe");
    php_embed_shutdown();
    return 0;
}
*/
import "C"

import "fmt"

func main() {
	if C.run_php() != 0 {
		panic("PHP embed initialization failed")
	}
	fmt.Println("GO PHP EMBED PASS")
}
