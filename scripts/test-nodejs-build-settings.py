#!/usr/bin/env python3
from pathlib import Path
import importlib.util,json,tempfile
spec=importlib.util.spec_from_file_location('settings','scripts/generate-nodejs-build-settings.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=Path(tempfile.mkdtemp(prefix='node-build-settings-controls.',dir='.scratch'));observations=[]
def control(name,callback):
 try:callback();observations.append({'name':name,'status':'pass'})
 except Exception as e:observations.append({'name':name,'status':'fail','error':str(e)})
def require(value):
 if not value:raise AssertionError('control assertion failed')
def failure(callback):
 try:callback()
 except ValueError:return
 raise AssertionError('expected invalid input rejection')
def fixture(path):
 p=root/path;p.write_text('ac_add_options --enable-project=js\nac_add_options --disable-jit\nmk_add_options MOZ_OBJDIR=/work/obj\n');return p
config=fixture('mozconfig');env={'CFLAGS':'-I/work/source -DVALUE="hello world"','CXXFLAGS':'-I/deps/ssl/include -fexceptions','LDFLAGS':'/deps/ssl/lib/libcrypto.a -lpthread'}
control('actual-flags-are-retained-and-projected-to-logical-roots',lambda:require(all(s in module.generate(config,['/work=/src','/deps/ssl=/openssl'],env)for s in ['-I/src/source','-I/openssl/include','/openssl/lib/libcrypto.a','-DVALUE=hello world'])))
control('longest-path-map-preserves-selected-dependency-identity',lambda:require('-I/ssl/include'in module.generate(config,['/deps=/all','/deps/ssl=/ssl'],env)))
control('missing-actual-flag-environment-is-rejected',lambda:failure(lambda:module.generate(config,[],{'CFLAGS':'a','CXXFLAGS':'b'})))
control('ambiguous-empty-prefix-path-map-is-rejected',lambda:failure(lambda:module.generate(config,['=/root'],env)))
control('nonabsolute-logical-path-is-rejected',lambda:failure(lambda:module.generate(config,['/work=relative'],env)))
def other_config():
 p=root/'other';p.write_text('ac_add_options --enable-project=browser\n');failure(lambda:module.generate(p,[],env))
control('unrelated-configuration-is-rejected',other_config)
def literal_shell():
 p=root/'must-not-exist';evil=env|{'CFLAGS':f'-DVALUE="$(touch {p})"'};out=module.generate(config,[],evil);require('$(touch'in out and not p.exists())
control('shell-looking-flag-text-is-data-and-never-executed',literal_shell)
def quoting():
 data=env|{'CFLAGS':'-DQUOTE=\\\"value\\\" -DPATH=\\\\dir'};out=module.generate(config,[],data);require('\\"value\\"'in out and '\\\\dir'in out)
control('quote-and-backslash-data-is-escaped-for-cpp-storage',quoting)
report={'controls':len(observations),'failures':sum(r['status']!='pass'for r in observations),'observations':observations};Path(__import__('sys').argv[1]).write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));raise SystemExit(bool(report['failures']))
