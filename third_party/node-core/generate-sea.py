#!/usr/bin/env python3
"""Generate only the exact pinned Node image-fuse detector, not SEA assets."""
from pathlib import Path
import hashlib,json,sys
root=Path(__file__).resolve().parent
spec=json.loads((root/'sources.json').read_text())['seaPlatform']
sources={}
for name,item in spec['sources'].items():
    raw=(root/item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest()!=item['sha256']:raise ValueError('SEA source identity mismatch: '+name)
    sources[name]=raw.decode()
sections={}
for name,item in spec['sections'].items():
    text=sources[item['source']]
    if text.count(item['start'])!=1:raise ValueError('Ambiguous SEA source: '+name)
    start=text.index(item['start']);body=text[start:start+item['length']]
    if hashlib.sha256(body.encode()).hexdigest()!=item['sha256']:raise ValueError('SEA source selection mismatch: '+name)
    sections[name]=body
fuse=sections['fuse']
if fuse.count('#include "postject-api.h"')!=1:raise ValueError('Review SEA third-party include boundary')
fuse=fuse.replace('#include "postject-api.h"','#include <kandelo-node/postject/postject-api.h>')
output='// Exact pinned Node image-fuse source; see sea-image-profile.md.\n#ifndef KANDELO_NODE_SEA_IMAGE_PROFILE_H\n#define KANDELO_NODE_SEA_IMAGE_PROFILE_H\n'+fuse+'\nnamespace kandelo::sea {\n'+sections['detector']+'\n}  // namespace kandelo::sea\n#endif\n'
p=root/'sea-image-profile.h'
if '--check' in sys.argv:
    if not p.exists()or p.read_text()!=output:raise SystemExit('SEA image detector header is stale')
else:p.write_text(output)
