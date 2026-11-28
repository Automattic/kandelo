import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import posix from 'node:path/posix';
import win32 from 'node:path/win32';

const require = createRequire(import.meta.url);
assert.strictEqual(path, require('node:path'));
assert.strictEqual(posix, require('node:path/posix'));
assert.strictEqual(win32, require('node:path/win32'));
assert.strictEqual(path.posix, posix);
assert.strictEqual(path.win32, win32);
const windowsFile = 'C:\\temp\\myfile.html';
const windowsHost = process.platform === 'win32';
assert.strictEqual(path, windowsHost ? win32 : posix);
assert.strictEqual(path.basename(windowsFile), windowsHost ? 'myfile.html' : windowsFile);
assert.strictEqual(win32.basename(windowsFile), 'myfile.html');
assert.strictEqual(posix.basename('/tmp/myfile.html'), 'myfile.html');
assert.deepStrictEqual('/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin'.split(posix.delimiter),
                       ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin']);
assert.deepStrictEqual('foo/bar/baz'.split(posix.sep), ['foo', 'bar', 'baz']);
assert.deepStrictEqual('foo\\bar\\baz'.split(win32.sep), ['foo', 'bar', 'baz']);
assert.strictEqual(win32.basename('C:\\foo.HTML', '.html'), 'foo.HTML');
assert.strictEqual(win32.relative('C:\\orandea\\test\\aaa', 'C:\\orandea\\impl\\bbb'),
                   '..\\..\\impl\\bbb');
const sample = { pathname: 'file' };
assert.strictEqual(posix.toNamespacedPath(sample), sample);
assert.strictEqual(posix.toNamespacedPath('/tmp/myfile.html'), '/tmp/myfile.html');
assert.strictEqual(path.resolve(), process.cwd());
