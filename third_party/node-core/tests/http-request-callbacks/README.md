# Request body/completion chronology controls

`owner.cpp` executes the real portable parser against actual llhttp objects.
`control.cjs` compares nine request chronology/error/removal/fragment/EOF groups
to exact Node26.13.0 internal HTTPParser and ConnectionsList. Define
HTTP_CALLBACKS=1 for the new callbacks; the preserved deferred baseline uses0.
`frontend.cjs` executes the actual candidate factory and curated variadic
forwarder over explicitly native HTTPParser/IncomingMessage/Socket dependencies.
Its five groups inspect real stream.push/list state, trailer/body bytes,
callback throws and removal. Native prototype.remove is invoked directly so
the public owner method cannot recursively call the fixture dispatcher.

These are focused component controls, with no global setup. They do not
execute production JSAPI/GC/realm/async/fatal/guest callbacks or full Server.
The frontend requires KANDELO_REPO and HTTP_CALLBACK_EVIDENCE, the latter
containing expanded-adapter.js and expanded-before.js produced with the
existing sources.json HTTP parser selection hashes. The portable comparator
requires HTTP_CALLBACK_OWNER and HTTP_CALLBACK_REPORT; EXPECT_MATCH=yes
requires all groups to match. All inputs/artifacts must be pinned separately.
