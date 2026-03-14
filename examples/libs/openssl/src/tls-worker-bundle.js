"use strict";

// src/tls-worker.ts
var import_node_worker_threads = require("node:worker_threads");

// src/tls/shims.ts
function concatUint8Arrays(arrays) {
  let totalLength = 0;
  arrays.forEach((a) => totalLength += a.length);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  arrays.forEach((a) => {
    result.set(a, offset);
    offset += a.length;
  });
  return result;
}
function concatArrayBuffers(buffers) {
  return concatUint8Arrays(
    buffers.map((b) => {
      if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      return new Uint8Array(b);
    })
  ).buffer;
}
var logger = {
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  info: (...args) => console.info(...args),
  debug: (...args) => console.debug(...args),
  log: (...args) => console.log(...args)
};

// src/tls/utils.ts
function flipObject(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [v, k]));
}
function as2Bytes(value) {
  return new Uint8Array([value >> 8 & 255, value & 255]);
}
function as3Bytes(value) {
  return new Uint8Array([
    value >> 16 & 255,
    value >> 8 & 255,
    value & 255
  ]);
}
function as8Bytes(value) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, BigInt(value), false);
  return new Uint8Array(buffer);
}
var ArrayBufferReader = class {
  view;
  offset = 0;
  buffer;
  constructor(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
  }
  readUint8() {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }
  readUint16() {
    const value = this.view.getUint16(this.offset);
    this.offset += 2;
    return value;
  }
  readUint32() {
    const value = this.view.getUint32(this.offset);
    this.offset += 4;
    return value;
  }
  readUint8Array(length) {
    const value = this.buffer.slice(this.offset, this.offset + length);
    this.offset += length;
    return new Uint8Array(value);
  }
  isFinished() {
    return this.offset >= this.buffer.byteLength;
  }
};
var ArrayBufferWriter = class {
  buffer;
  view;
  uint8Array;
  offset = 0;
  constructor(length) {
    this.buffer = new ArrayBuffer(length);
    this.uint8Array = new Uint8Array(this.buffer);
    this.view = new DataView(this.buffer);
  }
  writeUint8(value) {
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }
  writeUint16(value) {
    this.view.setUint16(this.offset, value);
    this.offset += 2;
  }
  writeUint32(value) {
    this.view.setUint32(this.offset, value);
    this.offset += 4;
  }
  writeUint8Array(value) {
    this.uint8Array.set(value, this.offset);
    this.offset += value.length;
  }
};

// src/tls/extensions/types.ts
var ExtensionTypes = {
  server_name: 0,
  max_fragment_length: 1,
  client_certificate_url: 2,
  trusted_ca_keys: 3,
  truncated_hmac: 4,
  status_request: 5,
  user_mapping: 6,
  client_authz: 7,
  server_authz: 8,
  cert_type: 9,
  supported_groups: 10,
  ec_point_formats: 11,
  srp: 12,
  signature_algorithms: 13,
  use_srtp: 14,
  heartbeat: 15,
  application_layer_protocol_negotiation: 16,
  status_request_v2: 17,
  signed_certificate_timestamp: 18,
  client_certificate_type: 19,
  server_certificate_type: 20,
  padding: 21,
  encrypt_then_mac: 22,
  extended_master_secret: 23,
  token_binding: 24,
  cached_info: 25,
  tls_its: 26,
  compress_certificate: 27,
  record_size_limit: 28,
  pwd_protect: 29,
  pwo_clear: 30,
  password_salt: 31,
  ticket_pinning: 32,
  tls_cert_with_extern_psk: 33,
  delegated_credential: 34,
  session_ticket: 35,
  TLMSP: 36,
  TLMSP_proxying: 37,
  TLMSP_delegate: 38,
  supported_ekt_ciphers: 39,
  pre_shared_key: 41,
  early_data: 42,
  supported_versions: 43,
  cookie: 44,
  psk_key_exchange_modes: 45,
  reserved: 46,
  certificate_authorities: 47,
  oid_filters: 48,
  post_handshake_auth: 49,
  signature_algorithms_cert: 50,
  key_share: 51,
  transparency_info: 52,
  connection_id: 54,
  renegotiation_info: 65281
};
var ExtensionNames = flipObject(ExtensionTypes);

// src/tls/extensions/0_server_name.ts
var ServerNameTypes = {
  host_name: 0
};
var ServerNameNames = flipObject(ServerNameTypes);
var ServerNameExtension = class {
  static decodeFromClient(data) {
    const view = new DataView(data.buffer);
    let offset = 0;
    const listLength = view.getUint16(offset);
    offset += 2;
    const serverNameList = [];
    while (offset < listLength + 2) {
      const nameType = data[offset];
      offset += 1;
      const valueLength = view.getUint16(offset);
      offset += 2;
      const value = data.slice(offset, offset + valueLength);
      offset += valueLength;
      switch (nameType) {
        case ServerNameTypes.host_name:
          serverNameList.push({
            name_type: ServerNameNames[nameType],
            name: {
              host_name: new TextDecoder().decode(value)
            }
          });
          break;
        default:
          throw new Error(`Unsupported name type ${nameType}`);
      }
    }
    return { server_name_list: serverNameList };
  }
  /**
   * Encode the server_name extension
   *
   * +------------------------------------+
   * | Extension Type (server_name) [2B]  |
   * | 0x00 0x00                          |
   * +------------------------------------+
   * | Extension Length             [2B]  |
   * | 0x00 0x00                          |
   * +------------------------------------+
   */
  static encodeForClient(serverNames) {
    if (serverNames?.server_name_list.length) {
      throw new Error(
        "Encoding non-empty lists for ClientHello is not supported yet. Only empty lists meant for ServerHello are supported today."
      );
    }
    const writer = new ArrayBufferWriter(4);
    writer.writeUint16(ExtensionTypes.server_name);
    writer.writeUint16(0);
    return writer.uint8Array;
  }
};

// src/tls/extensions/11_ec_point_formats.ts
var ECPointFormats = {
  uncompressed: 0,
  ansiX962_compressed_prime: 1,
  ansiX962_compressed_char2: 2
};
var ECPointFormatNames = flipObject(ECPointFormats);
var ECPointFormatsExtension = class {
  /**
   * +--------------------------------------------------+
   * | Payload Length                            [2B]   |
   * +--------------------------------------------------+
   * | EC Point Formats Length                   [1B]   |
   * +--------------------------------------------------+
   * | EC Point Format 1                         [1B]   |
   * +--------------------------------------------------+
   * | EC Point Format 2                         [1B]   |
   * +--------------------------------------------------+
   * | ...                                              |
   * +--------------------------------------------------+
   * | EC Point Format n                         [1B]   |
   * +--------------------------------------------------+
   */
  static decodeFromClient(data) {
    const reader = new ArrayBufferReader(data.buffer);
    const length = reader.readUint8();
    const formats = [];
    for (let i = 0; i < length; i++) {
      const format = reader.readUint8();
      if (format in ECPointFormatNames) {
        formats.push(ECPointFormatNames[format]);
      }
    }
    return formats;
  }
  /**
   * Encode the ec_point_formats extension
   *
   * +--------------------------------------------------+
   * | Extension Type (ec_point_formats)         [2B]   |
   * | 0x00 0x0B                                        |
   * +--------------------------------------------------+
   * | Body Length                               [2B]   |
   * +--------------------------------------------------+
   * | EC Point Format Length                    [1B]   |
   * +--------------------------------------------------+
   * | EC Point Format                           [1B]   |
   * +--------------------------------------------------+
   */
  static encodeForClient(format) {
    const writer = new ArrayBufferWriter(6);
    writer.writeUint16(ExtensionTypes.ec_point_formats);
    writer.writeUint16(2);
    writer.writeUint8(1);
    writer.writeUint8(ECPointFormats[format]);
    return writer.uint8Array;
  }
};

// src/tls/extensions/65281_renegotiation_info.ts
var RenegotiationInfoExtension = {
  decodeFromClient(data) {
    const length = data[0] ?? 0;
    return {
      renegotiatedConnection: data.slice(1, 1 + length)
    };
  },
  /**
   * For an initial connection (not a renegotiation), the server responds
   * with an empty renegotiated_connection field.
   */
  encodeForClient() {
    const extensionType = ExtensionTypes.renegotiation_info;
    const extensionData = new Uint8Array([0]);
    return new Uint8Array([
      extensionType >> 8 & 255,
      extensionType & 255,
      0,
      extensionData.length,
      ...extensionData
    ]);
  }
};

