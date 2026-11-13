/** Private engine/agent integration controls, not public trace_events coverage. */
const setup = `
const api=__kandeloUpstreamTest;
api.initializeContext();
const realm=api.initializeRealm();
const actual={versions:{...realm.process.versions},arch:realm.process.arch,platform:realm.process.platform,pid:realm.process.pid};
function configure(categories='node.native_probe',extra=[]){
  api.configureOptions(['node','--trace-event-file-pattern=/tmp/native-trace-\u0024{pid}-\u0024{rotation}.json',...(categories?['--trace-event-categories='+categories]:[]),...extra],'');
}
function caught(run){try{run()}catch(error){return {name:error.name,message:error.message,code:error.code}}throw Error('expected failure')}
`;
export const traceAgentCases = [
  {name: 'source-agent-streams-events-and-actual-metadata', code: 0, source: setup + `
configure();
Object.defineProperty(realm.process.versions,'node',{value:'user mutation'});
for(const [key,value] of Object.entries({arch:'user arch',platform:'user platform',pid:999999}))Object.defineProperty(realm.process,key,{value});
const state=api.traceAgent('start');gc('shrinking');
const second=api.traceAgent('start');
const trace=JSON.parse(api.traceAgent('stop'));
const closedError=caught(()=>api.traceAgent('start'));
print(JSON.stringify({state,second,actual,trace,closedError}));
`, eventCount: 2},
  {name: 'natural-exit-flushes-and-joins-agent', code: 0, source: setup + `
configure();const state=api.traceAgent('armExit');gc('shrinking');print(JSON.stringify({state,actual}));
`, eventCount: 1},
  {name: 'quit-preserves-status-and-flushes-agent', code: 23, source: setup + `
configure();const state=api.traceAgent('armExit');print(JSON.stringify({state,actual}));quit(23);
`, eventCount: 1},
  {name: 'uncaught-error-preserves-status-and-flushes-agent', code: 3, source: setup + `
configure();const state=api.traceAgent('armExit');print(JSON.stringify({state,actual}));throw Error('TRACE_AGENT_UNCAUGHT');
`, eventCount: 1, stderr: 'TRACE_AGENT_UNCAUGHT'},
  {name: 'process-options-owner-rejects-profile-reconfiguration', code: 0, source: setup + `
configure();const state=api.traceAgent('start');const error=caught(()=>configure('node.changed'));
api.traceAgent('start');const trace=JSON.parse(api.traceAgent('stop'));
print(JSON.stringify({state,actual,trace,error}));
`, eventCount: 2, error: 'Native options profile has already been configured'},
  {name: 'permission-policy-adoption-remains-an-explicit-gap', code: 0, source: setup + `
configure('node.native_probe',['--permission']);const error=caught(()=>api.traceAgent('start'));print(JSON.stringify({error}));
`, error: 'Native tracing permission-policy adoption is not implemented'},
  {name: 'failed-principal-realm-cannot-start-agent', code: 0, source: setup + `
configure();const bootstrapError=caught(()=>api.runNodeBootstrap());const error=caught(()=>api.traceAgent('start'));print(JSON.stringify({error,bootstrapError}));
`, error: 'Previous Node realm initialization failed'},
  {name: 'disabled-category-emits-no-probe-events', code: 0, source: setup + `
configure('other');const state=api.traceAgent('armExit');print(JSON.stringify({state,actual}));
`, eventCount: 0},
  {name: 'default-empty-categories-do-not-start-tracing', code: 0, source: setup + `
configure('');const state=api.traceAgent('start');print(JSON.stringify({state}));
`, disabledByDefault: true},
];

export function verifyTraceAgentResult(control: typeof traceAgentCases[number], result: {
  exitCode: number; stdout: string; stderr: string; hostDiagnostics: unknown[];
}) {
  function require(value: unknown, message: string): asserts value {
    if (!value) throw new Error(message);
  }
  require(result.exitCode === control.code, JSON.stringify(result));
  if (control.stderr) require(result.stderr.includes(control.stderr), JSON.stringify(result));
  else require(result.stderr === '', JSON.stringify(result));
  require(result.hostDiagnostics.length === 0, JSON.stringify(result));
  const lines = result.stdout.trim().split('\n');
  const detail = JSON.parse(lines[0]);
  if (lines.length === 2) {
    require(lines[1].startsWith('TRACE_AGENT_EXIT '), 'missing exit file observation');
    detail.trace = JSON.parse(lines[1].slice('TRACE_AGENT_EXIT '.length));
  } else require(lines.length === 1, 'unexpected stdout');
  if (control.error) require(detail.error.message === control.error, JSON.stringify(detail));
  if (detail.closedError) require(detail.closedError.message === 'Native tracing process has shut down', JSON.stringify(detail));
  if (control.disabledByDefault) require(detail.state.path === `/tmp/native-trace-${detail.state.pid}-1.json` && detail.state.categories === '' && detail.state.enabled === false, JSON.stringify(detail));
  if (control.eventCount !== undefined) {
    const events = detail.trace.traceEvents as any[];
    require(Array.isArray(events) && events.length > 0, 'no actual trace file events');
    const probes = events.filter(event => event.name === 'native-engine-agent-probe');
    require(probes.length === control.eventCount, JSON.stringify(events));
    require(detail.state.enabled === (control.eventCount > 0), 'category state mismatch');
    require(detail.state.pid === detail.actual.pid && detail.state.tid > 0, 'guest identity mismatch');
    require(detail.state.path === `/tmp/native-trace-${detail.actual.pid}-1.json`, 'original path expansion mismatch');
    require(events.every(event => event.pid === detail.actual.pid && event.tid === detail.state.tid), 'event identity mismatch');
    const metadata = events.filter(event => event.name === 'node').map(event => event.args.process);
    require(metadata.length > 0, 'missing source process metadata');
    for (const process of metadata) {
      require(JSON.stringify(process.versions) === JSON.stringify(detail.actual.versions), 'tracing read mutable JS versions or reported unavailable dependencies');
      require(process.arch === detail.actual.arch && process.platform === detail.actual.platform, 'trace platform differs from process');
      require(!Object.hasOwn(process.versions, 'v8'), 'standalone tracing library advertised a V8 JS engine');
    }
    for (const event of probes) require(event.ts > 0 && event.tts >= 0 && event.cat === 'node.native_probe', 'invalid native event');
  }
  return detail;
}
