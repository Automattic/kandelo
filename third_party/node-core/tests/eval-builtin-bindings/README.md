# Pinned Module builtin-binding controls

control.cjs native|before|after REPO under exact Node26.13.0 --expose-internals
compares fourteen semantic rows. Native uses actual internal helpers/Module;
candidate uses actual generated module-record owner plus production bootstrap
CJS loader from the existing node-module-records fixture. Native fs, VM, URL,
package parser/error brands and builtin resources remain explicit dependencies.
The fixture's existing skipESMResolver:true omits only unrelated ESM setup; it
never synthesizes an ESM graph, changes production source or claims ESM support.
Historical default ESM fixture-setup nonpasses remain with the original sys /
module graph evidence; this focused task does not repeat them.

The selected builtin list is a deliberate public Module.builtinModules mutation
on both subjects, restored after each group. Every actual helper Module._load
request remains observed; pre-acquired fs reference avoids contaminating only
native's spy with the fixture's own comparison require. Preserve initial11/14
comparison and correction explanation. Baseline0/14 means new private helper
seams are absent: existing internal makeRequireFunction code still works for
ordinary CJS and is not claimed absent. Exit0 alone does not count as conformance.

Four additional candidate cases execute the exact production eval branch
with absent, empty/nonempty and main-vs-worker actual parser-owned presence inputs. They are bridge
checks, not four matched native groups or guest CLI runs. preload.cjs selects
only addBuiltinLibsToObject for unchanged native REPL-autolibs consumption. Native
REPL/default evaluator/VM/capture/stream owns everything else; root public repl
remains unactivated. No assertion/source pin or native platform identity changes.
