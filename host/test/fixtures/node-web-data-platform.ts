import { readFileSync } from 'node:fs';
import { constants } from 'node:os';
import * as util from 'node:util';
import * as crypto from 'node:crypto';
import assert from 'node:assert';
import * as streams from 'node:stream/web';
import { MessagePort, markAsUncloneable } from 'node:worker_threads';

const bootstrap = readFileSync(new URL('../../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('../../../third_party/node-core/node-core.js', import.meta.url), 'utf8');
const factories = Function(`${bundle};return { values:_createNodeValuesPlatform, file:_createNodeFilePlatform, formdata:_createNodeFormDataPlatform };`)();

export function createWebDataPlatform() {
  const values = factories.values({ process, Buffer, util, inspection: util, os: {},
    signals: constants.signals, getDOMException: () => DOMException });
  const modes = new WeakMap<object, number>();
  const clone = { protocol: {
    kClone: Symbol('clone'), kDeserialize: Symbol('deserialize'),
    markTransferMode(object: object, cloneable: boolean, transferable: boolean) {
      modes.set(object, Number(cloneable) * 2 + Number(transferable));
      // The native reference enforces actual clone refusal for newly created
      // FormData. Cloneable File payloads are exercised explicitly below;
      // this fixture does not emulate the guest serializer or messaging.
      if (!cloneable && !transferable) markAsUncloneable(object);
    },
  } };
  const a = bootstrap.indexOf('const _nodeBodyData ='), b = bootstrap.indexOf("if (typeof globalThis.Blob === 'undefined')", a);
  if (a < 0 || b < 0) throw Error('Missing shared body source boundary');
  // Native Web Streams and text codecs are explicit boundaries. Production
  // supplies the shared guest stream graph and its configured text codecs.
  const body = Function('_nodeClonePlatform', '_nodeWebPlatform', bootstrap.slice(a, b) + ';return _nodeBodyData;')
    (clone, { streams });
  const file = factories.file({ blob: body, values, inspection: util, clone });
  const formdata = factories.formdata({ Blob: body.Blob, File: file.File,
    ReadableStream: streams.ReadableStream, URL, URLSearchParams, AbortSignal, MessagePort,
    values, assert, util, crypto, clone });
  return { Blob: body.Blob, File: file.File, FormData: formdata.FormData, Headers: formdata.headers.Headers, headerInternals: formdata.headers, formDataInternals: formdata, cloneOwner: clone, modes,
    clonePayload(value: any) {
      const payload = value[clone.protocol.kClone]();
      const copy = structuredClone(payload.data);
      const result = new file.TransferableFile();
      result[clone.protocol.kDeserialize](copy);
      return result;
    } };
}
