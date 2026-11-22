# Pinned upstream Node source

This source-only package declares the Node.js 26.13.0 archive URL and SHA-256.
The normal resolver downloads, verifies and caches it. Consumers use
`kandelo_package_stage_source_dependency` to obtain a private work-directory copy.
There is no checked-in upstream Node source tree.

`sources.json` and `target.json` describe the pinned release and selected inputs
used by bridge generators. `spidermonkey-node-bridge/tools/stage-source-inputs.py`
checks those file identities against the resolver-supplied tree and prepares
transient generator inputs inside the consuming recipe's work directory.

`generate-source-manifest.py` supports reviewed upstream upgrades. It emits
identity metadata from an authenticated archive, not copies of upstream code.
Source availability does not select a runtime profile or prove compatibility.
