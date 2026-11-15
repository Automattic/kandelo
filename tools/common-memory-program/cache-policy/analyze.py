import json, math, statistics, sys
from pathlib import Path
root, dest = map(Path, sys.argv[1:]); dest.mkdir(parents=True, exist_ok=True)
plan=json.loads((root/'summary.json').read_text())
assert plan['passed'], plan.get('error')
assert len(plan['trials'])==24
arms=['shared-empty-no-file','shared-empty-file','shared-seeded-file','ordinary-seeded-file']
rows=[]; raw={}
for t in plan['trials']:
 r=json.loads((root/t['id']/'result.json').read_text());tr=r['trial']
 assert r['passed'] and r['destroyed'] and not r['diagnostics'] and not r['diagnostic']
 assert tr['passed'] and tr['timestampPolicy']['passed']
 assert 'opcache.validate_timestamps=1\n' in tr['phpIni'] and 'opcache.revalidate_freq=0\n' in tr['phpIni']
 assert len(set(s['pid'] for s in tr['statuses']))==2
 row={'id':t['id'],'backend':t['backend'],'arm':t['name'],'order':t['order'],'mode':t['mode'],
      'firstHomepageMs':tr['firstHomepageMs'],'imageAndServiceMs':r['imageAndServiceMs'],'initMs':r['initMs'],
      'compressedImageBytes':r['imageCompressedBytes'],'loadBefore':r['loadBefore'],'loadAfter':r['loadAfter']}
 for w in ['home','article','admin','posts']:
  v=[s['elapsedMs'] for s in tr['samples'] if s['phase']=='warm' and s['workload']==w]
  assert len(v)==5
  row[w+'Ms']=statistics.median(v)
 if t['mode']=='resource':
  assert r['os']['complete']
  row.update(footprintBytes=r['os']['totalFootprintBytes'],kernelLinearBytes=r['kernelLinearBytes'],fileCache=r['fileCacheInventory'])
 raw[t['id']]=r;rows.append(row)
result={'scope':plan['scope'],'parents':len(rows),'timingParents':16,'resourceParents':8,'rows':rows,'backends':{}}
for backend in ['sqlite','mariadb']:
 groups={a:[r for r in rows if r['backend']==backend and r['arm']==a and r['mode']=='timing'] for a in arms}
 resources={r['arm']:r for r in rows if r['backend']==backend and r['mode']=='resource'}
 aggregates={a:{k:statistics.geometric_mean(r[k] for r in g) for k in ['initMs','firstHomepageMs','imageAndServiceMs','homeMs','articleMs','adminMs','postsMs']} for a,g in groups.items()}
 for a in arms:
  assert len(groups[a])==2
  aggregates[a]['footprintBytes']=resources[a]['footprintBytes']
  aggregates[a]['compressedImageBytes']=resources[a]['compressedImageBytes']
  aggregates[a]['kernelLinearBytes']=resources[a]['kernelLinearBytes']
  aggregates[a]['fileCache']=resources[a]['fileCache']
 ratios={}
 for reference in ['shared-empty-no-file','shared-empty-file','ordinary-seeded-file']:
  ratio={k:aggregates['shared-seeded-file'][k]/aggregates[reference][k] for k in ['firstHomepageMs','imageAndServiceMs','homeMs','articleMs','adminMs','postsMs','footprintBytes']}
  ratio['warmAggregate']=statistics.geometric_mean(ratio[w+'Ms'] for w in ['home','article','admin','posts'])
  ratio['byOrder']=[{k:next(r[k] for r in groups['shared-seeded-file'] if r['order']==order)/next(r[k] for r in groups[reference] if r['order']==order) for k in ['firstHomepageMs','imageAndServiceMs','homeMs','articleMs','adminMs','postsMs']} for order in [0,1]]
  ratios[reference]=ratio
 result['backends'][backend]={'aggregates':aggregates,'seededRatiosTo':ratios}
(dest/'analysis.json').write_text(json.dumps(result,indent=2)+'\n')
lines=['| Backend / arm | Image initialization + preparation + first homepage | Service to first homepage | Warm home | Warm article | Warm admin | Warm REST | OS footprint (one separate parent) |','|---|---:|---:|---:|---:|---:|---:|---:|']
for backend, data in result['backends'].items():
 for a,v in data['aggregates'].items():
  lines.append('| '+backend+' / '+a+' | Startup: '+f"{v['imageAndServiceMs']/1000:.3f} s"+' | Service: '+f"{v['firstHomepageMs']/1000:.3f} s"+' | '+ ' | '.join(f'{w}: {v[w+"Ms"]:.1f} ms' for w in ['home','article','admin','posts'])+f" | Footprint: {v['footprintBytes']/1048576:.1f} MiB |")
lines+=['','| Backend / seeded shared reference | Startup ratio | Service ratio | Four-page warm ratio | Footprint ratio (one sample) |','|---|---:|---:|---:|---:|']
for backend,data in result['backends'].items():
 for a,v in data['seededRatiosTo'].items():
  lines.append(f"| {backend} / {a} | Startup: {v['imageAndServiceMs']:.4f}× | Service: {v['firstHomepageMs']:.4f}× | Warm: {v['warmAggregate']:.4f}× | Footprint: {v['footprintBytes']:.4f}× |")
(dest/'tables.md').write_text('\n'.join(lines)+'\n')
print(json.dumps({k:v['seededRatiosTo'] for k,v in result['backends'].items()},indent=2))
