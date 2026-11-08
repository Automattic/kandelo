# Crypto WebIDL key prerequisite

The complete unchanged Node26.13.0 internal/crypto/webidl module is consumed by
the actual KeyObject.toCryptoKey loader. It reuses the existing generic WebIDL
owner, actual native key brands/slots, captured byte getters and private digest
inventory. Selected unchanged crypto/util helpers supply byte-length/max/KMAC
and public-exponent validation; source selection is pinned and checked normally.

No Subtle facade, normalizer/import dispatcher, provider capability, native key
store or FIPS value is fabricated. FIPS-dependent validators reach a concrete
ERR_METHOD_NOT_IMPLEMENTED prerequisite only when invoked; module initialization
captures that function without querying it. All other validators retain original
order. Valid toCryptoKey still requires actual normalization/algorithm owners.
Native component dependencies are not guest/GC/realm/Worker/four-host proof.
