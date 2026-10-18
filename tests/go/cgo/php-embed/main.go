package main

/*
#cgo LDFLAGS: -L${SRCDIR}/lib -lphp -licui18n -licuio -licuuc -licudata -lc++ -lc++abi -lcurl -lzip -lxml2 -lssl -lcrypto -lsqlite3 -liconv -lz -lkandelo-ucontext-unsupported -ldl
#include <sapi/embed/php_embed.h>
#include <php.h>
#include <dlfcn.h>
#include <stdio.h>
static int run_php(int load_opcache) {
    char *args[] = {"php-embed-probe", NULL};
    if (php_embed_init(1, args) != SUCCESS) return 1;
    if (load_opcache) {
        void *module = dlopen("/lib/opcache-zts.so", RTLD_NOW);
        if (module == NULL) {
            fprintf(stderr, "OPcache dlopen: %s\n", dlerror());
            return 2;
        }
        if (dlsym(module, "zend_extension_entry") == NULL) return 3;
        if (dlclose(module) != 0) return 4;
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
		panic(fmt.Sprintf("PHP embed or OPcache load failed: %d", int(result)))
	}
	fmt.Println("GO PHP EMBED PASS")
	if loadOpcache {
		fmt.Println("PHP OPCACHE DLOPEN PASS")
	}
}
