#!/usr/bin/env python3
"""Stage actual WASI POSIX owners and unchanged uvwasi serdes at vendor boundary."""
from pathlib import Path
import argparse,runpy,shutil
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--shell-dir',type=Path,required=True);args=p.parse_args()
root=Path(__file__).resolve().parent
policy=runpy.run_path(str(root/'generate-wasi-policy.py'))
# Check the complete pin and generated image before staging it.
if (root/'wasi-policy.h').read_text()!=policy['text']:raise ValueError('Stale WASI policy image')
shell=args.shell_dir;shell.mkdir(parents=True,exist_ok=True)
vendor=shell.parents[2]/'third_party/kandelo-node/wasi';vendor.mkdir(parents=True,exist_ok=True)
for name in ['wasi_types.h','wasi_serdes.h']:
 shutil.copyfile(root/'upstream/wasi/deps/uvwasi/include'/name,vendor/name)
shutil.copyfile(root/'upstream/wasi/deps/uvwasi/src/wasi_serdes.c',vendor/'wasi_serdes.c')
shutil.copyfile(root/'upstream/wasi/deps/uvwasi/LICENSE',vendor/'LICENSE')
for name in ['wasi-context.h','wasi-policy.h','wasi-wire.h']:
 text=(root/name).read_text()
 for dep in ['wasi-policy.h','wasi-wire.h']:
  text=text.replace('#include \"'+dep+'\"','#include \"kandelo-node-'+dep+'\"')
 (shell/('kandelo-node-'+name)).write_text(text)