// src/tls/cipher-suites.ts
var CipherSuites = {
  TLS1_CK_PSK_WITH_RC4_128_SHA: 138,
  TLS1_CK_PSK_WITH_3DES_EDE_CBC_SHA: 139,
  TLS1_CK_PSK_WITH_AES_128_CBC_SHA: 140,
  TLS1_CK_PSK_WITH_AES_256_CBC_SHA: 141,
  TLS1_CK_DHE_PSK_WITH_RC4_128_SHA: 142,
  TLS1_CK_DHE_PSK_WITH_3DES_EDE_CBC_SHA: 143,
  TLS1_CK_DHE_PSK_WITH_AES_128_CBC_SHA: 144,
  TLS1_CK_DHE_PSK_WITH_AES_256_CBC_SHA: 145,
  TLS1_CK_RSA_PSK_WITH_RC4_128_SHA: 146,
  TLS1_CK_RSA_PSK_WITH_3DES_EDE_CBC_SHA: 147,
  TLS1_CK_RSA_PSK_WITH_AES_128_CBC_SHA: 148,
  TLS1_CK_RSA_PSK_WITH_AES_256_CBC_SHA: 149,
  TLS1_CK_PSK_WITH_AES_128_GCM_SHA256: 168,
  TLS1_CK_PSK_WITH_AES_256_GCM_SHA384: 169,
  TLS1_CK_DHE_PSK_WITH_AES_128_GCM_SHA256: 170,
  TLS1_CK_DHE_PSK_WITH_AES_256_GCM_SHA384: 171,
  TLS1_CK_RSA_PSK_WITH_AES_128_GCM_SHA256: 172,
  TLS1_CK_RSA_PSK_WITH_AES_256_GCM_SHA384: 173,
  TLS1_CK_PSK_WITH_AES_128_CBC_SHA256: 174,
  TLS1_CK_PSK_WITH_AES_256_CBC_SHA384: 175,
  TLS1_CK_PSK_WITH_NULL_SHA256: 176,
  TLS1_CK_PSK_WITH_NULL_SHA384: 177,
  TLS1_CK_DHE_PSK_WITH_AES_128_CBC_SHA256: 178,
  TLS1_CK_DHE_PSK_WITH_AES_256_CBC_SHA384: 179,
  TLS1_CK_DHE_PSK_WITH_NULL_SHA256: 180,
  TLS1_CK_DHE_PSK_WITH_NULL_SHA384: 181,
  TLS1_CK_RSA_PSK_WITH_AES_128_CBC_SHA256: 182,
  TLS1_CK_RSA_PSK_WITH_AES_256_CBC_SHA384: 183,
  TLS1_CK_RSA_PSK_WITH_NULL_SHA256: 184,
  TLS1_CK_RSA_PSK_WITH_NULL_SHA384: 185,
  TLS1_CK_PSK_WITH_NULL_SHA: 44,
  TLS1_CK_DHE_PSK_WITH_NULL_SHA: 45,
  TLS1_CK_RSA_PSK_WITH_NULL_SHA: 46,
  TLS1_CK_RSA_WITH_AES_128_SHA: 47,
  TLS1_CK_DH_DSS_WITH_AES_128_SHA: 48,
  TLS1_CK_DH_RSA_WITH_AES_128_SHA: 49,
  TLS1_CK_DHE_DSS_WITH_AES_128_SHA: 50,
  TLS1_CK_DHE_RSA_WITH_AES_128_SHA: 51,
  TLS1_CK_ADH_WITH_AES_128_SHA: 52,
  TLS1_CK_RSA_WITH_AES_256_SHA: 53,
  TLS1_CK_DH_DSS_WITH_AES_256_SHA: 54,
  TLS1_CK_DH_RSA_WITH_AES_256_SHA: 55,
  TLS1_CK_DHE_DSS_WITH_AES_256_SHA: 56,
  TLS1_CK_DHE_RSA_WITH_AES_256_SHA: 57,
  TLS1_CK_ADH_WITH_AES_256_SHA: 58,
  TLS1_CK_RSA_WITH_NULL_SHA256: 59,
  TLS1_CK_RSA_WITH_AES_128_SHA256: 60,
  TLS1_CK_RSA_WITH_AES_256_SHA256: 61,
  TLS1_CK_DH_DSS_WITH_AES_128_SHA256: 62,
  TLS1_CK_DH_RSA_WITH_AES_128_SHA256: 63,
  TLS1_CK_DHE_DSS_WITH_AES_128_SHA256: 64,
  TLS1_CK_RSA_WITH_CAMELLIA_128_CBC_SHA: 65,
  TLS1_CK_DH_DSS_WITH_CAMELLIA_128_CBC_SHA: 66,
  TLS1_CK_DH_RSA_WITH_CAMELLIA_128_CBC_SHA: 67,
  TLS1_CK_DHE_DSS_WITH_CAMELLIA_128_CBC_SHA: 68,
  TLS1_CK_DHE_RSA_WITH_CAMELLIA_128_CBC_SHA: 69,
  TLS1_CK_ADH_WITH_CAMELLIA_128_CBC_SHA: 70,
  TLS1_CK_DHE_RSA_WITH_AES_128_SHA256: 103,
  TLS1_CK_DH_DSS_WITH_AES_256_SHA256: 104,
  TLS1_CK_DH_RSA_WITH_AES_256_SHA256: 105,
  TLS1_CK_DHE_DSS_WITH_AES_256_SHA256: 106,
  TLS1_CK_DHE_RSA_WITH_AES_256_SHA256: 107,
  TLS1_CK_ADH_WITH_AES_128_SHA256: 108,
  TLS1_CK_ADH_WITH_AES_256_SHA256: 109,
  TLS1_CK_RSA_WITH_CAMELLIA_256_CBC_SHA: 132,
  TLS1_CK_DH_DSS_WITH_CAMELLIA_256_CBC_SHA: 133,
  TLS1_CK_DH_RSA_WITH_CAMELLIA_256_CBC_SHA: 134,
  TLS1_CK_DHE_DSS_WITH_CAMELLIA_256_CBC_SHA: 135,
  TLS1_CK_DHE_RSA_WITH_CAMELLIA_256_CBC_SHA: 136,
  TLS1_CK_ADH_WITH_CAMELLIA_256_CBC_SHA: 137,
  TLS1_CK_RSA_WITH_SEED_SHA: 150,
  TLS1_CK_DH_DSS_WITH_SEED_SHA: 151,
  TLS1_CK_DH_RSA_WITH_SEED_SHA: 152,
  TLS1_CK_DHE_DSS_WITH_SEED_SHA: 153,
  TLS1_CK_DHE_RSA_WITH_SEED_SHA: 154,
  TLS1_CK_ADH_WITH_SEED_SHA: 155,
  TLS1_CK_RSA_WITH_AES_128_GCM_SHA256: 156,
  TLS1_CK_RSA_WITH_AES_256_GCM_SHA384: 157,
  TLS1_CK_DHE_RSA_WITH_AES_128_GCM_SHA256: 158,
  TLS1_CK_DHE_RSA_WITH_AES_256_GCM_SHA384: 159,
  TLS1_CK_DH_RSA_WITH_AES_128_GCM_SHA256: 160,
  TLS1_CK_DH_RSA_WITH_AES_256_GCM_SHA384: 161,
  TLS1_CK_DHE_DSS_WITH_AES_128_GCM_SHA256: 162,
  TLS1_CK_DHE_DSS_WITH_AES_256_GCM_SHA384: 163,
  TLS1_CK_DH_DSS_WITH_AES_128_GCM_SHA256: 164,
  TLS1_CK_DH_DSS_WITH_AES_256_GCM_SHA384: 165,
  TLS1_CK_ADH_WITH_AES_128_GCM_SHA256: 166,
  TLS1_CK_ADH_WITH_AES_256_GCM_SHA384: 167,
  TLS1_CK_RSA_WITH_AES_128_CCM: 49308,
  TLS1_CK_RSA_WITH_AES_256_CCM: 49309,
  TLS1_CK_DHE_RSA_WITH_AES_128_CCM: 49310,
  TLS1_CK_DHE_RSA_WITH_AES_256_CCM: 49311,
  TLS1_CK_RSA_WITH_AES_128_CCM_8: 49312,
  TLS1_CK_RSA_WITH_AES_256_CCM_8: 49313,
  TLS1_CK_DHE_RSA_WITH_AES_128_CCM_8: 49314,
  TLS1_CK_DHE_RSA_WITH_AES_256_CCM_8: 49315,
  TLS1_CK_PSK_WITH_AES_128_CCM: 49316,
  TLS1_CK_PSK_WITH_AES_256_CCM: 49317,
  TLS1_CK_DHE_PSK_WITH_AES_128_CCM: 49318,
  TLS1_CK_DHE_PSK_WITH_AES_256_CCM: 49319,
  TLS1_CK_PSK_WITH_AES_128_CCM_8: 49320,
  TLS1_CK_PSK_WITH_AES_256_CCM_8: 49321,
  TLS1_CK_DHE_PSK_WITH_AES_128_CCM_8: 49322,
  TLS1_CK_DHE_PSK_WITH_AES_256_CCM_8: 49323,
  TLS1_CK_ECDHE_ECDSA_WITH_AES_128_CCM: 49324,
  TLS1_CK_ECDHE_ECDSA_WITH_AES_256_CCM: 49325,
  TLS1_CK_ECDHE_ECDSA_WITH_AES_128_CCM_8: 49326,
  TLS1_CK_ECDHE_ECDSA_WITH_AES_256_CCM_8: 49327,
  TLS1_CK_RSA_WITH_CAMELLIA_128_CBC_SHA256: 186,
  TLS1_CK_DH_DSS_WITH_CAMELLIA_128_CBC_SHA256: 187,
  TLS1_CK_DH_RSA_WITH_CAMELLIA_128_CBC_SHA256: 188,
  TLS1_CK_DHE_DSS_WITH_CAMELLIA_128_CBC_SHA256: 189,
  TLS1_CK_DHE_RSA_WITH_CAMELLIA_128_CBC_SHA256: 190,
  TLS1_CK_ADH_WITH_CAMELLIA_128_CBC_SHA256: 191,
  TLS1_CK_RSA_WITH_CAMELLIA_256_CBC_SHA256: 192,
  TLS1_CK_DH_DSS_WITH_CAMELLIA_256_CBC_SHA256: 193,
  TLS1_CK_DH_RSA_WITH_CAMELLIA_256_CBC_SHA256: 194,
  TLS1_CK_DHE_DSS_WITH_CAMELLIA_256_CBC_SHA256: 195,
  TLS1_CK_DHE_RSA_WITH_CAMELLIA_256_CBC_SHA256: 196,
  TLS1_CK_ADH_WITH_CAMELLIA_256_CBC_SHA256: 197,
  TLS1_CK_ECDH_ECDSA_WITH_NULL_SHA: 49153,
  TLS1_CK_ECDH_ECDSA_WITH_RC4_128_SHA: 49154,
  TLS1_CK_ECDH_ECDSA_WITH_DES_192_CBC3_SHA: 49155,
  TLS1_CK_ECDH_ECDSA_WITH_AES_128_CBC_SHA: 49156,
  TLS1_CK_ECDH_ECDSA_WITH_AES_256_CBC_SHA: 49157,
  TLS1_CK_ECDHE_ECDSA_WITH_NULL_SHA: 49158,
  TLS1_CK_ECDHE_ECDSA_WITH_RC4_128_SHA: 49159,
  TLS1_CK_ECDHE_ECDSA_WITH_DES_192_CBC3_SHA: 49160,
  TLS1_CK_ECDHE_ECDSA_WITH_AES_128_CBC_SHA: 49161,
  TLS1_CK_ECDHE_ECDSA_WITH_AES_256_CBC_SHA: 49162,
  TLS1_CK_ECDH_RSA_WITH_NULL_SHA: 49163,
  TLS1_CK_ECDH_RSA_WITH_RC4_128_SHA: 49164,
  TLS1_CK_ECDH_RSA_WITH_DES_192_CBC3_SHA: 49165,
  TLS1_CK_ECDH_RSA_WITH_AES_128_CBC_SHA: 49166,
  TLS1_CK_ECDH_RSA_WITH_AES_256_CBC_SHA: 49167,
  TLS1_CK_ECDHE_RSA_WITH_NULL_SHA: 49168,
  TLS1_CK_ECDHE_RSA_WITH_RC4_128_SHA: 49169,
  TLS1_CK_ECDHE_RSA_WITH_DES_192_CBC3_SHA: 49170,
  TLS1_CK_ECDHE_RSA_WITH_AES_128_CBC_SHA: 49171,
  TLS1_CK_ECDHE_RSA_WITH_AES_256_CBC_SHA: 49172,
  TLS1_CK_ECDH_anon_WITH_NULL_SHA: 49173,
  TLS1_CK_ECDH_anon_WITH_RC4_128_SHA: 49174,
  TLS1_CK_ECDH_anon_WITH_DES_192_CBC3_SHA: 49175,
  TLS1_CK_ECDH_anon_WITH_AES_128_CBC_SHA: 49176,
  TLS1_CK_ECDH_anon_WITH_AES_256_CBC_SHA: 49177,
  TLS1_CK_SRP_SHA_WITH_3DES_EDE_CBC_SHA: 49178,
  TLS1_CK_SRP_SHA_RSA_WITH_3DES_EDE_CBC_SHA: 49179,
  TLS1_CK_SRP_SHA_DSS_WITH_3DES_EDE_CBC_SHA: 49180,
  TLS1_CK_SRP_SHA_WITH_AES_128_CBC_SHA: 49181,
  TLS1_CK_SRP_SHA_RSA_WITH_AES_128_CBC_SHA: 49182,
  TLS1_CK_SRP_SHA_DSS_WITH_AES_128_CBC_SHA: 49183,
  TLS1_CK_SRP_SHA_WITH_AES_256_CBC_SHA: 49184,
  TLS1_CK_SRP_SHA_RSA_WITH_AES_256_CBC_SHA: 49185,
  TLS1_CK_SRP_SHA_DSS_WITH_AES_256_CBC_SHA: 49186,
  TLS1_CK_ECDHE_ECDSA_WITH_AES_128_SHA256: 49187,
  TLS1_CK_ECDHE_ECDSA_WITH_AES_256_SHA384: 49188,
  TLS1_CK_ECDH_ECDSA_WITH_AES_128_SHA256: 49189,
  TLS1_CK_ECDH_ECDSA_WITH_AES_256_SHA384: 49190,
  TLS1_CK_ECDHE_RSA_WITH_AES_128_SHA256: 49191,
  TLS1_CK_ECDHE_RSA_WITH_AES_256_SHA384: 49192,
  TLS1_CK_ECDH_RSA_WITH_AES_128_SHA256: 49193,
  TLS1_CK_ECDH_RSA_WITH_AES_256_SHA384: 49194,
  TLS1_CK_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256: 49195,
  TLS1_CK_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384: 49196,
  TLS1_CK_ECDH_ECDSA_WITH_AES_128_GCM_SHA256: 49197,
  TLS1_CK_ECDH_ECDSA_WITH_AES_256_GCM_SHA384: 49198,
  TLS1_CK_ECDHE_RSA_WITH_AES_128_GCM_SHA256: 49199,
  TLS1_CK_ECDHE_RSA_WITH_AES_256_GCM_SHA384: 49200,
  TLS1_CK_ECDH_RSA_WITH_AES_128_GCM_SHA256: 49201,
  TLS1_CK_ECDH_RSA_WITH_AES_256_GCM_SHA384: 49202,
  TLS1_CK_ECDHE_PSK_WITH_RC4_128_SHA: 49203,
  TLS1_CK_ECDHE_PSK_WITH_3DES_EDE_CBC_SHA: 49204,
  TLS1_CK_ECDHE_PSK_WITH_AES_128_CBC_SHA: 49205,
  TLS1_CK_ECDHE_PSK_WITH_AES_256_CBC_SHA: 49206,
  TLS1_CK_ECDHE_PSK_WITH_AES_128_CBC_SHA256: 49207,
  TLS1_CK_ECDHE_PSK_WITH_AES_256_CBC_SHA384: 49208,
  TLS1_CK_ECDHE_PSK_WITH_NULL_SHA: 49209,
  TLS1_CK_ECDHE_PSK_WITH_NULL_SHA256: 49210,
  TLS1_CK_ECDHE_PSK_WITH_NULL_SHA384: 49211,
  TLS1_CK_ECDHE_ECDSA_WITH_CAMELLIA_128_CBC_SHA256: 49266,
  TLS1_CK_ECDHE_ECDSA_WITH_CAMELLIA_256_CBC_SHA384: 49267,
  TLS1_CK_ECDH_ECDSA_WITH_CAMELLIA_128_CBC_SHA256: 49268,
  TLS1_CK_ECDH_ECDSA_WITH_CAMELLIA_256_CBC_SHA384: 49269,
  TLS1_CK_ECDHE_RSA_WITH_CAMELLIA_128_CBC_SHA256: 49270,
  TLS1_CK_ECDHE_RSA_WITH_CAMELLIA_256_CBC_SHA384: 49271,
  TLS1_CK_ECDH_RSA_WITH_CAMELLIA_128_CBC_SHA256: 49272,
  TLS1_CK_ECDH_RSA_WITH_CAMELLIA_256_CBC_SHA384: 49273,
  TLS1_CK_PSK_WITH_CAMELLIA_128_CBC_SHA256: 49300,
  TLS1_CK_PSK_WITH_CAMELLIA_256_CBC_SHA384: 49301,
  TLS1_CK_DHE_PSK_WITH_CAMELLIA_128_CBC_SHA256: 49302,
  TLS1_CK_DHE_PSK_WITH_CAMELLIA_256_CBC_SHA384: 49303,
  TLS1_CK_RSA_PSK_WITH_CAMELLIA_128_CBC_SHA256: 49304,
  TLS1_CK_RSA_PSK_WITH_CAMELLIA_256_CBC_SHA384: 49305,
  TLS1_CK_ECDHE_PSK_WITH_CAMELLIA_128_CBC_SHA256: 49306,
  TLS1_CK_ECDHE_PSK_WITH_CAMELLIA_256_CBC_SHA384: 49307,
  TLS1_CK_ECDHE_RSA_WITH_CHACHA20_POLY1305: 52392,
  TLS1_CK_ECDHE_ECDSA_WITH_CHACHA20_POLY1305: 52393,
  TLS1_CK_DHE_RSA_WITH_CHACHA20_POLY1305: 52394,
  TLS1_CK_PSK_WITH_CHACHA20_POLY1305: 52395,
  TLS1_CK_ECDHE_PSK_WITH_CHACHA20_POLY1305: 52396,
  TLS1_CK_DHE_PSK_WITH_CHACHA20_POLY1305: 52397,
  TLS1_CK_RSA_PSK_WITH_CHACHA20_POLY1305: 52398
};
var CipherSuitesNames = flipObject(CipherSuites);

