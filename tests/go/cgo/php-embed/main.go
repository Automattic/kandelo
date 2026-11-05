package main

/*
#cgo LDFLAGS: -L${SRCDIR}/lib -lphp -licui18n -licuio -licuuc -licudata -lc++ -lc++abi -lcurl -lzip -lxml2 -lssl -lcrypto -lsqlite3 -liconv -lz -lkandelo-ucontext-unsupported -ldl
#include <sapi/embed/php_embed.h>
#include <php.h>
#include <stdio.h>
static int run_php(int load_opcache) {
    char *args[] = {"php-embed-probe", NULL};
    if (php_embed_init(1, args) != SUCCESS) return 1;
    if (load_opcache) {
        zval registered;
        ZVAL_UNDEF(&registered);
        int evaluated = zend_eval_string(
            "extension_loaded('Zend OPcache') && function_exists('opcache_get_configuration')",
            &registered, "opcache registration probe");
        int loaded = evaluated == SUCCESS && zend_is_true(&registered);
        if (Z_TYPE(registered) != IS_UNDEF) zval_ptr_dtor(&registered);
        if (!loaded) {
            php_embed_shutdown();
            return 2;
        }
        puts("PHP OPCACHE STATIC PASS");
    }
    zend_eval_string("echo 'PHP EMBED PASS', PHP_EOL;", NULL, "probe");
    php_embed_shutdown();
    return 0;
}
*/
import "C"

import (
	"fmt"
	"os"
)

func main() {
	loadOpcache := len(os.Args) > 1 && os.Args[1] == "opcache"
	loadFlag := C.int(0)
	if loadOpcache {
		loadFlag = 1
	}
	if result := C.run_php(loadFlag); result != 0 {
        panic(fmt.Sprintf("PHP embed or static OPcache registration failed: %d", int(result)))
	}
	fmt.Println("GO PHP EMBED PASS")
	if loadOpcache {
        fmt.Println("GO PHP OPCACHE PASS")
	}
}
