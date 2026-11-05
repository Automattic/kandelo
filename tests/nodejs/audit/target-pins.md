# Target and reference pin audit

Source research date: November 3, 2026. No target file was changed and no
reference executable was run for this review.

The official [release index](https://nodejs.org/dist/index.json) lists
`v26.13.0`, released October 28, 2026, with `lts: "Lithium"`.
The [release page](https://github.com/nodejs/node/releases/tag/v26.13.0)
and its [exact commit](https://github.com/nodejs/node/commit/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b)
agree with the checked-in target. The requested Node 26 LTS designation
is consistent with these official sources at the research date.

The source and four native archive hashes in
`packages/registry/node-compat/target.json` match the official
[release checksums](https://nodejs.org/dist/v26.13.0/SHASUMS256.txt):

| Archive | SHA-256 |
|---|---|
| `node-v26.13.0.tar.gz` | `986ead18ef18256831bae3e57d94aef680a7b84cfd4044f3e8471f833fbd7191` |
| `node-v26.13.0-darwin-arm64.tar.gz` | `d38bd5e5a2ddce6bbb5ce45e46e208337da4d51fffe611e567fd32073d6439f6` |
| `node-v26.13.0-darwin-x64.tar.gz` | `525c9b29bb0263d687de60a4cec0e2a6db876a8eb032369e5795eca71e7c358e` |
| `node-v26.13.0-linux-arm64.tar.gz` | `439e9c438acdf6a6ffe47418da709153d66c4bed812e30a473faacb107dd2791` |
| `node-v26.13.0-linux-x64.tar.gz` | `5848553868b402d3fabb5b09270649977780a390f832155721025a08b5104455` |

`verifiedOn` in the target remains October 31. That records the existing
pin's earlier verification; this document records the new research without
changing build/cache inputs. The read-only archive/extraction audit in
`pin-file-correspondence.json` verifies the source archive checksum, all
38,413 regular files and 4,270 directories, with no mismatches or extra
entries. All 291 source files then recorded by this audit match both
the archive bytes and their recorded SHA-256 identities.

## Evidence identity and remaining review

The saved discovery capture identifies a Darwin arm64 native executable
at SHA-256
`533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4`.
See `../outline/manifest.json`, `referenceCapture`. Its own-property/depth
limits, unevaluated getters and absent flag-enabled captures remain audit
questions. It cannot establish complete exports or behavior for other
platforms.

The current source candidate is revision 45 according to the existing
source-status records and has not been built. Earlier controls and suites
refer to earlier sources/artifacts. Their results must retain those
identities. This audit does not claim the current source candidate passes
any native or four-host runtime comparison.

The local Darwin arm64 reference archive matches its official pinned
checksum. Its archived and extracted `bin/node` both match the executable
hash above and the saved inventory capture identity. The other three
archive pins match the official checksums; their local artifacts were not
present or executed. The CommonJS context fence is outside the verified
source tree at `.context/nodejs-lts-cache-v2/package.json`; it does not
modify upstream sources or tests.

Historical complete and interrupted runs retain separate accounting in
`historical-evidence-index.json`. Activation/launcher and assertion
coverage still require source review. No new capture or execution is
authorized during this audit.