// src/tls/extensions/10_supported_groups.ts
var SupportedGroups = {
  secp256r1: 23,
  secp384r1: 24,
  secp521r1: 25,
  x25519: 29,
  x448: 30
};
var SupportedGroupsNames = flipObject(SupportedGroups);
var SupportedGroupsExtension = class {
  /**
   * +--------------------------------------------------+
   * | Payload Length                            [2B]   |
   * +--------------------------------------------------+
   * | Supported Groups List Length              [2B]   |
   * +--------------------------------------------------+
   * | Supported Group 1                         [2B]   |
   * +--------------------------------------------------+
   * | Supported Group 2                         [2B]   |
   * +--------------------------------------------------+
   * | ...                                              |
   * +--------------------------------------------------+
   * | Supported Group n                         [2B]   |
   * +--------------------------------------------------+
   */
  static decodeFromClient(data) {
    const reader = new ArrayBufferReader(data.buffer);
    reader.readUint16();
    const groups = [];
    while (!reader.isFinished()) {
      const group = reader.readUint16();
      if (!(group in SupportedGroupsNames)) {
        continue;
      }
      groups.push(SupportedGroupsNames[group]);
    }
    return groups;
  }
  /**
   * +--------------------------------------------------+
   * | Extension Type (supported_groups)         [2B]   |
   * | 0x00 0x0A                                        |
   * +--------------------------------------------------+
   * | Extension Length                          [2B]   |
   * +--------------------------------------------------+
   * | Selected Group                            [2B]   |
   * +--------------------------------------------------+
   */
  static encodeForClient(group) {
    const writer = new ArrayBufferWriter(6);
    writer.writeUint16(ExtensionTypes.supported_groups);
    writer.writeUint16(2);
    writer.writeUint16(SupportedGroups[group]);
    return writer.uint8Array;
  }
};

// src/tls/extensions/13_signature_algorithms.ts
var SignatureAlgorithms = {
  anonymous: 0,
  rsa: 1,
  dsa: 2,
  ecdsa: 3
};
var SignatureAlgorithmsNames = flipObject(SignatureAlgorithms);
var HashAlgorithms = {
  none: 0,
  md5: 1,
  sha1: 2,
  sha224: 3,
  sha256: 4,
  sha384: 5,
  sha512: 6
};
var HashAlgorithmsNames = flipObject(HashAlgorithms);
var SignatureAlgorithmsExtension = class {
  /**
   * Binary layout:
   *
   * +------------------------------------+
   * | Payload Length              [2B]   |
   * +------------------------------------+
   * | Hash Algorithm 1            [1B]   |
   * | Signature Algorithm 1       [1B]   |
   * +------------------------------------+
   * | Hash Algorithm 2            [1B]   |
   * | Signature Algorithm 2       [1B]   |
   * +------------------------------------+
   * | ...                                |
   * +------------------------------------+
   */
  static decodeFromClient(data) {
    const reader = new ArrayBufferReader(data.buffer);
    reader.readUint16();
    const parsedAlgorithms = [];
    while (!reader.isFinished()) {
      const hash = reader.readUint8();
      const algorithm = reader.readUint8();
      if (!SignatureAlgorithmsNames[algorithm]) {
        continue;
      }
      if (!HashAlgorithmsNames[hash]) {
        logger.warn(`Unknown hash algorithm: ${hash}`);
        continue;
      }
      parsedAlgorithms.push({
        algorithm: SignatureAlgorithmsNames[algorithm],
        hash: HashAlgorithmsNames[hash]
      });
    }
    return parsedAlgorithms;
  }
  /**
   * +--------------------------------------------------+
   * | Extension Type (signature_algorithms)     [2B]   |
   * | 0x00 0x0D                                        |
   * +--------------------------------------------------+
   * | Body Length                               [2B]   |
   * +--------------------------------------------------+
   * | Hash Algorithm                            [1B]   |
   * | Signature Algorithm                       [1B]   |
   * +--------------------------------------------------+
   */
  static encodeforClient(hash, algorithm) {
    const writer = new ArrayBufferWriter(6);
    writer.writeUint16(ExtensionTypes.signature_algorithms);
    writer.writeUint16(2);
    writer.writeUint8(HashAlgorithms[hash]);
    writer.writeUint8(SignatureAlgorithms[algorithm]);
    return writer.uint8Array;
  }
};

// src/tls/extensions/parse-extensions.ts
var TLSExtensionsHandlers = {
  server_name: ServerNameExtension,
  signature_algorithms: SignatureAlgorithmsExtension,
  supported_groups: SupportedGroupsExtension,
  ec_point_formats: ECPointFormatsExtension,
  renegotiation_info: RenegotiationInfoExtension
};
function parseClientHelloExtensions(data) {
  const reader = new ArrayBufferReader(data.buffer);
  const parsed = [];
  while (!reader.isFinished()) {
    const initialOffset = reader.offset;
    const extensionType = reader.readUint16();
    const extensionTypeName = ExtensionNames[extensionType];
    const extensionLength = reader.readUint16();
    const extensionBytes = reader.readUint8Array(extensionLength);
    if (!(extensionTypeName in TLSExtensionsHandlers)) {
      continue;
    }
    const handler = TLSExtensionsHandlers[extensionTypeName];
    parsed.push({
      type: extensionTypeName,
      data: handler.decodeFromClient(extensionBytes),
      raw: data.slice(initialOffset, initialOffset + 4 + extensionLength)
    });
  }
  return parsed;
}

// src/tls/1_2/prf.ts
async function tls12Prf(secret, label, seed, outputLength) {
  const seedBytes = concatArrayBuffers([label, seed]);
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  let A = seedBytes;
  const resultBuffers = [];
  while (concatArrayBuffers(resultBuffers).byteLength < outputLength) {
    A = await hmacSha256(hmacKey, A);
    const hmacInput = concatArrayBuffers([A, seedBytes]);
    const fragment = await hmacSha256(hmacKey, hmacInput);
    resultBuffers.push(fragment);
  }
  const fullResult = concatArrayBuffers(resultBuffers);
  return fullResult.slice(0, outputLength);
}
async function hmacSha256(key, data) {
  return await crypto.subtle.sign(
    { name: "HMAC", hash: "SHA-256" },
    key,
    data
  );
}

// src/tls/1_2/types.ts
var CompressionMethod = {
  Null: 0,
  Deflate: 1
};
var AlertLevels = {
  Warning: 1,
  Fatal: 2
};
var AlertLevelNames = flipObject(AlertLevels);
var AlertDescriptions = {
  CloseNotify: 0,
  UnexpectedMessage: 10,
  BadRecordMac: 20,
  DecryptionFailed: 21,
  RecordOverflow: 22,
  DecompressionFailure: 30,
  HandshakeFailure: 40,
  NoCertificate: 41,
  BadCertificate: 42,
  UnsupportedCertificate: 43,
  CertificateRevoked: 44,
  CertificateExpired: 45,
  CertificateUnknown: 46,
  IllegalParameter: 47,
  UnknownCa: 48,
  AccessDenied: 49,
  DecodeError: 50,
  DecryptError: 51,
  ExportRestriction: 60,
  ProtocolVersion: 70,
  InsufficientSecurity: 71,
  InternalError: 80,
  UserCanceled: 90,
  NoRenegotiation: 100,
  UnsupportedExtension: 110
};
var AlertDescriptionNames = flipObject(AlertDescriptions);
var ContentTypes = {
  ChangeCipherSpec: 20,
  Alert: 21,
  Handshake: 22,
  ApplicationData: 23
};
var HandshakeType = {
  HelloRequest: 0,
  ClientHello: 1,
  ServerHello: 2,
  Certificate: 11,
  ServerKeyExchange: 12,
  CertificateRequest: 13,
  ServerHelloDone: 14,
  CertificateVerify: 15,
  ClientKeyExchange: 16,
  Finished: 20
};
var ECCurveTypes = {
  /**
   * Indicates the elliptic curve domain parameters are
   * conveyed verbosely, and the underlying finite field is a prime
   * field.
   */
  ExplicitPrime: 1,
  /**
   * Indicates the elliptic curve domain parameters are
   * conveyed verbosely, and the underlying finite field is a
   * characteristic-2 field.
   */
  ExplicitChar2: 2,
  /**
   * Indicates that a named curve is used.  This option
   * SHOULD be used when applicable.
   */
  NamedCurve: 3
  /**
   * Values 248 through 255 are reserved for private use.
   */
};
var ECNamedCurves = {
  sect163k1: 1,
  sect163r1: 2,
  sect163r2: 3,
  sect193r1: 4,
  sect193r2: 5,
  sect233k1: 6,
  sect233r1: 7,
  sect239k1: 8,
  sect283k1: 9,
  sect283r1: 10,
  sect409k1: 11,
  sect409r1: 12,
  secp256k1: 22,
  secp256r1: 23,
  secp384r1: 24,
  secp521r1: 25,
  arbitrary_explicit_prime_curves: 65281,
  arbitrary_explicit_char2_curves: 65282
};

