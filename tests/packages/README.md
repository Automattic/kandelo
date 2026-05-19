# Package Integration Tests

Package-specific harnesses and fixtures live here when their main purpose is to
validate kernel behavior or CI readiness through real ported software.

- `cpython/` contains CPython debugging and regression harnesses.
- `mariadb/` contains the MariaDB SQL compatibility test runner.
- `nginx/` contains the nginx wrapper used by automated tests.
- `sqlite/` contains SQL compatibility fixtures for sqlite3.
- `wordpress/` contains WordPress/PHP integration and browser E2E tests.

Package-owned demo launchers and service configs stay with the package under
`../../packages/registry/<name>/demo/`.
