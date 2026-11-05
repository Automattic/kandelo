'use strict';

const {
  ArrayPrototypeFilter,
  ObjectKeys,
  PromisePrototypeThen,
  PromiseResolve,
  PromiseWithResolvers,
  SafePromiseAllReturnVoid,
  SafePromisePrototypeFinally,
  SafeSet,
  StringPrototypeStartsWith,
  Symbol,
  TypeError,
  TypedArrayPrototypeGetBuffer,
  TypedArrayPrototypeGetByteLength,
  TypedArrayPrototypeGetByteOffset,
  Uint8Array,
} = primordials;

const { TextEncoder } = require('internal/encoding');

const {
  ReadableStream,
  isReadableStream,
  readableStreamDefaultReaderRead,
  kChunk,
  kClose,
  kError,
} = require('internal/webstreams/readablestream');

const {
  WritableStream,
  isWritableStream,
  writableStreamDefaultWriterWriteWithRequest,
} = require('internal/webstreams/writablestream');

const {
  CountQueuingStrategy,
  ByteLengthQueuingStrategy,
} = require('internal/webstreams/queuingstrategies');

const {
  Writable,
  Readable,
  Duplex,
  destroy,
} = require('stream');

const {
  isDestroyed,
  isReadable,
  isWritable,
  isWritableEnded,
} = require('internal/streams/utils');

const {
  Buffer,
} = require('buffer');

const {
  kResolvedPromise,
} = require('internal/webstreams/util');

const {
  isAnyArrayBuffer,
} = require('internal/util/types');

const {
  AbortError,
  ErrnoException,
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_STATE,
    ERR_STREAM_PREMATURE_CLOSE,
  },
} = require('internal/errors');

const {
  getDeprecationWarningEmitter,
  kEmptyObject,
  normalizeEncoding,
  setOwnProperty,
} = require('internal/util');

const {
  validateBoolean,
  validateFunction,
  validateObject,
  validateOneOf,
} = require('internal/validators');

const {
  eos,
  kEosNodeSynchronousCallback,
} = require('internal/streams/end-of-stream');

const { constants: zlib } = require('zlib');
