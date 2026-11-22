# Native builtin registry helper

This Kandelo-owned helper supports the preserved SpiderMonkey shell integration.
The normal Node executable uses Node's original builtin compiler and startup.

The shell recipe stages its declared node-core-source dependency into its private
work directory, authenticates selected files with stage-source-inputs.py, compiles
the upstream builtin-info metadata tool, and runs generate-nodejs-source-registry.py.
No upstream JavaScript or C++ tree is stored in the checkout or rewritten here.
Generated headers and source copies remain transient package build inputs.

Historical source-registry probes and execution reports are preserved in the
local recovery archive. Current runtime regression owners are the Node native
lifetime-test and installed npm-test packages. This helper is never a fallback
for the upstream Node executable.
