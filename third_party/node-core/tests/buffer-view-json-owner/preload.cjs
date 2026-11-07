const path=require('node:path');
const B=require(path.join(process.env.KANDELO_BUFFER_REPO,'host/test/fixtures/node-buffer-pool.cjs')).create().Buffer;
globalThis.Buffer=B;require('node:buffer').Buffer=B;
