# MariaDB

The wasm32 and wasm64 binaries use `/usr` as the guest installation prefix and `/var/lib/mysql` as the default data directory. Directory options such as `--basedir` and `--datadir` can override the defaults. The cross build remaps source filenames in diagnostics to `/usr/src/kandelo-build/mariadb`.
