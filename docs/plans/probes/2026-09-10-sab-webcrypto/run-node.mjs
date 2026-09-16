import { runSabWebCryptoProbe } from "./probe-core.mjs";
const rows = await runSabWebCryptoProbe(globalThis.crypto.subtle);
console.log(JSON.stringify({ engine: `node ${process.versions.node}`, rows }, null, 2));
