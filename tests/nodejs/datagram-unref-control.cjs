'use strict';
// The runner must require exit 0 before its deadline. An unreferenced live
// receive endpoint owns its fd, but cannot by itself keep the guest alive.
const dgram = require('node:dgram');
const socket = dgram.createSocket('udp4');
socket.bindSync({ address: '127.0.0.1' });
socket.unref();
setImmediate(() => console.log('datagram unref: live receive endpoint permits idle exit'));
