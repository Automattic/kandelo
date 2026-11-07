from pathlib import Path
import pty, os, subprocess, json, hashlib, termios
root = Path(__file__).resolve().parent
out = Path(os.environ['TTY_OUTPUT_CONTROL_DIR'])
node = Path(os.environ['NODE26_REFERENCE'])
assert hashlib.sha256(node.read_bytes()).hexdigest() == '533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
results, runs, payloads = {}, [], {}
for mode in ('native', 'candidate'):
    original_master, original_slave = pty.openpty()
    replacement_master, replacement_slave = pty.openpty()
    termios.tcsetwinsize(original_master, (25, 81))
    termios.tcsetwinsize(replacement_master, (12, 19))
    with (out / (mode + '-size-owner.report')).open('wb') as report:
        env = dict(os.environ, REPORT_FD=str(report.fileno()), REPLACEMENT_TTY_FD=str(replacement_slave))
        command = [str(node), '--expose-internals', str(root / 'size-owner.cjs'), mode]
        process = subprocess.Popen(command, stdin=original_slave, stdout=original_slave, stderr=subprocess.PIPE,
                                   pass_fds=(report.fileno(), replacement_slave), env=env)
        timed = False
        try:
            _, error = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            timed = True
            process.kill()
            _, error = process.communicate()
    # Keep the real parent slave references until bytes are read: Darwin can
    # discard pending PTY output when its last slave closes.
    bytes_by_terminal = {}
    for name, master in [('original', original_master), ('replacement', replacement_master)]:
        os.set_blocking(master, False)
        data = b''
        while True:
            try:
                chunk = os.read(master, 65536)
            except BlockingIOError:
                break
            if not chunk:
                break
            data += chunk
        bytes_by_terminal[name] = data.decode('ascii')
        (out / (mode + '-size-owner.' + name + '.tty')).write_bytes(data)
    for fd in (original_master, original_slave, replacement_master, replacement_slave):
        os.close(fd)
    (out / (mode + '-size-owner.error')).write_bytes(error)
    packet = json.loads((out / (mode + '-size-owner.report')).read_text())
    results[mode] = packet
    payloads[mode] = bytes_by_terminal
    runs.append(dict(mode=mode, command=command, exit=process.returncode, timedOut=timed,
                     reaped=process.poll() is not None, actualDistinctPtys=True))
(out / 'size-owner-runs.json').write_text(json.dumps(runs, indent=2) + '\n')
(out / 'size-owner-results.json').write_text(json.dumps(dict(results=results, bytes=payloads), indent=2) + '\n')
assert all(run['exit'] == 0 and not run['timedOut'] for run in runs), runs
assert results['native']['rows'] == results['candidate']['rows'], results
assert payloads['native'] == payloads['candidate'] == dict(original='A', replacement='B'), payloads
print(json.dumps(dict(nativeGroups=len(results['native']['rows']), matching=len(results['candidate']['rows']),
                     realFdReuse=True, actualOriginalAndReplacementBytes=payloads, guestConformance=False)))
