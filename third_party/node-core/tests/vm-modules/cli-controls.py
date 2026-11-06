#!/usr/bin/env python3
"""Run the actual extracted native CLI parser against pinned Node flag behavior.

This compiles the parser/state only. It does not execute the SpiderMonkey JSAPI
property publication or establish VM module engine/runtime conformance.
"""
from pathlib import Path
import argparse, datetime, hashlib, json, os, subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--shell', type=Path, required=True)
parser.add_argument('--node', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=True)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
text = args.shell.read_text()
start = text.index('std::vector<std::string> ParseNodeOptionsEnvVar(')
end = text.index('\n}  // namespace', start)
body = text[start:end]
assert 'static bool PrepareKandeloNodeCLI(' in body
assert 'bool experimentalVmModules = false;' in body
assert 'kandeloNodeCLI.experimentalVmModules = value;' in body
header = '''#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include <iostream>
#include <iomanip>
static bool gKandeloZeroFillBuffers = false;
'''
main = '''
int main(int argc, char** argv) {
  if (!PrepareKandeloNodeCLI(argc, argv)) return 9;
  std::cout << "{\\\"enabled\\\":"
            << (kandeloNodeCLI.experimentalVmModules ? "true" : "false")
            << ",\\\"execArgv\\\":[";
  bool comma = false;
  for (const auto& value : kandeloNodeCLI.execArgs) {
    if (comma) std::cout << ',';
    comma = true; std::cout << std::quoted(value);
  }
  std::cout << "]}\\n";
}
'''
cpp = args.out / 'cli-owner.cpp'
cpp.write_text(header + body + main)
commands = []
def run(name, command, env=None, timeout=15):
    result = subprocess.run(list(map(str, command)), env=env,
                            text=True, capture_output=True, timeout=timeout)
    (args.out / (name + '.log')).write_text(result.stdout + result.stderr)
    commands.append({'name': name, 'command': list(map(str, command)),
                     'exitCode': result.returncode, 'timeoutSeconds': timeout,
                     'reaped': True})
    assert result.returncode == 0, (name, result.stderr)
    return result.stdout
run('compile', ['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                cpp, '-o', args.out / 'cli-owner'], timeout=45)
query = "console.log(JSON.stringify({enabled:typeof require('node:vm').SourceTextModule==='function',execArgv:process.execArgv}))"
positive = '--experimental-vm-modules'
negative = '--no-experimental-vm-modules'
cases = [([], None), ([positive], None), ([negative], None),
         ([positive, negative], None), ([negative, positive], None),
         (['--experimental_vm_modules'], None),
         (['--no_experimental_vm_modules'], None),
         ([positive + '=false'], None), ([negative + '=true'], None),
         ([], positive), ([negative], positive), ([positive], negative),
         ([], positive + ' ' + negative),
         (['--experimental_vm_modules'], '"' + negative + '"')]
base = dict(os.environ)
base.pop('NODE_OPTIONS', None)
base.pop('NODE_REDIRECT_WARNINGS', None)
rows = []
for index, (flags, node_options) in enumerate(cases):
    env = dict(base)
    if node_options is not None:
        env['NODE_OPTIONS'] = node_options
    tail = flags + ['-e', query]
    candidate = json.loads(run(f'candidate-{index}', [args.out / 'cli-owner', *tail], env))
    reference = json.loads(run(f'native-{index}', [args.node, *tail], env))
    assert candidate == reference, (flags, node_options, candidate, reference)
    rows.append({'flags': flags, 'NODE_OPTIONS': node_options,
                 'candidate': candidate, 'reference': reference})
report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'comparisons': len(rows), 'cases': rows, 'commands': commands,
          'shellSha256': sha(args.shell), 'extractedParserSha256': hashlib.sha256(body.encode()).hexdigest(),
          'nativeExecutableSha256': sha(args.node), 'helperSha256': sha(args.out / 'cli-owner'),
          'fixtureSha256': sha(Path(__file__)),
          'scope': 'Actual extracted native CLI state/parser only; no candidate JSAPI property publication or VM/guest/four-host execution'}
(args.out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'nativeCliComparisons': len(rows), 'guestExecution': False}))