// src/tls/1_2/connection.ts
var TLSConnectionClosed = class extends Error {
};
var TLS_Version_1_2 = new Uint8Array([3, 3]);
var generalEcdheKeyPair = crypto.subtle.generateKey(
  {
    name: "ECDH",
    namedCurve: "P-256"
    // Use secp256r1 curve
  },
  true,
  // Extractable
  ["deriveKey", "deriveBits"]
  // Key usage
);
var TLS_1_2_Connection = class {
  /**
   * Sequence number of the last received TLS  record.
   *
   * AES-GCM requires transmitting the sequence number
   * in the clear in the additional data to prevent a
   * potential attacker from re-transmitting the same
   * TLS record in a different context.
   */
  receivedRecordSequenceNumber = 0;
  /**
   * Sequence number of the last sent TLS record.
   *
   * AES-GCM requires transmitting the sequence number
   * in the clear in the additional data to prevent a
   * potential attacker from re-transmitting the same
   * TLS record in a different context.
   */
  sentRecordSequenceNumber = 0;
  /**
   * Encryption keys for this connection derived during
   * the TLS handshake.
   */
  sessionKeys;
  /**
   * Whether this connection have been closed.
   */
  closed = false;
  /**
   * Bytes received from the client but not yet parsed
   * as TLS records.
   */
  receivedBytesBuffer = new Uint8Array();
  /**
   * TLS records received from the client but not yet
   * parsed as TLS messages.
   */
  receivedTLSRecords = [];
  /**
   * TLS messages can span multiple TLS records. This
   * map holds partial TLS messages that are still incomplete
   * after parsing one or more TLS records.
   */
  partialTLSMessages = {};
  /**
   * A log of all the exchanged TLS handshake messages.
   * This is required to build the Finished message and
   * verify the integrity of the handshake.
   */
  handshakeMessages = [];
  /**
   * Maximum chunk size supported by the cipher suite used
   * in this TLS implementation.
   */
  MAX_CHUNK_SIZE = 1024 * 16;
  /**
   * The client end of the TLS connection.
   * This is where the WASM module can write and read the
   * encrypted data.
   */
  clientEnd = {
    // We don't need to chunk the encrypted data.
    // OpenSSL already done that for us.
    upstream: new TransformStream(),
    downstream: new TransformStream()
  };
  clientDownstreamWriter = this.clientEnd.downstream.writable.getWriter();
  clientUpstreamReader = this.clientEnd.upstream.readable.getReader();
  /**
   * The server end of the TLS connection.
   * This is where the JavaScript handler can write and read the
   * unencrypted data.
   */
  serverEnd = {
    upstream: new TransformStream(),
    /**
     * Chunk the data before encrypting it. The
     * TLS1_CK_ECDHE_RSA_WITH_AES_128_GCM_SHA256 cipher suite
     * only supports up to 16KB of data per record.
     *
     * This will spread some messages across multiple records,
     * but TLS supports it so that's fine.
     */
    downstream: chunkStream(this.MAX_CHUNK_SIZE)
  };
  serverUpstreamWriter = this.serverEnd.upstream.writable.getWriter();
  constructor() {
    const tlsConnection = this;
    this.serverEnd.downstream.readable.pipeTo(
      new WritableStream({
        async write(chunk) {
          await tlsConnection.writeTLSRecord(
            ContentTypes.ApplicationData,
            chunk
          );
        },
        async abort(e) {
          tlsConnection.clientDownstreamWriter.releaseLock();
          tlsConnection.clientEnd.downstream.writable.abort(e);
          tlsConnection.close();
        },
        close() {
          tlsConnection.close();
        }
      })
    ).catch(() => {
    });
  }
  /**
   * Marks this connections as closed and closes all the associated
   * streams.
   */
  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.clientDownstreamWriter.close();
    } catch {
    }
    try {
      await this.clientUpstreamReader.cancel();
    } catch {
    }
    try {
      await this.serverUpstreamWriter.close();
    } catch {
    }
    try {
      await this.clientEnd.upstream.readable.cancel();
    } catch {
    }
    try {
      await this.clientEnd.downstream.writable.close();
    } catch {
    }
  }
  /**
   * TLS handshake as per RFC 5246.
   *
   * https://datatracker.ietf.org/doc/html/rfc5246#section-7.4
   */
  async TLSHandshake(certificatePrivateKey, certificatesDER) {
    const clientHelloRecord = await this.readNextHandshakeMessage(
      HandshakeType.ClientHello
    );
    if (!clientHelloRecord.body.cipher_suites.length) {
      throw new Error(
        "Client did not propose any supported cipher suites."
      );
    }
    const serverRandom = crypto.getRandomValues(new Uint8Array(32));
    await this.writeTLSRecord(
      ContentTypes.Handshake,
      MessageEncoder.serverHello(
        clientHelloRecord.body,
        serverRandom,
        CompressionMethod.Null
      )
    );
    await this.writeTLSRecord(
      ContentTypes.Handshake,
      MessageEncoder.certificate(certificatesDER)
    );
    const ecdheKeyPair = await generalEcdheKeyPair;
    const clientRandom = clientHelloRecord.body.random;
    const serverKeyExchange = await MessageEncoder.ECDHEServerKeyExchange(
      clientRandom,
      serverRandom,
      ecdheKeyPair,
      certificatePrivateKey
    );
    await this.writeTLSRecord(ContentTypes.Handshake, serverKeyExchange);
    await this.writeTLSRecord(
      ContentTypes.Handshake,
      MessageEncoder.serverHelloDone()
    );
    const clientKeyExchangeRecord = await this.readNextHandshakeMessage(
      HandshakeType.ClientKeyExchange
    );
    await this.readNextMessage(ContentTypes.ChangeCipherSpec);
    this.sessionKeys = await this.deriveSessionKeys({
      clientRandom,
      serverRandom,
      serverPrivateKey: ecdheKeyPair.privateKey,
      clientPublicKey: await crypto.subtle.importKey(
        "raw",
        clientKeyExchangeRecord.body.exchange_keys,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        []
      )
    });
    await this.readNextHandshakeMessage(HandshakeType.Finished);
    await this.writeTLSRecord(
      ContentTypes.ChangeCipherSpec,
      MessageEncoder.changeCipherSpec()
    );
    await this.writeTLSRecord(
      ContentTypes.Handshake,
      await MessageEncoder.createFinishedMessage(
        this.handshakeMessages,
        this.sessionKeys.masterSecret
      )
    );
    this.handshakeMessages = [];
    this.pollForClientMessages();
  }
  /**
   * Derives the session keys from the random values and the
   * pre-master secret – as per RFC 5246.
   */
  async deriveSessionKeys({
    clientRandom,
    serverRandom,
    serverPrivateKey,
    clientPublicKey
  }) {
    const preMasterSecret = await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: clientPublicKey
      },
      serverPrivateKey,
      256
      // Length of the derived secret (256 bits for P-256)
    );
    const masterSecret = new Uint8Array(
      await tls12Prf(
        preMasterSecret,
        new TextEncoder().encode("master secret"),
        concatUint8Arrays([clientRandom, serverRandom]),
        48
      )
    );
    const keyBlock = await tls12Prf(
      masterSecret,
      new TextEncoder().encode("key expansion"),
      concatUint8Arrays([serverRandom, clientRandom]),
      // Client key, server key, client IV, server IV
      16 + 16 + 4 + 4
    );
    const reader = new ArrayBufferReader(keyBlock);
    const clientWriteKey = reader.readUint8Array(16);
    const serverWriteKey = reader.readUint8Array(16);
    const clientIV = reader.readUint8Array(4);
    const serverIV = reader.readUint8Array(4);
    return {
      masterSecret,
      clientWriteKey: await crypto.subtle.importKey(
        "raw",
        clientWriteKey,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
      ),
      serverWriteKey: await crypto.subtle.importKey(
        "raw",
        serverWriteKey,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
      ),
      clientIV,
      serverIV
    };
  }
  async readNextHandshakeMessage(messageType) {
    const message = await this.readNextMessage(ContentTypes.Handshake);
    if (message.msg_type !== messageType) {
      throw new Error(`Expected ${messageType} message`);
    }
    return message;
  }
  async readNextMessage(requestedType) {
    let record;
    let accumulatedPayload = false;
    do {
      record = await this.readNextTLSRecord(requestedType);
      accumulatedPayload = await this.accumulateUntilMessageIsComplete(record);
    } while (accumulatedPayload === false);
    const message = TLSDecoder.TLSMessage(
      record.type,
      accumulatedPayload
    );
    if (record.type === ContentTypes.Handshake) {
      this.handshakeMessages.push(record.fragment);
    }
    return message;
  }
  async readNextTLSRecord(requestedType) {
    while (true) {
      for (let i = 0; i < this.receivedTLSRecords.length; i++) {
        const record2 = this.receivedTLSRecords[i];
        if (record2.type !== requestedType) {
          continue;
        }
        this.receivedTLSRecords.splice(i, 1);
        return record2;
      }
      const header = await this.pollBytes(5);
      const length = header[3] << 8 | header[4];
      const type = header[0];
      const fragment = await this.pollBytes(length);
      const record = {
        type,
        version: {
          major: header[1],
          minor: header[2]
        },
        length,
        fragment: this.sessionKeys && type !== ContentTypes.ChangeCipherSpec ? await this.decryptData(type, fragment) : fragment
      };
      if (record.type === ContentTypes.Alert) {
        const level = record.fragment[0];
        const descriptionCode = record.fragment[1];
        const severity = AlertLevelNames[level];
        const description = AlertDescriptionNames[descriptionCode];
        if (level === AlertLevels.Warning && descriptionCode === AlertDescriptions.CloseNotify) {
          throw new TLSConnectionClosed(
            "TLS connection closed by peer (CloseNotify)"
          );
        }
        throw new Error(
          `TLS alert received: ${severity} ${description}`
        );
      }
      this.receivedTLSRecords.push(record);
    }
  }
  /**
   * Returns the requested number of bytes from the client.
   * Waits for the bytes to arrive if necessary.
   */
  async pollBytes(length) {
    while (this.receivedBytesBuffer.length < length) {
      const { value, done } = await this.clientUpstreamReader.read();
      if (done) {
        await this.close();
        throw new TLSConnectionClosed("TLS connection closed");
      }
      this.receivedBytesBuffer = concatUint8Arrays([
        this.receivedBytesBuffer,
        value
      ]);
      if (this.receivedBytesBuffer.length >= length) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const requestedBytes = this.receivedBytesBuffer.slice(0, length);
    this.receivedBytesBuffer = this.receivedBytesBuffer.slice(length);
    return requestedBytes;
  }
  /**
   * Listens for all incoming messages and passes them to the
   * server handler.
   */
  async pollForClientMessages() {
    try {
      while (true) {
        const appData = await this.readNextMessage(
          ContentTypes.ApplicationData
        );
        this.serverUpstreamWriter.write(appData.body);
      }
    } catch (e) {
      if (e instanceof TLSConnectionClosed) {
        return;
      }
      throw e;
    }
  }
  /**
   * Decrypts data in a TLS 1.2-compliant manner using
   * the AES-GCM algorithm.
   */
  async decryptData(contentType, payload) {
    const implicitIV = this.sessionKeys.clientIV;
    const explicitIV = payload.slice(0, 8);
    const iv = new Uint8Array([...implicitIV, ...explicitIV]);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new Uint8Array([
          ...as8Bytes(this.receivedRecordSequenceNumber),
          contentType,
          ...TLS_Version_1_2,
          // Payload length without IV and tag
          ...as2Bytes(payload.length - 8 - 16)
        ]),
        tagLength: 128
      },
      this.sessionKeys.clientWriteKey,
      // Payload without the explicit IV
      payload.slice(8)
    );
    ++this.receivedRecordSequenceNumber;
    return new Uint8Array(decrypted);
  }
  async accumulateUntilMessageIsComplete(record) {
    this.partialTLSMessages[record.type] = concatUint8Arrays([
      this.partialTLSMessages[record.type] || new Uint8Array(),
      record.fragment
    ]);
    const message = this.partialTLSMessages[record.type];
    switch (record.type) {
      case ContentTypes.Handshake: {
        if (message.length < 4) {
          return false;
        }
        const length = message[1] << 8 | message[2];
        if (message.length < 3 + length) {
          return false;
        }
        break;
      }
      case ContentTypes.Alert: {
        if (message.length < 2) {
          return false;
        }
        break;
      }
      case ContentTypes.ChangeCipherSpec:
      case ContentTypes.ApplicationData:
        break;
      default:
        throw new Error(`TLS: Unsupported record type ${record.type}`);
    }
    delete this.partialTLSMessages[record.type];
    return message;
  }
  /**
   * Passes a TLS record to the client.
   *
   * Accepts unencrypted data and ensures it gets encrypted
   * if needed before sending it to the client. The encryption
   * only kicks in after the handshake is complete.
   */
  async writeTLSRecord(contentType, payload) {
    if (contentType === ContentTypes.Handshake) {
      this.handshakeMessages.push(payload);
    }
    if (this.sessionKeys && contentType !== ContentTypes.ChangeCipherSpec) {
      payload = await this.encryptData(contentType, payload);
    }
    const version = TLS_Version_1_2;
    const length = payload.length;
    const header = new Uint8Array(5);
    header[0] = contentType;
    header[1] = version[0];
    header[2] = version[1];
    header[3] = length >> 8 & 255;
    header[4] = length & 255;
    const record = concatUint8Arrays([header, payload]);
    this.clientDownstreamWriter.write(record);
  }
  /**
   * Encrypts data in a TLS 1.2-compliant manner using
   * the AES-GCM algorithm.
   */
  async encryptData(contentType, payload) {
    const implicitIV = this.sessionKeys.serverIV;
    const explicitIV = crypto.getRandomValues(new Uint8Array(8));
    const iv = new Uint8Array([...implicitIV, ...explicitIV]);
    const additionalData = new Uint8Array([
      ...as8Bytes(this.sentRecordSequenceNumber),
      contentType,
      ...TLS_Version_1_2,
      // Payload length without IV and tag
      ...as2Bytes(payload.length)
    ]);
    const ciphertextWithTag = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData,
        tagLength: 128
      },
      this.sessionKeys.serverWriteKey,
      payload
    );
    ++this.sentRecordSequenceNumber;
    const encrypted = concatUint8Arrays([
      explicitIV,
      new Uint8Array(ciphertextWithTag)
    ]);
    return encrypted;
  }
};
var TLSDecoder = class _TLSDecoder {
  static TLSMessage(type, accumulatedPayload) {
    switch (type) {
      case ContentTypes.Handshake: {
        return _TLSDecoder.clientHandshake(accumulatedPayload);
      }
      case ContentTypes.Alert: {
        return _TLSDecoder.alert(accumulatedPayload);
      }
      case ContentTypes.ChangeCipherSpec: {
        return _TLSDecoder.changeCipherSpec();
      }
      case ContentTypes.ApplicationData: {
        return _TLSDecoder.applicationData(accumulatedPayload);
      }
      default:
        throw new Error(`TLS: Unsupported TLS record type ${type}`);
    }
  }
  /**
   * Parses the cipher suites from the server hello message.
   *
   * The cipher suites are encoded as a list of 2-byte values.
   *
   * Binary layout:
   *
   * +----------------------------+
   * | Cipher Suites Length       |  2 bytes
   * +----------------------------+
   * | Cipher Suite 1             |  2 bytes
   * +----------------------------+
   * | Cipher Suite 2             |  2 bytes
   * +----------------------------+
   * | ...                        |
   * +----------------------------+
   * | Cipher Suite n             |  2 bytes
   * +----------------------------+
   *
   * The full list of supported cipher suites values is available at:
   *
   * https://www.iana.org/assignments/tls-parameters/tls-parameters.xhtml#tls-parameters-4
   */
  static parseCipherSuites(buffer) {
    const reader = new ArrayBufferReader(buffer);
    reader.readUint16();
    const cipherSuites = [];
    while (!reader.isFinished()) {
      const suite = reader.readUint16();
      if (!(suite in CipherSuitesNames)) {
        continue;
      }
      cipherSuites.push(CipherSuitesNames[suite]);
    }
    return cipherSuites;
  }
  static applicationData(message) {
    return {
      type: ContentTypes.ApplicationData,
      body: message
    };
  }
  static changeCipherSpec() {
    return {
      type: ContentTypes.ChangeCipherSpec,
      body: new Uint8Array()
    };
  }
  static alert(message) {
    return {
      type: ContentTypes.Alert,
      level: AlertLevelNames[message[0]],
      description: AlertDescriptionNames[message[1]]
    };
  }
  static clientHandshake(message) {
    const msg_type = message[0];
    const length = message[1] << 16 | message[2] << 8 | message[3];
    const bodyBytes = message.slice(4);
    let body = void 0;
    switch (msg_type) {
      case HandshakeType.HelloRequest:
        body = _TLSDecoder.clientHelloRequestPayload();
        break;
      case HandshakeType.ClientHello:
        body = _TLSDecoder.clientHelloPayload(bodyBytes);
        break;
      case HandshakeType.ClientKeyExchange:
        body = _TLSDecoder.clientKeyExchangePayload(bodyBytes);
        break;
      case HandshakeType.Finished:
        body = _TLSDecoder.clientFinishedPayload(bodyBytes);
        break;
      default:
        throw new Error(`Invalid handshake type ${msg_type}`);
    }
    return {
      type: ContentTypes.Handshake,
      msg_type,
      length,
      body
    };
  }
  static clientHelloRequestPayload() {
    return {};
  }
  /**
   *	Offset  Size    Field
   *	(bytes) (bytes)
   *	+------+------+---------------------------+
   *	| 0000 |  1   | Handshake Type (1 = ClientHello)
   *	+------+------+---------------------------+
   *	| 0001 |  3   | Length of ClientHello
   *	+------+------+---------------------------+
   *	| 0004 |  2   | Protocol Version
   *	+------+------+---------------------------+
   *	| 0006 |  32  | Client Random
   *	|      |      | (4 bytes timestamp +
   *	|      |      |  28 bytes random)
   *	+------+------+---------------------------+
   *	| 0038 |  1   | Session ID Length
   *	+------+------+---------------------------+
   *	| 0039 |  0+  | Session ID (variable)
   *	|      |      | (0-32 bytes)
   *	+------+------+---------------------------+
   *	| 003A*|  2   | Cipher Suites Length
   *	+------+------+---------------------------+
   *	| 003C*|  2+  | Cipher Suites
   *	|      |      | (2 bytes each)
   *	+------+------+---------------------------+
   *	| xxxx |  1   | Compression Methods Length
   *	+------+------+---------------------------+
   *	| xxxx |  1+  | Compression Methods
   *	|      |      | (1 byte each)
   *	+------+------+---------------------------+
   *	| xxxx |  2   | Extensions Length
   *	+------+------+---------------------------+
   *	| xxxx |  2   | Extension Type
   *	+------+------+---------------------------+
   *	| xxxx |  2   | Extension Length
   *	+------+------+---------------------------+
   *	| xxxx |  v   | Extension Data
   *	+------+------+---------------------------+
   *	|      |      | (Additional extensions...)
   *	+------+------+---------------------------+
   */
  static clientHelloPayload(data) {
    const reader = new ArrayBufferReader(data.buffer);
    const buff = {
      client_version: reader.readUint8Array(2),
      /**
       * Technically this consists of a GMT timestamp
       * and 28 random bytes, but we don't need to
       * parse this further.
       */
      random: reader.readUint8Array(32)
    };
    const sessionIdLength = reader.readUint8();
    buff.session_id = reader.readUint8Array(sessionIdLength);
    const cipherSuitesLength = reader.readUint16();
    buff.cipher_suites = _TLSDecoder.parseCipherSuites(
      reader.readUint8Array(cipherSuitesLength).buffer
    );
    const compressionMethodsLength = reader.readUint8();
    buff.compression_methods = reader.readUint8Array(
      compressionMethodsLength
    );
    const extensionsLength = reader.readUint16();
    buff.extensions = parseClientHelloExtensions(
      reader.readUint8Array(extensionsLength)
    );
    return buff;
  }
  /**
   * Binary layout:
   *
   *	+------------------------------------+
   *	| ECDH Client Public Key Length [1B] |
   *	+------------------------------------+
   *	| ECDH Client Public Key   [variable]|
   *	+------------------------------------+
   */
  static clientKeyExchangePayload(data) {
    return {
      // Skip the first byte, which is the length of the public key
      exchange_keys: data.slice(1, data.length)
    };
  }
  static clientFinishedPayload(data) {
    return {
      verify_data: data
    };
  }
};
function chunkStream(chunkSize) {
  return new TransformStream({
    transform(chunk, controller) {
      while (chunk.length > 0) {
        controller.enqueue(chunk.slice(0, chunkSize));
        chunk = chunk.slice(chunkSize);
      }
    }
  });
}
var MessageEncoder = class {
  static certificate(certificatesDER) {
    const certsBodies = [];
    for (const cert of certificatesDER) {
      certsBodies.push(as3Bytes(cert.byteLength));
      certsBodies.push(new Uint8Array(ArrayBuffer.isView(cert) ? cert.buffer : cert));
    }
    const certsBody = concatUint8Arrays(certsBodies);
    const body = new Uint8Array([
      ...as3Bytes(certsBody.byteLength),
      ...certsBody
    ]);
    return new Uint8Array([
      HandshakeType.Certificate,
      ...as3Bytes(body.length),
      ...body
    ]);
  }
  /*
   * Byte layout of the ServerKeyExchange message:
   *
   * +-----------------------------------+
   * |    ServerKeyExchange Message      |
   * +-----------------------------------+
   * | Handshake type (1 byte)           |
   * +-----------------------------------+
   * | Length (3 bytes)                  |
   * +-----------------------------------+
   * | Curve Type (1 byte)               |
   * +-----------------------------------+
   * | Named Curve (2 bytes)             |
   * +-----------------------------------+
   * | EC Point Format (1 byte)          |
   * +-----------------------------------+
   * | Public Key Length (1 byte)        |
   * +-----------------------------------+
   * | Public Key (variable)             |
   * +-----------------------------------+
   * | Signature Algorithm (2 bytes)     |
   * +-----------------------------------+
   * | Signature Length (2 bytes)        |
   * +-----------------------------------+
   * | Signature (variable)              |
   * +-----------------------------------+
   *
   * @param clientRandom - 32 bytes from ClientHello
   * @param serverRandom - 32 bytes from ServerHello
   * @param ecdheKeyPair - ECDHE key pair
   * @param rsaPrivateKey - RSA private key for signing
   * @returns
   */
  static async ECDHEServerKeyExchange(clientRandom, serverRandom, ecdheKeyPair, rsaPrivateKey) {
    const publicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", ecdheKeyPair.publicKey)
    );
    const params = new Uint8Array([
      // Curve type (1 byte)
      ECCurveTypes.NamedCurve,
      // Curve name (2 bytes)
      ...as2Bytes(ECNamedCurves.secp256r1),
      // Public key length (1 byte)
      publicKey.byteLength,
      // Public key (65 bytes, uncompressed format)
      ...publicKey
    ]);
    const signedParams = await crypto.subtle.sign(
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256"
      },
      rsaPrivateKey,
      new Uint8Array([...clientRandom, ...serverRandom, ...params])
    );
    const signatureBytes = new Uint8Array(signedParams);
    const signatureAlgorithm = new Uint8Array([
      HashAlgorithms.sha256,
      SignatureAlgorithms.rsa
    ]);
    const body = new Uint8Array([
      ...params,
      ...signatureAlgorithm,
      ...as2Bytes(signatureBytes.length),
      ...signatureBytes
    ]);
    return new Uint8Array([
      HandshakeType.ServerKeyExchange,
      ...as3Bytes(body.length),
      ...body
    ]);
  }
  /**
   * +------------------------------------+
   * | Content Type (Handshake)     [1B]  |
   * | 0x16                               |
   * +------------------------------------+
   * | Version (TLS 1.2)            [2B]  |
   * | 0x03 0x03                          |
   * +------------------------------------+
   * | Length                       [2B]  |
   * +------------------------------------+
   * | Handshake Type (ServerHello) [1B]  |
   * | 0x02                               |
   * +------------------------------------+
   * | Handshake Length             [3B]  |
   * +------------------------------------+
   * | Server Version               [2B]  |
   * +------------------------------------+
   * | Server Random               [32B]  |
   * +------------------------------------+
   * | Session ID Length            [1B]  |
   * +------------------------------------+
   * | Session ID             [0-32B]     |
   * +------------------------------------+
   * | Cipher Suite                 [2B]  |
   * +------------------------------------+
   * | Compression Method           [1B]  |
   * +------------------------------------+
   * | Extensions Length            [2B]  |
   * +------------------------------------+
   * | Extension: ec_point_formats        |
   * |   Type (0x00 0x0B)           [2B]  |
   * |   Length                     [2B]  |
   * |   EC Point Formats Length    [1B]  |
   * |   EC Point Format            [1B]  |
   * +------------------------------------+
   * | Other Extensions...                |
   * +------------------------------------+
   */
  static serverHello(clientHello, serverRandom, compressionAlgorithm) {
    const extensionsParts = clientHello.extensions.map((extension) => {
      switch (extension["type"]) {
        case "server_name":
          return ServerNameExtension.encodeForClient();
        case "ec_point_formats":
          return ECPointFormatsExtension.encodeForClient(
            "uncompressed"
          );
        case "renegotiation_info":
          return RenegotiationInfoExtension.encodeForClient();
      }
      return void 0;
    }).filter((x) => x !== void 0);
    const extensions = concatUint8Arrays(extensionsParts);
    const body = new Uint8Array([
      // Version field – 0x03, 0x03 means TLS 1.2
      ...TLS_Version_1_2,
      ...serverRandom,
      clientHello.session_id.length,
      ...clientHello.session_id,
      ...as2Bytes(CipherSuites.TLS1_CK_ECDHE_RSA_WITH_AES_128_GCM_SHA256),
      compressionAlgorithm,
      // Extensions length (2 bytes)
      ...as2Bytes(extensions.length),
      ...extensions
    ]);
    return new Uint8Array([
      HandshakeType.ServerHello,
      ...as3Bytes(body.length),
      ...body
    ]);
  }
  static serverHelloDone() {
    return new Uint8Array([HandshakeType.ServerHelloDone, ...as3Bytes(0)]);
  }
  /**
   * Server finished message.
   * The structure is defined in:
   * https://datatracker.ietf.org/doc/html/rfc5246#section-7.4.9
   *
   * struct {
   *     opaque verify_data[verify_data_length];
   * } Finished;
   *
   * verify_data
   *    PRF(master_secret, finished_label, Hash(handshake_messages))
   *       [0..verify_data_length-1];
   *
   * finished_label
   *    For Finished messages sent by the client, the string
   *    "client finished".  For Finished messages sent by the server,
   *    the string "server finished".
   */
  static async createFinishedMessage(handshakeMessages, masterSecret) {
    const handshakeHash = await crypto.subtle.digest(
      "SHA-256",
      concatUint8Arrays(handshakeMessages)
    );
    const verifyData = new Uint8Array(
      await tls12Prf(
        masterSecret,
        new TextEncoder().encode("server finished"),
        handshakeHash,
        // verify_data length. TLS 1.2 specifies 12 bytes for verify_data
        12
      )
    );
    return new Uint8Array([
      HandshakeType.Finished,
      ...as3Bytes(verifyData.length),
      ...verifyData
    ]);
  }
  static changeCipherSpec() {
    return new Uint8Array([1]);
  }
};

