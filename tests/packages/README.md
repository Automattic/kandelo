# Package Integration Tests

Package-specific harnesses and fixtures live here when their main purpose is to
validate kernel behavior or CI readiness through real ported software.

- `cpython/` contains CPython debugging and regression harnesses.
- `bash/`, `dash/`, `coreutils/`, `grep/`, and `sed/` contain shell and core
  Unix utility integration tests.
- `compression/` contains cross-package compression utility tests.
- `erlang/` contains BEAM VM smoke and runtime integration tests.
- `git/` contains Git command and HTTP clone integration tests.
- `mariadb/` contains the MariaDB SQL compatibility test runner.
- `nginx/` contains nginx service tests and the wrapper used by automated
  tests.
- `php/` contains PHP browser integration tests.
- `quickjs/` contains QuickJS and `node.wasm` compatibility tests.
- `sqlite/` contains SQL compatibility fixtures for sqlite3.
- `wordpress/` contains WordPress/PHP integration and browser E2E tests.

Package-owned demo launchers and service configs stay with the package under
`../../packages/registry/<name>/demo/`.
