# Optional Fortran compiler

This recipe builds Flang 23.1.3 and its Fortran runtime as a guest package.
It is not included in the standard shell or selected by automatic local
builds, including `local-build --all`. Node's JavaScript, TypeScript and npm
support does not depend on it. The C/C++ SDK remains in the shell.

Build the package explicitly through the normal resolver when needed:

```sh
bash .agents/skills/porting-software-to-kandelo/scripts/build-package.sh flang-browser-bundle
```

The output is `flang.zip`; this does not install it into an existing machine
or add it to the standard shell. Integrating an optional Fortran image remains
future work. The existing recipe, source patches and runtime smoke fixtures
are retained.

The build compiles native generators and a guest compiler, so it is expensive.
The latest integration run was deferred before guest compilation finished.
The earlier instrumentation-budget failure and the compiler's execution still
need qualification before claiming this optional package works.