// src/tls/certificates.ts
function generateCertificate(description, issuerKeyPair) {
  return CertificateGenerator.generateCertificate(description, issuerKeyPair);
}
function certificateToPEM(certificate) {
  return `-----BEGIN CERTIFICATE-----
${formatPEM(
    encodeUint8ArrayAsBase64(certificate.buffer)
  )}
-----END CERTIFICATE-----`;
}
var CertificateGenerator = class {
  static async generateCertificate(tbsDescription, issuerKeyPair) {
    const subjectKeyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1])
      },
      true,
      // extractable
      ["sign", "verify"]
    );
    const tbsCertificate = await this.signingRequest(
      tbsDescription,
      subjectKeyPair.publicKey
    );
    const certificate = await this.sign(
      tbsCertificate,
      issuerKeyPair?.privateKey ?? subjectKeyPair.privateKey
    );
    return {
      keyPair: subjectKeyPair,
      certificate,
      tbsCertificate,
      tbsDescription
    };
  }
  static async sign(tbsCertificate, privateKey) {
    const signature = await crypto.subtle.sign(
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256"
      },
      privateKey,
      tbsCertificate.buffer
    );
    const certificate = ASN1Encoder.sequence([
      new Uint8Array(tbsCertificate.buffer),
      this.signatureAlgorithm("sha256WithRSAEncryption"),
      ASN1Encoder.bitString(new Uint8Array(signature))
    ]);
    return certificate;
  }
  static async signingRequest(description, subjectPublicKey) {
    const extensions = [];
    if (description.keyUsage) {
      extensions.push(this.keyUsage(description.keyUsage));
    }
    if (description.extKeyUsage) {
      extensions.push(this.extKeyUsage(description.extKeyUsage));
    }
    if (description.subjectAltNames) {
      extensions.push(this.subjectAltName(description.subjectAltNames));
    }
    if (description.nsCertType) {
      extensions.push(this.nsCertType(description.nsCertType));
    }
    if (description.basicConstraints) {
      extensions.push(
        this.basicConstraints(description.basicConstraints)
      );
    }
    return ASN1Encoder.sequence([
      this.version(description.version),
      this.serialNumber(description.serialNumber),
      this.signatureAlgorithm(description.signatureAlgorithm),
      this.distinguishedName(description.issuer ?? description.subject),
      this.validity(description.validity),
      this.distinguishedName(description.subject),
      await this.subjectPublicKeyInfo(subjectPublicKey),
      this.extensions(extensions)
    ]);
  }
  static version(version = 2) {
    return ASN1Encoder.ASN1(
      160,
      ASN1Encoder.integer(new Uint8Array([version]))
    );
  }
  static serialNumber(serialNumber = crypto.getRandomValues(new Uint8Array(4))) {
    return ASN1Encoder.integer(serialNumber);
  }
  static signatureAlgorithm(algorithm = "sha256WithRSAEncryption") {
    return ASN1Encoder.sequence([
      ASN1Encoder.objectIdentifier(oidByName(algorithm)),
      ASN1Encoder.null()
    ]);
  }
  static async subjectPublicKeyInfo(publicKey) {
    return new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  }
  static extensions(extensions) {
    return ASN1Encoder.ASN1(163, ASN1Encoder.sequence(extensions));
  }
  static distinguishedName(nameInfo) {
    const values = [];
    for (const [oidName, value] of Object.entries(nameInfo)) {
      const entry = [
        ASN1Encoder.objectIdentifier(oidByName(oidName))
      ];
      switch (oidName) {
        case "countryName":
          entry.push(ASN1Encoder.printableString(value));
          break;
        default:
          entry.push(ASN1Encoder.utf8String(value));
      }
      values.push(ASN1Encoder.set([ASN1Encoder.sequence(entry)]));
    }
    return ASN1Encoder.sequence(values);
  }
  static validity(validity) {
    return ASN1Encoder.sequence([
      ASN1Encoder.ASN1(
        ASN1Tags.UTCTime,
        new TextEncoder().encode(
          formatDateASN1(validity?.notBefore ?? /* @__PURE__ */ new Date())
        )
      ),
      ASN1Encoder.ASN1(
        ASN1Tags.UTCTime,
        new TextEncoder().encode(
          formatDateASN1(
            validity?.notAfter ?? addYears(/* @__PURE__ */ new Date(), 10)
          )
        )
      )
    ]);
  }
  static basicConstraints({
    ca = true,
    pathLenConstraint = void 0
  }) {
    const sequence = [ASN1Encoder.boolean(ca)];
    if (pathLenConstraint !== void 0) {
      sequence.push(
        ASN1Encoder.integer(new Uint8Array([pathLenConstraint]))
      );
    }
    return ASN1Encoder.sequence([
      ASN1Encoder.objectIdentifier(oidByName("basicConstraints")),
      ASN1Encoder.octetString(ASN1Encoder.sequence(sequence))
    ]);
  }
  static keyUsage(keyUsage) {
    const keyUsageBits = new Uint8Array([0]);
    if (keyUsage?.digitalSignature) {
      keyUsageBits[0] |= 1;
    }
    if (keyUsage?.nonRepudiation) {
      keyUsageBits[0] |= 2;
    }
    if (keyUsage?.keyEncipherment) {
      keyUsageBits[0] |= 4;
    }
    if (keyUsage?.dataEncipherment) {
      keyUsageBits[0] |= 8;
    }
    if (keyUsage?.keyAgreement) {
      keyUsageBits[0] |= 16;
    }
    if (keyUsage?.keyCertSign) {
      keyUsageBits[0] |= 32;
    }
    if (keyUsage?.cRLSign) {
      keyUsageBits[0] |= 64;
    }
    if (keyUsage?.encipherOnly) {
      keyUsageBits[0] |= 128;
    }
    if (keyUsage?.decipherOnly) {
      keyUsageBits[0] |= 64;
    }
    return ASN1Encoder.sequence([
      ASN1Encoder.objectIdentifier(oidByName("keyUsage")),
      ASN1Encoder.boolean(true),
      // Critical
      ASN1Encoder.octetString(ASN1Encoder.bitString(keyUsageBits))
    ]);
  }
  static extKeyUsage(extKeyUsage = {}) {
    return ASN1Encoder.sequence([
      ASN1Encoder.objectIdentifier(oidByName("extKeyUsage")),
      ASN1Encoder.boolean(true),
      // Critical
      ASN1Encoder.octetString(
        ASN1Encoder.sequence(
          Object.entries(extKeyUsage).map(([oidName, value]) => {
            if (value) {
              return ASN1Encoder.objectIdentifier(
                oidByName(oidName)
              );
            }
            return ASN1Encoder.null();
          })
        )
      )
    ]);
  }
  static nsCertType(nsCertType) {
    const bits = new Uint8Array([0]);
    if (nsCertType.client) {
      bits[0] |= 1;
    }
    if (nsCertType.server) {
      bits[0] |= 2;
    }
    if (nsCertType.email) {
      bits[0] |= 4;
    }
    if (nsCertType.objsign) {
      bits[0] |= 8;
    }
    if (nsCertType.sslCA) {
      bits[0] |= 16;
    }
    if (nsCertType.emailCA) {
      bits[0] |= 32;
    }
    if (nsCertType.objCA) {
      bits[0] |= 64;
    }
    return ASN1Encoder.sequence([
      ASN1Encoder.objectIdentifier(oidByName("nsCertType")),
      ASN1Encoder.octetString(bits)
    ]);
  }
  static subjectAltName(altNames) {
    const generalNames = altNames.dnsNames?.map((name) => {
      const dnsName = ASN1Encoder.ia5String(name);
      return ASN1Encoder.contextSpecific(2, dnsName);
    }) || [];
    const ipAddresses = altNames.ipAddresses?.map((ip) => {
      const ipAddress = ASN1Encoder.ia5String(ip);
      return ASN1Encoder.contextSpecific(7, ipAddress);
    }) || [];
    const sanExtensionValue = ASN1Encoder.octetString(
      ASN1Encoder.sequence([...generalNames, ...ipAddresses])
    );
    return ASN1Encoder.sequence([
      ASN1Encoder.objectIdentifier(oidByName("subjectAltName")),
      ASN1Encoder.boolean(true),
      sanExtensionValue
    ]);
  }
};
var oids = {
  // Algorithm OIDs
  "1.2.840.113549.1.1.1": "rsaEncryption",
  "1.2.840.113549.1.1.4": "md5WithRSAEncryption",
  "1.2.840.113549.1.1.5": "sha1WithRSAEncryption",
  "1.2.840.113549.1.1.7": "RSAES-OAEP",
  "1.2.840.113549.1.1.8": "mgf1",
  "1.2.840.113549.1.1.9": "pSpecified",
  "1.2.840.113549.1.1.10": "RSASSA-PSS",
  "1.2.840.113549.1.1.11": "sha256WithRSAEncryption",
  "1.2.840.113549.1.1.12": "sha384WithRSAEncryption",
  "1.2.840.113549.1.1.13": "sha512WithRSAEncryption",
  "1.3.101.112": "EdDSA25519",
  "1.2.840.10040.4.3": "dsa-with-sha1",
  "1.3.14.3.2.7": "desCBC",
  "1.3.14.3.2.26": "sha1",
  "1.3.14.3.2.29": "sha1WithRSASignature",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
  "2.16.840.1.101.3.4.2.4": "sha224",
  "2.16.840.1.101.3.4.2.5": "sha512-224",
  "2.16.840.1.101.3.4.2.6": "sha512-256",
  "1.2.840.113549.2.2": "md2",
  "1.2.840.113549.2.5": "md5",
  // pkcs#7 content types
  "1.2.840.113549.1.7.1": "data",
  "1.2.840.113549.1.7.2": "signedData",
  "1.2.840.113549.1.7.3": "envelopedData",
  "1.2.840.113549.1.7.4": "signedAndEnvelopedData",
  "1.2.840.113549.1.7.5": "digestedData",
  "1.2.840.113549.1.7.6": "encryptedData",
  // pkcs#9 oids
  "1.2.840.113549.1.9.1": "emailAddress",
  "1.2.840.113549.1.9.2": "unstructuredName",
  "1.2.840.113549.1.9.3": "contentType",
  "1.2.840.113549.1.9.4": "messageDigest",
  "1.2.840.113549.1.9.5": "signingTime",
  "1.2.840.113549.1.9.6": "counterSignature",
  "1.2.840.113549.1.9.7": "challengePassword",
  "1.2.840.113549.1.9.8": "unstructuredAddress",
  "1.2.840.113549.1.9.14": "extensionRequest",
  "1.2.840.113549.1.9.20": "friendlyName",
  "1.2.840.113549.1.9.21": "localKeyId",
  "1.2.840.113549.1.9.22.1": "x509Certificate",
  // pkcs#12 safe bags
  "1.2.840.113549.1.12.10.1.1": "keyBag",
  "1.2.840.113549.1.12.10.1.2": "pkcs8ShroudedKeyBag",
  "1.2.840.113549.1.12.10.1.3": "certBag",
  "1.2.840.113549.1.12.10.1.4": "crlBag",
  "1.2.840.113549.1.12.10.1.5": "secretBag",
  "1.2.840.113549.1.12.10.1.6": "safeContentsBag",
  // password-based-encryption for pkcs#12
  "1.2.840.113549.1.5.13": "pkcs5PBES2",
  "1.2.840.113549.1.5.12": "pkcs5PBKDF2",
  "1.2.840.113549.1.12.1.1": "pbeWithSHAAnd128BitRC4",
  "1.2.840.113549.1.12.1.2": "pbeWithSHAAnd40BitRC4",
  "1.2.840.113549.1.12.1.3": "pbeWithSHAAnd3-KeyTripleDES-CBC",
  "1.2.840.113549.1.12.1.4": "pbeWithSHAAnd2-KeyTripleDES-CBC",
  "1.2.840.113549.1.12.1.5": "pbeWithSHAAnd128BitRC2-CBC",
  "1.2.840.113549.1.12.1.6": "pbewithSHAAnd40BitRC2-CBC",
  // hmac OIDs
  "1.2.840.113549.2.7": "hmacWithSHA1",
  "1.2.840.113549.2.8": "hmacWithSHA224",
  "1.2.840.113549.2.9": "hmacWithSHA256",
  "1.2.840.113549.2.10": "hmacWithSHA384",
  "1.2.840.113549.2.11": "hmacWithSHA512",
  // symmetric key algorithm oids
  "1.2.840.113549.3.7": "des-EDE3-CBC",
  "2.16.840.1.101.3.4.1.2": "aes128-CBC",
  "2.16.840.1.101.3.4.1.22": "aes192-CBC",
  "2.16.840.1.101.3.4.1.42": "aes256-CBC",
  // certificate issuer/subject OIDs
  "2.5.4.3": "commonName",
  "2.5.4.4": "surname",
  "2.5.4.5": "serialNumber",
  "2.5.4.6": "countryName",
  "2.5.4.7": "localityName",
  "2.5.4.8": "stateOrProvinceName",
  "2.5.4.9": "streetAddress",
  "2.5.4.10": "organizationName",
  "2.5.4.11": "organizationalUnitName",
  "2.5.4.12": "title",
  "2.5.4.13": "description",
  "2.5.4.15": "businessCategory",
  "2.5.4.17": "postalCode",
  "2.5.4.42": "givenName",
  "1.3.6.1.4.1.311.60.2.1.2": "jurisdictionOfIncorporationStateOrProvinceName",
  "1.3.6.1.4.1.311.60.2.1.3": "jurisdictionOfIncorporationCountryName",
  // X.509 extension OIDs
  "2.16.840.1.113730.1.1": "nsCertType",
  "2.16.840.1.113730.1.13": "nsComment",
  "2.5.29.14": "subjectKeyIdentifier",
  "2.5.29.15": "keyUsage",
  "2.5.29.17": "subjectAltName",
  "2.5.29.18": "issuerAltName",
  "2.5.29.19": "basicConstraints",
  "2.5.29.31": "cRLDistributionPoints",
  "2.5.29.32": "certificatePolicies",
  "2.5.29.35": "authorityKeyIdentifier",
  "2.5.29.37": "extKeyUsage",
  // extKeyUsage purposes
  "1.3.6.1.4.1.11129.2.4.2": "timestampList",
  "1.3.6.1.5.5.7.1.1": "authorityInfoAccess",
  "1.3.6.1.5.5.7.3.1": "serverAuth",
  "1.3.6.1.5.5.7.3.2": "clientAuth",
  "1.3.6.1.5.5.7.3.3": "codeSigning",
  "1.3.6.1.5.5.7.3.4": "emailProtection",
  "1.3.6.1.5.5.7.3.8": "timeStamping"
};
function oidByName(requestedName) {
  for (const [oid, name] of Object.entries(oids)) {
    if (name === requestedName) {
      return oid;
    }
  }
  throw new Error(`OID not found for name: ${requestedName}`);
}
var constructedBit = 32;
var ASN1Tags = {
  EOC: 0,
  Boolean: 1,
  Integer: 2,
  BitString: 3,
  OctetString: 4,
  Null: 5,
  OID: 6,
  ObjectDescriptor: 7,
  External: 8,
  Real: 9,
  // float
  Enumeration: 10,
  PDV: 11,
  Utf8String: 12,
  RelativeOID: 13,
  Sequence: 16 | constructedBit,
  Set: 17 | constructedBit,
  NumericString: 18,
  PrintableString: 19,
  T61String: 20,
  VideotexString: 21,
  IA5String: 22,
  UTCTime: 23,
  GeneralizedTime: 24,
  GraphicString: 25,
  VisibleString: 26,
  GeneralString: 28,
  UniversalString: 29,
  CharacterString: 30,
  BMPString: 31,
  Constructor: 32,
  Context: 128
};
var ASN1Encoder = class _ASN1Encoder {
  // Helper functions for ASN.1 DER encoding
  static length_(length) {
    if (length < 128) {
      return new Uint8Array([length]);
    } else {
      let tempLength = length;
      const lengthBytesArray = [];
      while (tempLength > 0) {
        lengthBytesArray.unshift(tempLength & 255);
        tempLength >>= 8;
      }
      const numLengthBytes = lengthBytesArray.length;
      const result = new Uint8Array(1 + numLengthBytes);
      result[0] = 128 | numLengthBytes;
      for (let i = 0; i < numLengthBytes; i++) {
        result[i + 1] = lengthBytesArray[i];
      }
      return result;
    }
  }
  static ASN1(tag, data) {
    const lengthBytes = _ASN1Encoder.length_(data.length);
    const result = new Uint8Array(1 + lengthBytes.length + data.length);
    result[0] = tag;
    result.set(lengthBytes, 1);
    result.set(data, 1 + lengthBytes.length);
    return result;
  }
  static integer(number) {
    if (number[0] > 127) {
      const extendedNumber = new Uint8Array(number.length + 1);
      extendedNumber[0] = 0;
      extendedNumber.set(number, 1);
      number = extendedNumber;
    }
    return _ASN1Encoder.ASN1(ASN1Tags.Integer, number);
  }
  static bitString(data) {
    const unusedBits = new Uint8Array([0]);
    const combined = new Uint8Array(unusedBits.length + data.length);
    combined.set(unusedBits);
    combined.set(data, unusedBits.length);
    return _ASN1Encoder.ASN1(ASN1Tags.BitString, combined);
  }
  static octetString(data) {
    return _ASN1Encoder.ASN1(ASN1Tags.OctetString, data);
  }
  static null() {
    return _ASN1Encoder.ASN1(ASN1Tags.Null, new Uint8Array(0));
  }
  static objectIdentifier(oid) {
    const oidParts = oid.split(".").map(Number);
    const firstByte = oidParts[0] * 40 + oidParts[1];
    const encodedParts = [firstByte];
    for (let i = 2; i < oidParts.length; i++) {
      let value = oidParts[i];
      const bytes = [];
      do {
        bytes.unshift(value & 127);
        value >>= 7;
      } while (value > 0);
      for (let j = 0; j < bytes.length - 1; j++) {
        bytes[j] |= 128;
      }
      encodedParts.push(...bytes);
    }
    return _ASN1Encoder.ASN1(ASN1Tags.OID, new Uint8Array(encodedParts));
  }
  static utf8String(str) {
    const utf8Bytes = new TextEncoder().encode(str);
    return _ASN1Encoder.ASN1(ASN1Tags.Utf8String, utf8Bytes);
  }
  static printableString(str) {
    const utf8Bytes = new TextEncoder().encode(str);
    return _ASN1Encoder.ASN1(ASN1Tags.PrintableString, utf8Bytes);
  }
  static sequence(items) {
    return _ASN1Encoder.ASN1(ASN1Tags.Sequence, concatUint8Arrays(items));
  }
  static set(items) {
    return _ASN1Encoder.ASN1(ASN1Tags.Set, concatUint8Arrays(items));
  }
  static ia5String(str) {
    const utf8Bytes = new TextEncoder().encode(str);
    return _ASN1Encoder.ASN1(ASN1Tags.IA5String, utf8Bytes);
  }
  static contextSpecific(tagNumber, data, constructed = false) {
    const tag = (constructed ? 160 : 128) | tagNumber;
    return _ASN1Encoder.ASN1(tag, data);
  }
  static boolean(value) {
    return _ASN1Encoder.ASN1(
      ASN1Tags.Boolean,
      new Uint8Array([value ? 255 : 0])
    );
  }
};
function encodeUint8ArrayAsBase64(bytes) {
  return btoa(String.fromCodePoint(...new Uint8Array(bytes)));
}
function formatPEM(pemString) {
  return pemString.match(/.{1,64}/g)?.join("\n") || pemString;
}
function formatDateASN1(date) {
  const year = date.getUTCFullYear().toString().substr(2);
  const month = padNumber(date.getUTCMonth() + 1);
  const day = padNumber(date.getUTCDate());
  const hours = padNumber(date.getUTCHours());
  const minutes = padNumber(date.getUTCMinutes());
  const seconds = padNumber(date.getUTCSeconds());
  return `${year}${month}${day}${hours}${minutes}${seconds}Z`;
}
function padNumber(num) {
  return num.toString().padStart(2, "0");
}
function addYears(date, years) {
  const newDate = new Date(date);
  newDate.setUTCFullYear(newDate.getUTCFullYear() + years);
  return newDate;
}

