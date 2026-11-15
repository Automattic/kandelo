"""Strict reader: keep timing and resource parents separate; retain both orders."""
from pathlib import Path
import json, math, statistics, hashlib, sys
root=Path.cwd(); campaign=Path(sys.argv[1]); output=Path(sys.argv[2]); output.mkdir()
plan=json.loads((campaign/'plan.json').read_text()); runs=json.loads((campaign/'runs.json').read_text())
input_store=Path(sys.argv[3]) if len(sys.argv)>3 else None
def input_bytes(name):
 return (input_store/plan['inputs'][str(name)] if input_store else Path(name)).read_bytes()
expected_cases={(mode,host,backend,cohort,label)
 for mode in ['timing','resource'] for host in ['node','chromium','firefox','webkit']
 for backend in ['sqlite','mariadb'] for cohort in [0,1]
 for label in ['native-file','vm-file','vm-shared']}
assert len(runs)==len(plan['trials'])==len(expected_cases)==96, (len(runs),len(plan['trials']))
assert {(r['mode'],r['host'],r['backend'],r['cohort'],r['label']) for r in runs}==expected_cases
assert all(runs[i-1]['finish']<=runs[i]['start'] for i in range(1,len(runs)))
for name,digest in plan['inputs'].items(): assert hashlib.sha256(input_bytes(name)).hexdigest()==digest,name
fixture=json.loads(input_bytes(Path(plan['fixture'])/'manifest.json'))
labels=['native-file','vm-file','vm-shared']; workloads=['home','article','admin','posts']
records={}; raw=[]
for run,expected in zip(runs,plan['trials']):
 assert run['id']==expected['id'] and run['exit']==0 and run['signal'] is None,run['id']
 file=campaign/run['id']/'result.json'; data=json.loads(file.read_text()); core=data.get('run',data)
 assert core['passed'] and core['destroyed'] and not core['diagnostics'],run['id']
 if run['host']!='node': assert data['passed'] and not data['events'] and not data['boundaryFailures']
 trial=core['trial']; assert trial['passed'] and trial['adminLogin']
 assert trial['label']==run['label'] and trial['backend']==run['backend']
 assert trial['warmup']==4 and trial['rounds']==(7 if run['mode']=='timing' else 3)
 assert 'opcache.validate_timestamps=1\n' in trial['phpIni'] and 'opcache.revalidate_freq=0\n' in trial['phpIni']
 expected_fpm=fixture['ordinaryFpmSha256'] if run['label']=='native-file' else fixture['translatedFpmSha256']
 assert trial['artifactSha256']==expected_fpm and core['identities']['artifact']==expected_fpm
 assert core['identities']['image']==fixture['imageSha256']
 assert core['identities']['kernel']==plan['inputs'][plan['kernel']]
 if run['host']=='node':
  assert core['identities']['profile']==plan['inputs'][str(Path(plan['profile'])/'common-memory-profile.json')]
 else:
  served=[r for r in data['requests'] if r['path'].startswith('/artifacts/')]
  assert served
  for request in served:
   assert request['sha256']==plan['inputs'][str(Path(plan['profile'])/request['path'][11:])]
 statuses=trial['statuses']; assert len(set(s['pid'] for s in statuses))==2
 assert all(s['file_cache_only']==('0' if run['label']=='vm-shared' else '1') for s in statuses)
 samples=trial['samples']; measured=[s for s in samples if s['phase']=='warm']
 assert len(measured)==(28 if run['mode']=='timing' else 12)
 row={**expected,'resultSha256':hashlib.sha256(file.read_bytes()).hexdigest(),'engineVersion':data['version'],
  'originCampaign':run.get('originCampaign',str(campaign)),
  'timerResolutionMs':core['timerResolutionMs'],'startLoad':run['loadBefore'],'endLoad':run['loadAfter'],
  'coldFirstHomepageMs':trial['firstHomepageMs'],'listenerMs':trial['listenerMs']}
 if run['mode']=='timing':
  assert len([s for s in samples if s['phase']=='warmup'])==16
  row['pageMediansMs']={}
  for name in workloads:
   values=[s['elapsedMs'] for s in measured if s['workload']==name]
   assert len(values)==7 and all(math.isfinite(v) and v>0 for v in values)
   row['pageMediansMs'][name]=statistics.median(values)
 else:
  resources=[r for r in core['resources'] if r['phase'].startswith('warm-')]
  assert len(resources)==3
  assert all(r['os']['available'] and r['os']['complete'] for r in resources),run['id']
  row['osEvidence']=[]
  for sample in resources:
   os=sample['os']; path=file.parent/Path(os['raw']).name
   raw_os=json.loads(path.read_text())
   assert raw_os['bytes per unit']==1 and raw_os['total footprint']==os['totalFootprintBytes']
   assert {p['pid'] for p in raw_os['processes']}=={p['pid'] for p in os['processes']}
   assert not raw_os['errors'] and not os['missingPids']
   if run['host']=='webkit':
    assert 'XPC' in os['scope'] and os.get('ownership')
    assert any('WebContent.xpc/' in p['command'] for p in os['detachedXpc'])
    assert {p['pid'] for p in os['detachedXpc']} <= {p['pid'] for p in os['processes']}
   row['osEvidence'].append({'phase':sample['phase'],'rawSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'warnings':raw_os['warnings']})
  row['warmFootprintBytes']=[r['os']['totalFootprintBytes'] for r in resources]
  assert all(math.isfinite(v) and v>0 for v in row['warmFootprintBytes'])
  row['warmFootprintMedianBytes']=statistics.median(row['warmFootprintBytes'])
  row['selectedProcessCounts']=[len(r['os']['processes']) for r in resources]
  row['guestSnapshots']=[]
  for sample in resources:
   inspection=sample['inspection']; fpm=[p for p in inspection['processes'] if '/usr/sbin/php-fpm' in p['cmdline']]
   assert len(fpm)==3
   ids={p['memoryAccounting']['groupId'] for p in fpm}
   groups=[g for g in inspection['memoryGroups'] if g['id'] in ids]
   assert len(groups)==(3 if run['label']=='native-file' else 1)
   mapped=sum(g['uniqueMappedBytes'] for g in groups)
   assert abs(sum(p['memoryAccounting']['attributedBytes'] for p in fpm)-mapped)<.01
   for group in groups:
    assert sum(group[k] for k in ['uniqueMappedBytes','runtimeOverheadBytes','retainedBytes','reusableBytes','unaccountedBytes','unallocatedBytes'])==group['backingBufferBytes']
   row['guestSnapshots'].append({'kernelLinearBytes':sample['kernelLinearBytes'],'fpmMappedBytes':mapped,
     'fpmPrivateBytes':sum(p['memoryAccounting']['privateBytes'] for p in fpm),
     'fpmSharedPerProcessBytes':[p['memoryAccounting']['sharedBytes'] for p in fpm],
     'fpmBackingBufferBytes':sum(g['backingBufferBytes'] for g in groups),
     'groupRuntimeOverheadBytes':sum(g['runtimeOverheadBytes'] for g in groups),
     'groupRetainedBytes':sum(g['retainedBytes'] for g in groups),'groups':groups})
  row['fileCache']=core['fileCache']
  assert (row['fileCache']['files']==0 if run['label']=='vm-shared' else row['fileCache']['files']>=100)
 records[(run['mode'],run['host'],run['backend'],run['cohort'],run['label'])]=row;raw.append(row)

def geo(values):return math.exp(statistics.mean(math.log(v) for v in values))
timing=[];memory=[];pages=[]
for host in ['node','chromium','firefox','webkit']:
 for backend in ['sqlite','mariadb']:
  t={'host':host,'backend':backend,'orders':[]};m={'host':host,'backend':backend,'orders':[]}
  for cohort in [0,1]:
   rows={label:records[('timing',host,backend,cohort,label)] for label in labels}
   t['orders'].append({'cohort':cohort,'fileVsOrdinary':geo([rows['vm-file']['pageMediansMs'][w]/rows['native-file']['pageMediansMs'][w] for w in workloads]),
    'sharedVsOrdinary':geo([rows['vm-shared']['pageMediansMs'][w]/rows['native-file']['pageMediansMs'][w] for w in workloads]),
    'sharedVsFile':geo([rows['vm-shared']['pageMediansMs'][w]/rows['vm-file']['pageMediansMs'][w] for w in workloads]),
    'coldFirstHomepageMs':{l:rows[l]['coldFirstHomepageMs'] for l in labels}})
   rows={label:records[('resource',host,backend,cohort,label)] for label in labels}
   m['orders'].append({'cohort':cohort,'warmFootprintBytes':{l:rows[l]['warmFootprintMedianBytes'] for l in labels},
     'fileVsOrdinary':rows['vm-file']['warmFootprintMedianBytes']/rows['native-file']['warmFootprintMedianBytes'],
     'sharedVsOrdinary':rows['vm-shared']['warmFootprintMedianBytes']/rows['native-file']['warmFootprintMedianBytes'],
     'sharedVsFile':rows['vm-shared']['warmFootprintMedianBytes']/rows['vm-file']['warmFootprintMedianBytes']})
  for w in workloads:
   pages.append({'host':host,'backend':backend,'workload':w,'parentMediansMs':{l:[records[('timing',host,backend,c,l)]['pageMediansMs'][w] for c in [0,1]] for l in labels}})
  timing.append(t);memory.append(m)
summary={'scope':plan['scope'],'parents':len(raw),'measuredLatencyRequests':sum(28 for r in raw if r['mode']=='timing'),
 'collectedParents':plan.get('collectedParents',len(raw)),'excludedResourceParents':plan.get('excludedResourceParents',0),
 'timing':timing,'memory':memory,'pages':pages,'records':raw,
 'limits':['Two fresh parents per case; rounds/checkpoints within a parent are correlated. No confidence intervals or statistical-significance claim.',
 'Ordinary means untranslated Wasm. VM/ordinary includes experimental PHP clock/build differences, not pure translation tax.',
 'OS metric is macOS physical footprint for selected process sets, not pure RSS. Browser detached/XPC processes outside ps ancestry are not established.',
 'Guest cache is empty per parent; OS file/code caches are not flushed. Cold homepage starts at service launch, after image load and binary installation.',
 'Sequential HTTP latency, not saturation throughput. Resource timings are excluded. Native linear-buffer and virtual-page accounting have different coverage.']}
(output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
lines=['| Host / backend | VM FILE / ordinary FILE | VM shared / ordinary FILE | VM shared / VM FILE |','|---|---|---|---|']
for row in timing:
 cells=[]
 for key in ['fileVsOrdinary','sharedVsOrdinary','sharedVsFile']:
  cells.append('<br>'.join(f"Order {o['cohort']+1}: **{o[key]:.3f}×**" for o in row['orders']))
 lines.append(f"| {row['host']} / {row['backend']} | "+' | '.join(cells)+' |')
(output/'latency-table.md').write_text('\n'.join(lines)+'\n')
lines=['| Host / backend | Ordinary FILE | VM FILE | VM shared |','|---|---|---|---|']
for row in memory:
 cells=['<br>'.join(f"Order {o['cohort']+1} footprint: **{o['warmFootprintBytes'][label]/1024**2:.1f} MiB**" for o in row['orders']) for label in labels]
 lines.append(f"| {row['host']} / {row['backend']} | "+' | '.join(cells)+' |')
(output/'footprint-table.md').write_text('\n'.join(lines)+'\n')
lines=['| Host / backend | Ordinary FILE | VM FILE | VM shared |','|---|---|---|---|']
for row in timing:
 cells=['<br>'.join(f"Order {o['cohort']+1} first homepage: **{o['coldFirstHomepageMs'][label]/1000:.2f} s**" for o in row['orders']) for label in labels]
 lines.append(f"| {row['host']} / {row['backend']} | "+' | '.join(cells)+' |')
(output/'startup-table.md').write_text('\n'.join(lines)+'\n')
lines=['| Host / backend / order | VM FILE | VM shared |','|---|---|---|']
for host in ['node','chromium','firefox','webkit']:
 for backend in ['sqlite','mariadb']:
  for cohort in [0,1]:
   cells=[]
   for label in ['vm-file','vm-shared']:
    samples=records[('resource',host,backend,cohort,label)]['guestSnapshots']
    fields=[('fpmMappedBytes','Mapped once'),('fpmPrivateBytes','Private sum'),
      ('fpmBackingBufferBytes','Backing capacity'),('groupRuntimeOverheadBytes','Runtime allocation'),('kernelLinearBytes','Kernel capacity')]
    cell=[f'{title}: **{statistics.median(s[key] for s in samples)/1024**2:.2f} MiB**' for key,title in fields]
    sharing={v for s in samples for v in s['fpmSharedPerProcessBytes']}
    assert len(sharing)==1
    cell.insert(2,f'Shared per FPM process: **{next(iter(sharing))/1024**2:.4f} MiB**')
    cells.append('<br>'.join(cell))
   lines.append(f'| {host} / {backend} / {cohort+1} | '+' | '.join(cells)+' |')
(output/'vm-accounting-table.md').write_text('\n'.join(lines)+'\n')
lines=['| Host / backend / page | Ordinary FILE | VM FILE | VM shared |','|---|---|---|---|']
for row in pages:
 cells=['<br>'.join(f'Order {i+1} median: **{v:.2f} ms**' for i,v in enumerate(row['parentMediansMs'][label])) for label in labels]
 lines.append(f"| {row['host']} / {row['backend']} / {row['workload']} | "+' | '.join(cells)+' |')
(output/'page-table.md').write_text('\n'.join(lines)+'\n')
print('Verified parents:',len(raw),'measured latency requests:',summary['measuredLatencyRequests'])
print('\n'.join((output/'latency-table.md').read_text().splitlines()[:10]))
