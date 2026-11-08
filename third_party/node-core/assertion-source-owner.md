# Assertion source-expression owner

This bounded source slice replaces the always-undefined assertion expression
provider with an actual native caller/source owner and the pinned Node26.13.0
Acorn first-expression tokenizer. It does not implement public
Error.captureStackTrace, mapped stacks or complete AssertionError diagnostics.

The pinned target path is assert/utils.js getErrMessage -> error_source.js ->
node_errors.cc GetErrorSourcePositions. Native V8 creates a Message from the
captured error stack and obtains its source line; it does not read current fs
bytes to discover the original expression. A native reference using Module._compile
and different current file contents confirms that retained-source behavior.

The Kandelo private owner matches the actual assertion boundary JSFunction with
FrameIter::matchCallee and uses the next real visible script frame. It does not
select function names, a fixed frame count, filename aliases or SavedFrame text.
The actual caller JSScript is rooted before allocation; its PC, SourceExtent
sourceStart/line/UTF-16 column and retained ScriptSource establish the source
line and zero-origin tokenizer column. The SourceExtent gives the coordinates
of sourceStart: on that line the raw source prefix plus actual PC-column delta
handles compilation option offsets; subsequent lines use their actual
one-origin PC column. CRLF and Unicode line separators are scanned as source
line boundaries. No wrapper constant is added or removed.

Source is borrowed only through an actual rooted string and AutoStableStringChars;
the selected line is copied before realm wrapping/publication. No raw characters
survive into JS or a WeakMap. The native result is a null-prototype private
location object. The assertion adapter associates it with the assertion's real
scratch object in a captured SafeWeakMap, so it adds no reflected error/object
slot or global filename-to-script cache. This private capture is not a successful
public stack-capture facade.

The complete pinned error_source.js and Acorn distribution/license are retained
and hash-verified. The selected member-token/first-expression algorithm remains
unchanged. Source-map reconstruction is not activated. The existing undefined
message fallback and AssertionError native-stack guard remain explicit; only
the private assertion capture call changes to the genuine native owner.

## Admission and remaining obligations

Unavailable retained source, inaccessible/muted frames, saturated coordinates,
missing cutoff/caller or an unrepresentable source extent produce no expression.
Only actual UTF-16 source input is admitted now: CJS/VM normal native compilation
uses UTF-16 SourceText, while UTF-8 extent conversion remains an implementation
gap. Permission denial and pending native/OOM/control exceptions propagate;
they are not converted into absent source. No source-loading hook or host fs
fallback runs from this diagnostic path.

All new C++ remains uncompiled/unexecuted. Actual optimized frame/clone/GC/realm
behavior, CJS source-note columns, wrapper variants, async and mapped stacks,
UTF-8 source, eval and complete VM diagnostics require validation. One native
VM.Script first-line lineOffset50/columnOffset7 observation produced an
ERR_INVALID_ARG_TYPE message for undefined assertion text. It is retained as
a concrete native diagnostic/parity question, not a passing offset case or an
accepted platform boundary. Exact source capture availability/semantics must
be reconciled against that native observation; real source metadata alone
does not prove full diagnostic equality.

No compiler, generator, package or guest suite ran for this slice. One pinned
native process provided four ownership/message observations, including that
negative VM-offset outcome. No existing upstream assertion was changed.
