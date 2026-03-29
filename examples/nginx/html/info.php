<?php
echo "PHP " . phpversion() . " on wasm-posix-kernel\n";
echo "Server: " . ($_SERVER['SERVER_SOFTWARE'] ?? 'unknown') . "\n";
echo "SAPI: " . php_sapi_name() . "\n";
echo "OS: " . PHP_OS . "\n";
echo "Extensions: " . implode(', ', get_loaded_extensions()) . "\n";
