import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';

const interfaces = networkInterfaces();
const loopback = Object.values(interfaces).flat().find(row => row.address === '::1' && row.internal);
assert.ok(loopback, `IPv6 loopback ::1 is absent from ${JSON.stringify(interfaces)}`);
assert.equal(loopback.family, 'IPv6');
assert.equal(loopback.cidr, '::1/128');