// src/tls-worker.ts
var connections = /* @__PURE__ */ new Map();
var caKeyPair = null;
var caCert = null;
var caCertPEM = "";
var fetchFn = globalThis.fetch;
var hostnameToIp = /* @__PURE__ */ new Map();
var ipToHostname = /* @__PURE__ */ new Map();
function concatBuffers(a, b) {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}
function ipKey(ip) {
  return `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`;
}
function syntheticIp(hostname) {
  let hash = 0;
  for (let i = 0; i < hostname.length; i++) {
    hash = (hash << 5) - hash + hostname.charCodeAt(i) | 0;
  }
  return new Uint8Array([10, hash >> 16 & 255, hash >> 8 & 255, hash & 255]);
}
function findHeaderEnd(buf) {
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}
function parseContentLength(headers) {
  const match = headers.match(/content-length:\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
}
function parseHttpRequest(buf, headerEnd) {
  const headerStr = new TextDecoder().decode(buf.subarray(0, headerEnd));
  const lines = headerStr.split("\r\n");
  const [method, path] = lines[0].split(" ");
  const headers = /* @__PURE__ */ new Map();
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(":");
    if (colon > 0) {
      headers.set(lines[i].substring(0, colon).trim(), lines[i].substring(colon + 1).trim());
    }
  }
  const bodyStart = headerEnd + 4;
  const body = bodyStart < buf.length ? buf.subarray(bodyStart) : null;
  return { method, path, headers, body };
}
function formatHttpResponse(status, statusText, headers, body) {
  const bodyBytes = new Uint8Array(body);
  let headerStr = `HTTP/1.1 ${status} ${statusText}\r
`;
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "transfer-encoding") return;
    headerStr += `${key}: ${value}\r
`;
  });
  if (!headers.has("content-length")) {
    headerStr += `Content-Length: ${bodyBytes.length}\r
`;
  }
  headerStr += "Connection: close\r\n";
  headerStr += "\r\n";
  const headerBytes = new TextEncoder().encode(headerStr);
  const result = new Uint8Array(headerBytes.length + bodyBytes.length);
  result.set(headerBytes);
  result.set(bodyBytes, headerBytes.length);
  return result;
}
function waitForCondition(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    function check() {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 1);
    }
    check();
  });
}
async function generateServerCert(hostname) {
  if (!caKeyPair || !caCert) throw new Error("CA not initialized");
  const serverCert = await generateCertificate(
    {
      subject: { commonName: hostname },
      issuer: caCert.tbsDescription.subject,
      subjectAltNames: { dnsNames: [hostname] },
      keyUsage: { digitalSignature: true, keyEncipherment: true },
      extKeyUsage: { serverAuth: true },
      basicConstraints: { ca: false }
    },
    caKeyPair
  );
  return {
    privateKey: serverCert.keyPair.privateKey,
    certDER: serverCert.certificate
  };
}
async function setupTlsConnection(handle, hostname, port) {
  const { privateKey, certDER } = await generateServerCert(hostname);
  const tls = new TLS_1_2_Connection();
  const conn = {
    tls,
    hostname,
    port,
    handshakeDone: false,
    serverCertPrivateKey: privateKey,
    serverCertDER: certDER,
    clientDownstreamBuf: new Uint8Array(0),
    plaintextBuf: new Uint8Array(0),
    closed: false,
    httpResponsePending: false
  };
  connections.set(handle, conn);
  const downstreamReader = tls.clientEnd.downstream.readable.getReader();
  (async () => {
    try {
      while (true) {
        const { value, done } = await downstreamReader.read();
        if (done) break;
        if (value && value.length > 0) {
          conn.clientDownstreamBuf = concatBuffers(conn.clientDownstreamBuf, value);
        }
      }
    } catch {
    }
  })();
  const upstreamReader = tls.serverEnd.upstream.readable.getReader();
  (async () => {
    try {
      while (true) {
        const { value, done } = await upstreamReader.read();
        if (done) break;
        if (value && value.length > 0) {
          conn.plaintextBuf = concatBuffers(conn.plaintextBuf, value);
          await tryProcessHttpRequest(handle);
        }
      }
    } catch {
    }
  })();
  const handshakePromise = tls.TLSHandshake(
    privateKey,
    [certDER, caCert.certificate]
  );
  handshakePromise.then(() => {
    conn.handshakeDone = true;
  }).catch((err) => {
    console.error(`[tls-worker] Handshake error for handle ${handle}:`, err);
    conn.closed = true;
  });
}
async function tryProcessHttpRequest(handle) {
  const conn = connections.get(handle);
  if (!conn || conn.httpResponsePending) return;
  const headerEnd = findHeaderEnd(conn.plaintextBuf);
  if (headerEnd === -1) return;
  const headerStr = new TextDecoder().decode(conn.plaintextBuf.subarray(0, headerEnd));
  const contentLength = parseContentLength(headerStr);
  const bodyStart = headerEnd + 4;
  const bodyReceived = conn.plaintextBuf.length - bodyStart;
  if (contentLength > 0 && bodyReceived < contentLength) return;
  conn.httpResponsePending = true;
  const { method, path, headers, body } = parseHttpRequest(conn.plaintextBuf, headerEnd);
  const totalRequestLen = headerEnd + 4 + Math.max(contentLength, 0);
  conn.plaintextBuf = conn.plaintextBuf.subarray(totalRequestLen);
  const host = headers.get("Host") || headers.get("host") || conn.hostname;
  const url = `https://${host}${path}`;
  const fetchHeaders = new Headers();
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (lower !== "host" && lower !== "connection") {
      fetchHeaders.set(key, value);
    }
  }
  const fetchBody = body && body.length > 0 ? new Uint8Array(body) : void 0;
  try {
    const response = await fetchFn(url, {
      method,
      headers: fetchHeaders,
      body: method !== "GET" && method !== "HEAD" ? fetchBody : void 0
    });
    const responseBytes = formatHttpResponse(
      response.status,
      response.statusText,
      response.headers,
      await response.arrayBuffer()
    );
    const writer = conn.tls.serverEnd.downstream.writable.getWriter();
    await writer.write(responseBytes);
    writer.releaseLock();
  } catch (err) {
    const errorBody = `Error fetching ${url}: ${err}`;
    const errorResponse = formatHttpResponse(
      502,
      "Bad Gateway",
      new Headers({ "Content-Type": "text/plain" }),
      new TextEncoder().encode(errorBody).buffer
    );
    try {
      const writer = conn.tls.serverEnd.downstream.writable.getWriter();
      await writer.write(errorResponse);
      writer.releaseLock();
    } catch {
    }
  }
  conn.httpResponsePending = false;
}
import_node_worker_threads.parentPort.on("message", (msg) => {
  const cmd = new Int32Array(msg.cmdBuf);
  const data = new Uint8Array(msg.dataBuf);
  function signalResult(resultLen) {
    cmd[4] = resultLen;
    Atomics.store(cmd, 0, 2);
    Atomics.notify(cmd, 0);
  }
  function signalError(code = -1) {
    cmd[4] = code;
    Atomics.store(cmd, 0, -1);
    Atomics.notify(cmd, 0);
  }
  function loop() {
    Atomics.wait(cmd, 0, 0);
    if (cmd[0] !== 1) {
      if (cmd[0] === 2) Atomics.store(cmd, 0, 0);
      setImmediate(loop);
      return;
    }
    const command = cmd[1];
    const handle = cmd[2];
    const param = cmd[3];
    switch (command) {
      case 6: {
        (async () => {
          try {
            caCert = await generateCertificate({
              subject: {
                commonName: "WASM POSIX MITM CA",
                organizationName: "WASM POSIX Kernel"
              },
              basicConstraints: { ca: true },
              keyUsage: { keyCertSign: true, cRLSign: true }
            });
            caKeyPair = caCert.keyPair;
            caCertPEM = certificateToPEM(caCert.certificate);
            const pemBytes = new TextEncoder().encode(caCertPEM);
            data.set(pemBytes, 0);
            signalResult(pemBytes.length);
          } catch (err) {
            console.error("[tls-worker] init error:", err);
            signalError();
          }
          setImmediate(loop);
        })();
        break;
      }
      case 5: {
        const nameLen = param;
        const hostname = new TextDecoder().decode(data.slice(0, nameLen));
        const ip = syntheticIp(hostname);
        hostnameToIp.set(hostname, ip);
        ipToHostname.set(ipKey(ip), hostname);
        data[0] = ip[0];
        data[1] = ip[1];
        data[2] = ip[2];
        data[3] = ip[3];
        signalResult(4);
        setImmediate(loop);
        break;
      }
      case 1: {
        const port = param;
        const ip = new Uint8Array([data[0], data[1], data[2], data[3]]);
        const nameLen = data[4] << 8 | data[5];
        const hostname = nameLen > 0 ? new TextDecoder().decode(data.slice(6, 6 + nameLen)) : ipToHostname.get(ipKey(ip)) || `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`;
        (async () => {
          try {
            await setupTlsConnection(handle, hostname, port);
            signalResult(0);
          } catch (err) {
            console.error("[tls-worker] connect error:", err);
            signalError();
          }
          setImmediate(loop);
        })();
        break;
      }
      case 2: {
        const len = param;
        const sendData = new Uint8Array(data.slice(0, len));
        const conn = connections.get(handle);
        if (!conn) {
          signalError();
          setImmediate(loop);
          break;
        }
        (async () => {
          try {
            const writer = conn.tls.clientEnd.upstream.writable.getWriter();
            await writer.write(sendData);
            writer.releaseLock();
            await new Promise((r) => setTimeout(r, 5));
            signalResult(len);
          } catch (err) {
            console.error("[tls-worker] send error:", err);
            signalError();
          }
          setImmediate(loop);
        })();
        break;
      }
      case 3: {
        const maxLen = param;
        const conn = connections.get(handle);
        if (!conn) {
          signalError();
          setImmediate(loop);
          break;
        }
        (async () => {
          try {
            if (conn.clientDownstreamBuf.length === 0 && !conn.closed) {
              await waitForCondition(
                () => conn.clientDownstreamBuf.length > 0 || conn.closed,
                1e4
              );
            }
            const available = conn.clientDownstreamBuf.length;
            const n = Math.min(maxLen, available);
            if (n > 0) {
              data.set(conn.clientDownstreamBuf.subarray(0, n), 0);
              conn.clientDownstreamBuf = conn.clientDownstreamBuf.subarray(n);
            }
            signalResult(n);
          } catch (err) {
            console.error("[tls-worker] recv error:", err);
            signalError();
          }
          setImmediate(loop);
        })();
        break;
      }
      case 4: {
        const conn = connections.get(handle);
        if (conn) {
          conn.closed = true;
          conn.tls.close().catch(() => {
          });
          connections.delete(handle);
        }
        signalResult(0);
        setImmediate(loop);
        break;
      }
      default: {
        signalError();
        setImmediate(loop);
      }
    }
  }
  loop();
});
