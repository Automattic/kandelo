"""Select the whole private test main before the original complete GYP make."""
from pathlib import Path
import hashlib,json,os,shutil
work=Path(os.environ['WASM_POSIX_DEP_WORK_DIR']);root=Path(os.environ['KANDELO_NATIVE_TEST_REPO']);package=Path(os.environ['KANDELO_NATIVE_TEST_DIR']);source=work/'node-source';stamp=work/'native-main-installed.json'
assert Path.cwd()==source
if stamp.exists():
 assert hashlib.sha256((source/'src/node_main.cc').read_bytes()).hexdigest()==json.loads(stamp.read_text())['testMainSha256']
else:
 original=source/'src/node_main.cc';before=hashlib.sha256(original.read_bytes()).hexdigest();shutil.copy2(original,work/'original-node_main.cc');shutil.copy2(package/'main.cc',original)
 shutil.copy2(root/'packages/registry/spidermonkey/node-upstream/engine-state.h',source/'src/node-native-test-engine-state.h')
 private=Path(os.environ['WASM_POSIX_SYSROOT'])/'include/mozjs-153/internal';assert (private/'js-confdefs.h').is_file()
 with (source/'out/node.target.mk').open('a') as output:output.write('\n$(obj).target/node/src/node_main.o: GYP_CXXFLAGS += -DMOZ_HAS_MOZGLUE=1 -isystem '+str(private)+' -include '+str(private/'js-confdefs.h')+'\n')
 stamp.write_text(json.dumps({'originalMainSha256':before,'testMainSha256':hashlib.sha256(original.read_bytes()).hexdigest(),'completeOriginalNativeGraph':True,'mainOnlyPrivateHeaderFlags':True},indent=2)+'\n')
 print('node-native-lifetime-tests: selected whole test main before complete original GYP build',flush=True)
