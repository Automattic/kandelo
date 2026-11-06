# Real JWK material import and export

Source126 extends existing private KeyObject handle/material owners with actual
RSA/EC/OKP/AKP imports and exports. Full pinned JS key wrappers dispatch JWK to
native property reads and private byte codecs. The native owner reads fields
once in target order,retains first-getter/RSA masking versus later EC/raw getter
exception precedence and exact algorithm/NUL rules. Native property refusals
become operation failures;proxy exceptions remain pending JS exceptions.

Actual ncrypto/OpenSSL objects own BIGNUM factors,EC group/point/scalars and
raw provider key material. RSA imports check prime product and private factors,
including up to eight other-prime records. EC imports validate points/scalars
and public/private relation. OKP/AKP uses real provider availability and
NewRawJwk relation checks. No JSON key facade or invented private seed exists.
Exports serialize actual fields with target minimal/padded widths,property
order,supported curves,RSA-PSS restrictions and missing-seed errors. Native
own-data-property definitions prevent inherited setters from intercepting JWK
fields,including existing secret exports. RSA other-prime array Set behavior
is retained. Material remains GC-owned through existing engine-only edges.

## Evidence and limits

Root source/generation/bootstrap syntax and621-input guard pass;12package
controls pass. Root frontend run:8new+61affected=69passes. The source-identical
portable owner passed226native comparisons with pinned ncrypto/OpenSSL3.5.9;
root verified exact material/native-fragment/helper/dependency/executable hashes,
not a second compilation/run. The private frontend's19groups passed before
root's combined run. These are separate evidence scopes,not API completion.

Four complete unchanged upstream files ran in both modes after root integration:
all4native runs pass;2candidate runs pass and2fail. EC-private reaches native
signing's separate #slots class owner;multi-prime reaches native WebCrypto then
fails strict candidate/native Buffer prototype equality despite equal bytes.
No assertion,consumer shim or exclusion was added to turn these into passes.
The original private probe gives the same6pass/2fail result and remains saved.

Native-reference getter/definition probes explain source decisions but do not
execute SpiderMonkey. The native-handle fixture only partially models exception
packets;coded getter errors,proxy/GC/OOM/realm paths still need actual guest
checks. Native source uses pending-JS-exception propagation at these boundaries;
portable material tests cannot prove that JSAPI path. No guest/package/engine/
kernel compilation,overall suite or full product rebuild ran in root's slice.

Source117–126remains uncompiled;accepted116is stale. Existing cipher/SQLite/
Error/compression/environment/NodeTiming nonpasses remain open. Pins and frozen
audit unchanged. No performance/complete crypto/four-host claim is made.

## Remaining dependencies

Compile through the normal resolver;exercise native JSAPI/rooted getter/codec/
property/error/ref/GC/OOM/realm/worker behavior on identified artifacts on all
four hosts. Implement actual signing/WebCrypto consumers sharing this same
key owner rather than host-native classes. Store/URI/PKCS11/PKCS12,generation/
exchange/certificates/provider/FIPS,transfer and complete allocation accounting
remain independent work. Public key/storage findings are partial,not closed.
