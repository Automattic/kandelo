#!/usr/bin/env python3
"""Join source consumers, native registration syntax and reviewed routing evidence."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import sys

ROOT = Path('tests/nodejs/upstream')
FROZEN = '5f19f5f1c61cc80adb8e39e1f8470b497f34e9c8'
REUSE = '5674a1b00dbe5a53fd3b8e61bfeb3f8adbf8a898'


def read(path):
    return json.loads(Path(path).read_bytes())


def identity(path):
    path = Path(path)
    data = path.read_bytes()
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def git_source(commit, path):
    data = subprocess.check_output(['git', 'show', commit+':'+path])
    oid = subprocess.check_output(['git', 'rev-parse', commit+':'+path], text=True).strip()
    return data, {'commit': commit, 'path': path, 'gitBlob': oid,
                  'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def reconcile():
    graph = read(ROOT/'dependency-graph.json')
    native = read(ROOT/'native-registration-index.json')
    reviews = read(ROOT/'backend-binding-reviews.json')
    legacy = read(ROOT/'binding-index.json')
    manifest = read('third_party/nodejs/sources.json')
    commit = manifest['source']['commit']
    assert graph['target']['sourceCommit'] == native['target']['sourceCommit'] == reviews['sourceCommit'] == commit
    assert graph['sourceManifestSha256'] == native['sourceManifestSha256'] == identity('third_party/nodejs/sources.json')['sha256']
    assert legacy['target']['commit'] == commit
    assert {r['path']: r['sha256'] for r in legacy['files']} == {
        r['path']: r['sha256'] for r in graph['files']}
    # Reconcile the original reference multiset, not just coincidentally equal totals.
    def old_key(r):
        return json.dumps([r['path'], r['line'], r['kind'], r['target'], r['native']], sort_keys=True)
    old = sorted(old_key(r) for r in legacy['references'])
    primary = sorted(old_key(r) for r in graph['sites'] if r['phase'] == 'loader-call')
    assert old == primary and len(primary) == 3342
    assert {r['name'] for r in legacy['bindings']} == {r['name'] for r in graph['bindings']}
    dispatch = reviews['dispatcher']
    assert identity(dispatch['path'])['sha256'] == dispatch['sha256'], 'dispatcher changed; review its routes again'
    text = Path(dispatch['path']).read_text()
    assert text.count(dispatch['functionStart']) == text.count(dispatch['functionEnd']) == 1
    body = text.split(dispatch['functionStart'], 1)[1].split(dispatch['functionEnd'], 1)[0]
    routes = sorted(set(re.findall(r'name\s*==\s*"([^"]+)"', body)))
    assert routes == dispatch['reviewedRouteNames']
    assert "ERR_KANDELO_NOT_IMPLEMENTED" in body
    previous = read(ROOT/'aliased-engine-check.json')
    matched = next(r for r in previous['testedInputs'] if r['path'] == dispatch['path'])
    assert matched == identity(dispatch['path'])
    native_rows = {r['name']: r for r in native['bindings']}
    consumers = {r['name']: r for r in graph['bindings']}
    review_rows = {r['name']: r for r in reviews['bindings']}
    assert set(native_rows) == set(review_rows)
    assert all(native_rows[name]['hasInitializerSyntax'] for name in consumers)
    completion_data, completion_identity = git_source(FROZEN, 'tests/nodejs/audit/audit-completion.json')
    completion = json.loads(completion_data)
    assert completion['sourceCommit'] == commit and len(completion['familySourceReviews']) == 19
    families = []
    for family, path in completion['familySourceReviews'].items():
        _, source = git_source(FROZEN, path)
        families.append({'family': family, 'historicalSourceReview': source,
                         'currentNativeContractAuditComplete': False})
    reuse_data, reuse_identity = git_source(REUSE, 'docs/nodejs-upstream-reuse-audit.json')
    reuse = json.loads(reuse_data)
    assert reuse['frozenHead'] == FROZEN and len(reuse['prs']) == 33
    prs = [{'number': p['number'], 'title': p['title'], 'head': p.get('head', p.get('headSha')),
            'historicalBackendAssessment': p['backend'],
            'historicalDisposition': p['disposition'],
            'sourceAnchorCount': len(p['sourceAnchors'])} for p in reuse['prs']]
    assert all(re.fullmatch(r'[0-9a-f]{40}', p['head'] or '') for p in prs)
    bindings = []
    for name, n in sorted(native_rows.items()):
        review = review_rows[name]
        registrations = [native['registrations'][i] for i in n['registrationIndexes']]
        route = name in routes
        initializable = n['hasInitializerSyntax']
        state = ('route-present-contract-incomplete' if route else
                 'no-kandelo-dispatch-route' if initializable else
                 'external-reference-record-not-a-loadable-binding')
        contract = review['contractInventory']
        if contract:
            assert (ROOT/contract).is_file()
        bindings.append({'name': name, 'hasLiteralJSConsumer': name in consumers,
                         'consumerSiteIds': consumers.get(name, {}).get('siteIds', []),
                         'directRequestedExportPaths': consumers.get(name, {}).get('directRequestedExportPaths', []),
                         'sourceRegistrationRoles': sorted({r['role'] for r in registrations}),
                         'registrationIndexes': n['registrationIndexes'],
                         'registrationBuildSelectionEvaluated': False,
                         'kandeloSourceRoute': route, 'implementationSurveyState': state,
                         'reviewRoutingFamily': review['reviewRoutingFamily'],
                         'boundedContractInventory': contract,
                         'apiContractComplete': False,
                         'fourHostConformance': 'not established by this source survey'})
    return {
        'schema': 1,
        'scope': 'Reconciled source-level survey. Runtime startup, complete native API contracts and dependency-ordered implementation/validation roadmap remain unfinished.',
        'target': graph['target'],
        'inputs': [identity(p) for p in [ROOT/'dependency-graph.json', ROOT/'native-registration-index.json',
                                       ROOT/'backend-binding-reviews.json', ROOT/'dependency-dynamic-reviews.json',
                                       ROOT/'binding-index.json', Path('third_party/nodejs/sources.json')]],
        'counts': {'registeredSources': 443, 'originalPrimaryReferencesReconciled': len(primary),
                   'lazyRegistrations': graph['counts']['lazyRegistrations'],
                   'transferMetadataSites': graph['counts']['transferMetadataSites'],
                   'literalBindingNames': len(consumers), 'sourceRegistrationNames': len(native_rows),
                   'literalBindingsWithInitializerSyntax': sum(native_rows[n]['hasInitializerSyntax'] for n in consumers),
                   'literalBindingsWithKandeloRoute': sum(n in routes for n in consumers),
                   'literalBindingsWithoutKandeloRoute': sum(n not in routes for n in consumers),
                   'sourceOnlyInitializerNames': [n for n, r in native_rows.items() if n not in consumers and r['hasInitializerSyntax']],
                   'externalReferenceOnlyNames': [n for n, r in native_rows.items() if not r['hasInitializerSyntax']],
                   'historicalFamiliesLinked': len(families), 'historicalPRsLinked': len(prs)},
        'dispatcher': {**dispatch, 'matchesPriorTestedArtifactInput': True,
                       'priorRuntimeReceipt': 'aliased-engine-check.json',
                       'artifact': previous['program']},
        'bindings': bindings,
        'unreviewedDimensionsForEachBinding': reviews['undispatchedOwnershipDimensions'],
        'historicalAudit': {'completionRecord': completion_identity, 'families': families,
                            'oldObservationCountsAreNotCurrentCoverage': True,
                            'oldPublicFrontendsAreNotReuseCandidates': True},
        'historicalPRReuseAudit': {'source': reuse_identity, 'prs': prs,
                                  'use': 'Native mechanisms and tests only after matching original binding contracts; historical assessments are not current implementation or conformance proof'},
        'salvageIndex': {'path': '.context/davao-handoff/BACKEND-SALVAGE.md',
                         'frozenCommit': FROZEN,
                         'mechanisms': ['native callback recovery/scopes', 'retained backing allocations',
                                        'worker startup/transfer publication', 'real socket/request ownership',
                                        'reentrant SQLite native disposal', 'zero-ID deferred callback scope',
                                        'actual nested Wasm/WASI memory and ABI contracts'],
                         'adoption': 'Candidate mechanisms only; adapt behind original source contracts, never old public JS shims or excerpt generators'},
        'runtimeEvidenceAdded': False, 'completeNativeContractCatalog': False,
        'startupAccepted': False, 'commonJsStartupAccepted': False, 'esmStartupAccepted': False,
        'broaderRoadmapExecutionAuthorized': False,
        'next': ['Resolve pending mksnapshot native-source architecture choice, preserving original JavaScript and no-excerpt/no-rewritten-algorithm constraint',
                 'Continue genuine startup and keep CJS/ESM identified-artifact evidence separate',
                 'Audit exports/classes/methods/signatures/errors/ownership/lifecycle across all 77 source registration roles, including four external-reference-only owners',
                 'Reconcile symbolic loader/transfer domains, native/generated registration mechanisms, alias flows and build selection',
                 'After startup, complete per-host catalog and dependency-ordered implementation/validation roadmap; review gate before broader implementation',
                 'Implement nested guest Wasm last unless genuine startup requires it'],
    }


if __name__ == '__main__':
    result = reconcile()
    Path(sys.argv[1]).write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result['counts']))
