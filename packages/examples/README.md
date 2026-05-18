# Package Examples

Runnable harnesses and package-specific tests live here. They are examples of
ported software running on Kandelo, not the canonical package definitions.

- `../registry/<name>/package.toml` owns package metadata, dependency metadata,
  and release outputs.
- `../registry/<name>/build-*.sh` owns the package-system entry point.
- `./<name>/` owns usage examples, local service launchers, benchmark fixtures,
  and test drivers for a package or package stack.

Root [`../../examples/`](../../examples/) is reserved for small C programs that
exercise the kernel and SDK directly.

| Directory | Purpose |
|-----------|---------|
| `cpython/` | CPython host runner and debug harness |
| `erlang/` | Erlang BEAM runner and ring benchmark fixture |
| `lamp/` | MariaDB + nginx + PHP-FPM + WordPress stack harness |
| `mariadb/` | MariaDB service runner |
| `mariadb-test/` | MariaDB SQL compatibility test driver |
| `nginx/` | nginx and nginx + PHP-FPM service runners |
| `nginx-test/` | nginx wrapper used by automated tests |
| `redis/` | Redis service runner |
| `ruby/` | Ruby host runner |
| `shell/` | Shell runner for dash/bash and userland tools |
| `sqlite-test/` | SQLite SQL compatibility fixtures |
| `wordpress/` | WordPress setup, runners, tests, and benchmark fixtures |
