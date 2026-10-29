import { createWasmPosixKernelTestHarness } from "../../../../host/src/kernel";
import { createKernelScratchTestInstance } from "../../../../host/test/support/kernel-scratch-instance";
import { WPK_IMAGE_SOURCE_TARGET } from "../../../../host/src/webgl/image-storage";
import * as O from "../../../../host/src/webgl/ops";
// Real native import/query/submit paths; synthetic kernel scratch supplies
// authority/identity plumbing. Public C and Rust marshalling are separate gates.
self.onmessage = ({ data }) => {
  try {
    const canvas = data.canvas as OffscreenCanvas;
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false, depth: true, stencil: true, preserveDrawingBuffer: true });
    if (!gl)
      throw new Error("WebGL2 unavailable");
    const made: object[] = [], deleted: object[] = [], live: Array<() => boolean> = [];
    for (const [createName, deleteName, isName] of [["createTexture", "deleteTexture", "isTexture"], ["createFramebuffer", "deleteFramebuffer", "isFramebuffer"],
      ["createRenderbuffer", "deleteRenderbuffer", "isRenderbuffer"], ["createBuffer", "deleteBuffer", "isBuffer"], ["createProgram", "deleteProgram", "isProgram"], ["createShader", "deleteShader", "isShader"]]) {
      const api = gl as any, create = api[createName].bind(gl), destroy = api[deleteName].bind(gl), isLive = api[isName].bind(gl);
      api[createName] = (...args: unknown[]) => {
        const value = create(...args);
        if (value) {
          made.push(value);
          live.push(() => isLive(value));
        }
        return value;
      };
      api[deleteName] = (value: object | null) => {
        if (value)
          deleted.push(value);
        destroy(value);
      };
    }
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    const kernel = createWasmPosixKernelTestHarness({ io: {} as any, callbacks: { getProcessMemory: () => memory }, memory, pointerWidth: 4,
      instance: createKernelScratchTestInstance(4, memory, () => ({}), () => 4096) });
    const api = (kernel.testAuthority.buildImportObject(memory) as {
      env: Record<string, (...args: any[]) => number>;
    }).env;
    const require = (test: unknown, label: string) => {
      if (!test)
        throw new Error(label);
    };
    for (const session of [11, 12])
      // Distinct context sessions retain this fixture's one native file.
      api.host_gl_bind(7, 4096, 65536, session, 1n);
    kernel.gl.attachCanvas(7, canvas);
    require(api.host_gl_create_context(7, 21, 0, 0, 11) === 0, "context");
    new Uint32Array(memory.buffer, 64, 4).set([2, 21, 0, 0]);
    require(api.host_gl_create_context(7, 22, 64, 16, 12) === 0, "peer");
    const current = (session: number) => require(api.host_gl_make_current(7, session + 10, 0, 0, session) === 0, "current");
    const send = (op: number, words: number[], tail = new Uint8Array(), session = 11) => {
      const bytes = new Uint8Array(4 + 4 * words.length + tail.length), v = new DataView(bytes.buffer);
      v.setUint16(0, op, true);
      v.setUint16(2, 4 * words.length + tail.length, true);
      words.forEach((x, i) => v.setUint32(4 + 4 * i, x, true));
      bytes.set(tail, 4 + 4 * words.length);
      new Uint8Array(memory.buffer, 4096, bytes.length).set(bytes);
      require(api.host_gl_submit(7, 0, bytes.length, session) === 0, `submit ${op}`);
    };
    const query = (op: number, words: number[], length: number, session = 11) => {
      new Uint32Array(memory.buffer, 64, words.length).set(words);
      require(api.host_gl_query(7, op, 64, words.length * 4, 512, length, session) === length, `query ${op}`);
      return new Uint8Array(memory.buffer, 512, length).slice();
    };
    const checked = (op: number, words: number[], expected = 0, session = 11) => {
      const reply = new DataView(query(op, words, 12, session).buffer);
      require(reply.getUint32(0, true) === expected && reply.getUint32(8, true) === 0x47514c33, `checked ${op}`);
      return reply.getUint32(4, true);
    };
    const error = (session = 11) => new DataView(query(O.QOP_GET_ERROR, [], 4, session).buffer).getUint32(0, true);
    const bind = (name: number, session = 11) => checked(O.QOP_BIND_IMAGE_OBJECT, [1, 0x0de1, name], 0, session);
    const fbo = (id: number, name: number, session = 11) => { send(O.OP_BIND_FRAMEBUFFER, [0x8d40, id], new Uint8Array(), session); send(O.OP_FRAMEBUFFER_TEXTURE_2D, [0x8d40, 0x8ce0, 0x0de1, name, 0], new Uint8Array(), session); };
    const pixels = (id: number, session = 11) => { send(O.OP_BIND_FRAMEBUFFER, [0x8d40, id], new Uint8Array(), session); return [...query(O.QOP_READ_PIXELS, [0, 0, 1, 1, 0x1908, 0x1401], 4, session)]; };
    const image = (name: number, source: number) => checked(O.QOP_IMAGE_TARGET, [1, name, source]);
    const param = (pname: number) => checked(O.QOP_GET_TEX_PARAMETER, [0x0de1, pname]);
    const rgba = (color: number[]) => new Uint8Array(color);
    const allocate = (name: number, color: number[]) => { bind(name); send(O.OP_TEX_IMAGE_2D, [0x0de1, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 4], rgba(color)); };
    current(11);
    allocate(0x60000000, [0, 0, 255, 255]);
    fbo(70, 0x60000000);
    allocate(17, [0, 0, 0, 255]);
    send(O.OP_TEX_PARAMETERI, [0x0de1, 0x2801, 0x2600]);
    send(O.OP_TEX_PARAMETERI, [0x0de1, 0x2800, 0x2600]);
    fbo(71, 17);
    allocate(18, [0, 0, 0, 255]);
    send(O.OP_TEX_PARAMETERI, [0x0de1, 0x2801, 0x2601]);
    fbo(72, 18);
    require(kernel.gl.createGpuBo(41, gl, 2, 2) !== null, "source BO");
    // Private source creation cannot overwrite legal public GLuint 0x60000000.
    const source = api.host_gl_bind_foreign_texture(7, 21, 41, WPK_IMAGE_SOURCE_TARGET);
    require(source > 0 && source !== 0x60000000, "private source handle");
    const namespace = pixels(70);
    bind(17);
    require(image(17, source) === source, "texture import");
    const firstParam = param(0x2801);
    bind(18);
    require(image(18, source) === source, "sibling import");
    const secondParam = param(0x2801);
    send(O.OP_TEX_SUB_IMAGE_2D, [0x0de1, 0, 0, 0, 2, 2, 0x1908, 0x1401, 16], rgba([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]));
    const red = [pixels(71), pixels(72)];
    checked(O.QOP_BIND_IMAGE_OBJECT, [2, 0x8d41, 19]);
    checked(O.QOP_IMAGE_TARGET, [2, 19, source]);
    send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 73]);
    send(O.OP_FRAMEBUFFER_RENDERBUFFER, [0x8d40, 0x8ce0, 0x8d41, 19]);
    const rboName = checked(O.QOP_GET_RENDERBUFFER_PARAMETER, [0x8d41, 0x8d42]);
    send(O.OP_CLEAR_COLOR, [0, 0x3f800000, 0, 0x3f800000]);
    send(O.OP_CLEAR, [0x4000]);
    const green = [pixels(71), pixels(72)];
    // Sampling uses each object's independent native view and current pixels.
    allocate(50, [0, 0, 0, 255]);
    fbo(74, 50);
    for (const [name, type, text] of [[101, 0x8b31, "void main(){gl_Position=vec4(0.,0.,0.,1.);gl_PointSize=1.;}"],
      [102, 0x8b30, "precision mediump float;uniform sampler2D image;void main(){gl_FragColor=texture2D(image,vec2(.25));}"]] as [
      number,
      number,
      string
    ][]) {
      const bytes = new TextEncoder().encode(text);
      send(O.OP_CREATE_SHADER, [type, name]);
      send(O.OP_SHADER_SOURCE, [name, bytes.length], bytes);
      send(O.OP_COMPILE_SHADER, [name]);
    }
    send(O.OP_CREATE_PROGRAM, [103]);
    send(O.OP_ATTACH_SHADER, [103, 101]);
    send(O.OP_ATTACH_SHADER, [103, 102]);
    send(O.OP_LINK_PROGRAM, [103]);
    send(O.OP_USE_PROGRAM, [103]);
    const name = new TextEncoder().encode("image"), input = new Uint8Array(8 + name.length);
    new DataView(input.buffer).setUint32(0, 103, true);
    new DataView(input.buffer).setUint32(4, name.length, true);
    input.set(name, 8);
    new Uint8Array(memory.buffer, 64, input.length).set(input);
    require(api.host_gl_query(7, O.QOP_GET_UNIFORM_LOC, 64, input.length, 512, 4, 11) === 4, "sampler lookup");
    const location = new DataView(memory.buffer).getInt32(512, true);
    require(location > 0, "sampler location");
    send(O.OP_UNIFORM1I, [location, 0]);
    send(O.OP_VIEWPORT, [0, 0, 1, 1]);
    bind(17);
    send(O.OP_DRAW_ARRAYS, [0, 0, 1]);
    const sampledGreen = pixels(74);
    send(O.OP_TEX_IMAGE_2D, [0x0de1, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 4], rgba([0, 0, 255, 255]));
    const orphan = [pixels(71), pixels(72)], aSource = checked(O.QOP_IMAGE_SOURCE_STATE, [1, 17]);
    bind(18);
    send(O.OP_GENERATE_MIPMAP, [0x0de1]);
    const bSource = checked(O.QOP_IMAGE_SOURCE_STATE, [1, 18]);
    send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 73]);
    send(O.OP_CLEAR_COLOR, [0x3f800000, 0, 0, 0x3f800000]);
    send(O.OP_CLEAR, [0x4000]);
    const mipOrphan = pixels(72);
    image(18, source);
    const reimport = pixels(72);
    checked(O.QOP_BIND_IMAGE_OBJECT, [2, 0x8d41, 19]);
    send(O.OP_RENDERBUFFER_STORAGE, [0x8d41, 0x8056, 1, 1]);
    const rboSource = checked(O.QOP_IMAGE_SOURCE_STATE, [2, 19]);
    send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 73]);
    send(O.OP_CLEAR_COLOR, [0, 0, 0x3f800000, 0x3f800000]);
    send(O.OP_CLEAR, [0x4000]);
    const rboOrphan = [pixels(73), pixels(72)];
    // A failed candidate allocation preserves the old native view and FBO.
    bind(17);
    const create = gl.createTexture;
    gl.createTexture = () => null;
    try {
      checked(O.QOP_IMAGE_TARGET, [1, 17, source], 1);
    }
    finally {
      gl.createTexture = create;
    }
    require(error() === 0x505, "candidate allocation error");
    const rejected = pixels(71);
    const attach = gl.framebufferTexture2D.bind(gl), ownedFbo = kernel.gl.get(7, 11)!.fbos.get(71)!;
    let injected = false;
    gl.framebufferTexture2D = (target, point, textarget, texture, level) => {
      if (!injected && target === 0x8ca9 && gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === ownedFbo) {
        injected = true;
        attach(target, point, 0xdead, texture, level);
      }
      else
        attach(target, point, textarget, texture, level);
    };
    try {
      checked(O.QOP_IMAGE_TARGET, [1, 17, source], 1);
    }
    finally {
      gl.framebufferTexture2D = attach;
    }
    require(injected && error() === 0x500, "retarget rejection");
    const retargetRejected = pixels(71);
    require(checked(O.QOP_IMAGE_SOURCE_STATE, [1, 17]) === 0, "retarget source rollback");
    // A bound peer and an inactive container retain the old identity at reuse.
    current(12);
    bind(17, 12);
    fbo(81, 17, 12);
    current(11);
    send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 0]);
    send(O.OP_DELETE_TEXTURES, [1, 17]);
    allocate(17, [255, 255, 0, 255]);
    fbo(75, 17);
    const reused = pixels(75);
    current(12);
    const retained = pixels(81, 12);
    const revisionQuery = (op: number, words: number[]) => {
      const reply = new DataView(query(op, words, 16, 12).buffer);
      require(reply.getUint32(0, true) === 0 && reply.getUint32(12, true) === 0x47514c33, "bound image revision query");
      return [reply.getUint32(4, true), reply.getUint32(8, true)];
    };
    const retainedState = revisionQuery(O.QOP_BOUND_IMAGE_STATE, [1, 0x0de1]);
    const retainedImport = revisionQuery(O.QOP_BOUND_IMAGE_TARGET, [1, 0x0de1, source]);
    const retainedImported = pixels(81, 12);
    current(11);
    const reusedAfterPeerImport = pixels(75);
    current(12);
    // Checked mutations preserve native pixels and bindings on definite
    // driver rejection. The fault calls a real invalid native enum once.
    const mutationRollback: number[][] = [];
    const mutate = (op: number, words: number[], expected = 0) => checked(op, words, expected, 12);
    const inject = (method: string, fault: (original: (...args: any[]) => any, args: any[]) => void, run: () => void) => {
      const renderer = gl as any, original = renderer[method].bind(gl);
      let fired = false;
      renderer[method] = (...args: any[]) => {
        if (!fired) {
          fired = true;
          fault(original, args);
        }
        else
          original(...args);
      };
      try {
        run();
      }
      finally {
        renderer[method] = original;
      }
      require(fired && error(12) === 0x500, `mutation fault ${method}`);
    };
    send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 83], new Uint8Array(), 12);
    mutate(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, 17, 0]);
    inject("framebufferTexture2D", (original, args) => original(0xdead, ...args.slice(1)), () => mutate(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, 18, 0], 1));
    mutationRollback.push(pixels(83, 12));
    mutate(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, 18, 0]);
    send(O.OP_ACTIVE_TEXTURE, [0x84c1], new Uint8Array(), 12);
    checked(O.QOP_BIND_IMAGE_OBJECT, [1, 0x0de1, 18], 0, 12);
    send(O.OP_ACTIVE_TEXTURE, [0x84c0], new Uint8Array(), 12);
    inject("bindTexture", (original, args) => original(0xdead, args[1]), () => mutate(O.QOP_IMAGE_OBJECT_DELETE, [1, 18], 1));
    mutationRollback.push(pixels(83, 12));
    mutate(O.QOP_IMAGE_OBJECT_DELETE, [1, 18]);
    checked(O.QOP_BIND_IMAGE_OBJECT, [2, 0x8d41, 19], 0, 12);
    send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 84], new Uint8Array(), 12);
    mutate(O.QOP_IMAGE_ATTACHMENT, [2, 0x8d40, 0x8ce0, 0x8d41, 19, 0]);
    inject("framebufferRenderbuffer", (original, args) => original(0xdead, ...args.slice(1)), () => mutate(O.QOP_IMAGE_ATTACHMENT, [2, 0x8d40, 0x8ce0, 0x8d41, 0, 0], 1));
    mutationRollback.push(pixels(84, 12));
    inject("bindRenderbuffer", (original, args) => original(0xdead, args[1]), () => mutate(O.QOP_IMAGE_OBJECT_DELETE, [2, 19], 1));
    mutationRollback.push(pixels(84, 12));
    mutate(O.QOP_IMAGE_OBJECT_DELETE, [2, 19]);
    send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 83], new Uint8Array(), 12);
    mutate(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, 17, 0]);
    inject("deleteFramebuffer", () => gl.bindFramebuffer(0xdead, null), () => mutate(O.QOP_IMAGE_OBJECT_DELETE, [3, 83], 1));
    mutationRollback.push(pixels(83, 12));
    mutate(O.QOP_IMAGE_OBJECT_DELETE, [3, 83]);
    mutationRollback.push(pixels(81, 12));
    // Failed owned allocation must leave old pixels; accepted allocation
    // permits the later upload. C row suppression is checked separately.
    send(O.OP_ACTIVE_TEXTURE, [0x84c1], new Uint8Array(), 12);
    checked(O.QOP_BIND_IMAGE_OBJECT, [1, 0x0de1, 17], 0, 12);
    send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 85], new Uint8Array(), 12);
    mutate(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, 17, 0]);
    mutate(O.QOP_IMAGE_STORAGE, [O.OP_TEX_IMAGE_2D, 0x0de1, 0, 0x1908, -1, 1, 0, 0x1908, 0x1401, 0], 1);
    require(error(12) === 0x501, "owned allocation rejection");
    const storageReject = [pixels(85, 12)];
    mutate(O.QOP_IMAGE_STORAGE, [O.OP_TEX_IMAGE_2D, 0x0de1, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 0]);
    send(O.OP_TEX_SUB_IMAGE_2D, [0x0de1, 0, 0, 0, 1, 1, 0x1908, 0x1401, 4], rgba([0, 0, 255, 255]), 12);
    const ownedStorageRetry = pixels(85, 12);
    checked(O.QOP_BIND_IMAGE_OBJECT, [2, 0x8d41, 20], 0, 12);
    mutate(O.QOP_IMAGE_STORAGE, [O.OP_RENDERBUFFER_STORAGE, 0x8d41, 0x8056, 1, 1]);
    send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 86], new Uint8Array(), 12);
    mutate(O.QOP_IMAGE_ATTACHMENT, [2, 0x8d40, 0x8ce0, 0x8d41, 20, 0]);
    send(O.OP_CLEAR_COLOR, [0, 0, 0x3f800000, 0x3f800000], new Uint8Array(), 12);
    send(O.OP_CLEAR, [0x4000], new Uint8Array(), 12);
    mutate(O.QOP_IMAGE_STORAGE, [O.OP_RENDERBUFFER_STORAGE, 0x8d41, 0x8056, -1, 1], 1);
    require(error(12) === 0x501, "owned RBO allocation rejection");
    storageReject.push(pixels(86, 12));
    send(O.OP_ACTIVE_TEXTURE, [0x84c0], new Uint8Array(), 12);
    const framebufferBindReject: number[][] = [];
    const createFramebuffer = gl.createFramebuffer;
    gl.createFramebuffer = () => null;
    try {
      mutate(O.QOP_BIND_FRAMEBUFFER, [0x8d40, 87], 1);
    }
    finally {
      gl.createFramebuffer = createFramebuffer;
    }
    require(error(12) === 0x505, "framebuffer allocation rejection");
    framebufferBindReject.push(pixels(86, 12));
    inject("bindFramebuffer", (original, args) => original(0xdead, args[1]), () => mutate(O.QOP_BIND_FRAMEBUFFER, [0x8d40, 87], 1));
    framebufferBindReject.push(pixels(86, 12));
    mutate(O.QOP_BIND_FRAMEBUFFER, [0x8d40, 87]);
    mutate(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, 17, 0]);
    const framebufferBindRetry = pixels(87, 12);
    const bufferBindReject: number[][] = [], bufferBindRetry: number[] = [];
    for (const [target, pname, name] of [[0x8892, 0x8894, 100], [0x8893, 0x8895, 102]]) {
      mutate(O.QOP_BIND_BUFFER, [target, name]);
      send(O.OP_BUFFER_DATA, [target, 4, 0x88e4], new Uint8Array(), 12);
      send(O.OP_BUFFER_SUB_DATA, [target, 0, 4], new Uint8Array([11, 22, 33, 44]), 12);
      const inspect = () => {
        const binding = new DataView(query(O.QOP_GET_INTEGERV, [pname], 4, 12).buffer).getUint32(0, true);
        const bytes = new Uint8Array(4); gl.getBufferSubData(target, 0, bytes);
        return [binding, ...bytes];
      };
      const createBuffer = gl.createBuffer;
      gl.createBuffer = () => null;
      try { mutate(O.QOP_BIND_BUFFER, [target, name + 1], 1); }
      finally { gl.createBuffer = createBuffer; }
      require(error(12) === 0x505, "buffer allocation rejection");
      bufferBindReject.push(inspect());
      inject("bindBuffer", (original, args) => original(0xdead, args[1]), () => mutate(O.QOP_BIND_BUFFER, [target, name + 1], 1));
      bufferBindReject.push(inspect());
      mutate(O.QOP_BIND_BUFFER, [target, name + 1]);
      bufferBindRetry.push(new DataView(query(O.QOP_GET_INTEGERV, [pname], 4, 12).buffer).getUint32(0, true));
    }
    // One object supplies two vertex attributes and a separately classified
    // native index view. A later selector failure must restore all of them.
    checked(O.QOP_BIND_IMAGE_OBJECT, [1, 0x0de1, 30], 0, 12);
    mutate(O.QOP_IMAGE_STORAGE, [O.OP_TEX_IMAGE_2D, 0x0de1, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 0]);
    mutate(O.QOP_BIND_FRAMEBUFFER, [0x8d40, 88]);
    mutate(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, 30, 0]);
    for (const [name, type, text] of [
      [201, 0x8b31, "attribute vec2 position;attribute vec4 color;varying vec4 c;void main(){c=color;gl_Position=vec4(position,0.,1.);gl_PointSize=1.;}"],
      [202, 0x8b30, "precision mediump float;varying vec4 c;void main(){gl_FragColor=c;}"]
    ] as [number, number, string][]) {
      const bytes = new TextEncoder().encode(text);
      send(O.OP_CREATE_SHADER, [type, name], new Uint8Array(), 12);
      send(O.OP_SHADER_SOURCE, [name, bytes.length], bytes, 12);
      send(O.OP_COMPILE_SHADER, [name], new Uint8Array(), 12);
    }
    send(O.OP_CREATE_PROGRAM, [203], new Uint8Array(), 12);
    send(O.OP_ATTACH_SHADER, [203, 201], new Uint8Array(), 12); send(O.OP_ATTACH_SHADER, [203, 202], new Uint8Array(), 12);
    send(O.OP_BIND_ATTRIB_LOCATION, [203, 0, 8], new TextEncoder().encode("position"), 12);
    send(O.OP_BIND_ATTRIB_LOCATION, [203, 1, 5], new TextEncoder().encode("color"), 12);
    send(O.OP_LINK_PROGRAM, [203], new Uint8Array(), 12); send(O.OP_USE_PROGRAM, [203], new Uint8Array(), 12);
    send(O.OP_VIEWPORT, [0, 0, 1, 1], new Uint8Array(), 12);
    const geometry = (color: number[]) => {
      mutate(O.QOP_BIND_BUFFER, [0x8892, 200]);
      send(O.OP_BUFFER_DATA, [0x8892, 26, 0x88e4], new Uint8Array(), 12);
      const bytes = new Uint8Array(26); bytes.set(new Uint8Array(new Float32Array([0, 0, ...color]).buffer));
      send(O.OP_BUFFER_SUB_DATA, [0x8892, 0, 26], bytes, 12);
      for (const [index, size, offset] of [[0, 2, 0], [1, 4, 8]]) {
        send(O.OP_VERTEX_ATTRIB_POINTER, [index, size, 0x1406, 0, 24, offset], new Uint8Array(), 12);
        send(O.OP_ENABLE_VERTEX_ATTRIB_ARRAY, [index], new Uint8Array(), 12);
      }
      mutate(O.QOP_BIND_BUFFER, [0x8893, 200]);
    };
    const renderBuffer = () => {
      send(O.OP_DRAW_ELEMENTS, [0, 1, 0x1403, 24], new Uint8Array(), 12);
      return pixels(88, 12);
    };
    geometry([0, 1, 0, 1]); require(error(12) === 0, "buffer deletion render setup");
    const bufferDeleteRollback: number[][] = [];
    const createForDelete = gl.createBuffer; gl.createBuffer = () => null;
    try { mutate(O.QOP_DELETE_BUFFER, [200], 1); } finally { gl.createBuffer = createForDelete; }
    require(error(12) === 0x505, "buffer delete allocation rejection"); bufferDeleteRollback.push(renderBuffer());
    inject("vertexAttribPointer", (original, args) => original(args[0], args[1], 0xdead, ...args.slice(3)), () => mutate(O.QOP_DELETE_BUFFER, [200], 1));
    bufferDeleteRollback.push(renderBuffer());
    const bindForDelete = gl.bindBuffer.bind(gl); let rejectedElement = false;
    gl.bindBuffer = (target, buffer) => {
      if (target === 0x8893 && buffer === null && !rejectedElement) { rejectedElement = true; bindForDelete(0xdead, null); }
      else bindForDelete(target, buffer);
    };
    try { mutate(O.QOP_DELETE_BUFFER, [200], 1); } finally { gl.bindBuffer = bindForDelete; }
    require(rejectedElement && error(12) === 0x500, "buffer delete late selector rejection"); bufferDeleteRollback.push(renderBuffer());
    inject("deleteBuffer", () => gl.bindBuffer(0xdead, null), () => mutate(O.QOP_DELETE_BUFFER, [200], 1));
    bufferDeleteRollback.push(renderBuffer());
    mutate(O.QOP_DELETE_BUFFER, [200]);
    const bufferDeleteCleared = [gl.getParameter(gl.ARRAY_BUFFER_BINDING), gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING),
      gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING), gl.getVertexAttrib(1, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING)].map(value => value === null ? 0 : 1);
    geometry([0, 0, 1, 1]); const bufferDeleteRetry = renderBuffer();
    // A rejected private END completes on query admission, without a new
    // END or a muxer replay of the staging ARRAY binding.
    const submitWords = (op: number, words: number[]) => {
      const v = new DataView(memory.buffer,4096,4+words.length*4);
      v.setUint16(0,op,true); v.setUint16(2,words.length*4,true);
      words.forEach((word,i)=>v.setUint32(4+i*4,word,true));
      return api.host_gl_submit(7,0,4+words.length*4,12);
    };
    const captureArray = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    send(O.OP_BEGIN_CLIENT_ARRAY,[],new Uint8Array(),12);
    mutate(O.QOP_BIND_BUFFER,[0x8892,210]);
    const captureBind = gl.bindBuffer.bind(gl);
    gl.bindBuffer = (target,buffer) => { if(target===0x8892 && buffer===captureArray) captureBind(0xdead,buffer); else captureBind(target,buffer); };
    let captureEnd: number, captureBlocked: number, captureOutput: number[];
    try {
      captureEnd = submitWords(O.OP_END_CLIENT_ARRAY,[]);
      new Uint32Array(memory.buffer,64,1).set([0x8894]); new Uint8Array(memory.buffer,512,4).fill(0xa5);
      captureBlocked = api.host_gl_query(7,O.QOP_GET_INTEGERV,64,4,512,4,12);
      captureOutput = [...new Uint8Array(memory.buffer,512,4)];
      require(captureEnd===-5 && captureBlocked===-5,"client capture restore fence");
    } finally { gl.bindBuffer = captureBind; }
    require(error(12)===0x500,"client restore error ownership");
    const captureState = [new DataView(query(O.QOP_GET_INTEGERV,[0x8894],4,12).buffer).getUint32(0,true),kernel.gl.get(7,12)!.savedClientArrayBuffer===undefined?0:1];
    const capturePixels = renderBuffer(); mutate(O.QOP_DELETE_BUFFER,[210]);
    // Index promotion must never repeat an already accepted draw merely
    // because restoring ELEMENT or deleting its private buffer failed.
    const promotionElement = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING);
    const promotionBind = gl.bindBuffer.bind(gl), promotionDraw = gl.drawElements.bind(gl);
    let promotionDraws = 0;
    gl.drawElements = (...args) => { promotionDraws++; promotionDraw(...args); };
    gl.bindBuffer = (target,buffer) => { if(promotionDraws && target===0x8893 && buffer===promotionElement) promotionBind(0xdead,buffer); else promotionBind(target,buffer); };
    let promotionSubmit: number, promotionBlocked: number, promotionPixels: number[];
    try {
      promotionSubmit = submitWords(O.OP_DRAW_ELEMENTS,[0,1,0x1403,24]);
      new Uint8Array(memory.buffer,512,4).fill(0xa5);
      promotionBlocked = api.host_gl_query(7,O.QOP_GET_ERROR,64,0,512,4,12);
      require(promotionSubmit===-5 && promotionBlocked===-5 && promotionDraws===1,"promoted draw recovery fence");
      gl.bindBuffer = promotionBind;
      require(error(12)===0x500 && gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING)===promotionElement,"promotion selector restored");
      promotionPixels = pixels(88,12);
      require(promotionDraws===1,"draw was not replayed");
    } finally { gl.bindBuffer = promotionBind; gl.drawElements = promotionDraw; }
    // A valid converted pointer can be partially installed before a native
    // rejection. Keep the accepted normal pointer until inverse repair.
    const nativePointer = () => [gl.getVertexAttrib(1,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING),
      gl.getVertexAttrib(1,gl.VERTEX_ATTRIB_ARRAY_SIZE),gl.getVertexAttrib(1,gl.VERTEX_ATTRIB_ARRAY_TYPE),
      gl.getVertexAttrib(1,gl.VERTEX_ATTRIB_ARRAY_NORMALIZED),gl.getVertexAttrib(1,gl.VERTEX_ATTRIB_ARRAY_STRIDE),
      gl.getVertexAttribOffset(1,gl.VERTEX_ATTRIB_ARRAY_POINTER)];
    const originalPointer = nativePointer(), pointerBuffer = originalPointer[0];
    const pointerCall = gl.vertexAttribPointer.bind(gl); let pointerRejected = false;
    const pointerPrecondition = {error:-1,selected:false,installed:false};
    gl.vertexAttribPointer = (...args) => {
      if(!pointerRejected && args[0]===1 && args[4]===0 && args[5]===0) {
        pointerCall(...args);
        pointerPrecondition.error = gl.getError();
        pointerPrecondition.selected = gl.getParameter(gl.ARRAY_BUFFER_BINDING)!==pointerBuffer;
        pointerPrecondition.installed = gl.getVertexAttrib(1,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING)!==pointerBuffer;
        pointerRejected = true; gl.bindBuffer(0xdead,null);
      } else if(pointerRejected && args[0]===1 && args[4]===24 && args[5]===8) gl.bindBuffer(0xdead,null);
      else pointerCall(...args);
    };
    let pointerSubmit: number, pointerBlocked: number, pointerOutput: number[];
    try {
      pointerSubmit = submitWords(O.OP_VERTEX_ATTRIB_POINTER,[1,4,0x140c,0,0,0]);
      require(pointerPrecondition.error===0 && pointerPrecondition.selected && pointerPrecondition.installed,"valid converted pointer before injected fault");
      require(pointerRejected && nativePointer().some((value,i)=>value!==originalPointer[i]),"native pointer remains dirty");
      new Uint8Array(memory.buffer,512,4).fill(0xa5);
      pointerBlocked = api.host_gl_query(7,O.QOP_GET_ERROR,64,0,512,4,12); pointerOutput = [...new Uint8Array(memory.buffer,512,4)];
      require(pointerSubmit===-5 && pointerBlocked===-5,"pointer inverse fence");
    } finally { gl.vertexAttribPointer = pointerCall; }
    require(error(12)===0x500 && nativePointer().every((value,i)=>value===originalPointer[i]),"old pointer restored");
    const pointerPixels = renderBuffer();
    mutate(O.QOP_BIND_BUFFER,[0x8892,211]);
    send(O.OP_BUFFER_DATA,[0x8892,16,0x88e4],new Uint8Array(),12);
    send(O.OP_BUFFER_SUB_DATA,[0x8892,0,16],new Uint8Array(new Int32Array([0,65536,0,65536]).buffer),12);
    send(O.OP_VERTEX_ATTRIB_POINTER,[1,4,0x140c,0,0,0],new Uint8Array(),12);
    const convertedRetryPixels = renderBuffer();
    // A second native failure during rollback must fence even another
    // context until the old container and selection can be restored.
    send(O.OP_ACTIVE_TEXTURE, [0x84c0], new Uint8Array(), 12);
    checked(O.QOP_BIND_IMAGE_OBJECT, [1, 0x0de1, 33], 0, 12);
    send(O.OP_TEX_IMAGE_2D, [0x0de1, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 4], rgba([255, 0, 0, 255]), 12);
    mutate(O.QOP_BIND_FRAMEBUFFER, [0x8d40, 94]);
    mutate(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, 33, 0]);
    const repairTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture;
    const repairBind = gl.bindTexture.bind(gl), repairAttach = gl.framebufferTexture2D.bind(gl);
    let repairRejected = false, repairAttempts = 0;
    gl.bindTexture = (target, texture) => {
      if (!repairRejected && target === 0x0de1 && texture !== repairTexture) {
        repairRejected = true; repairBind(0xdead, texture);
      } else repairBind(target, texture);
    };
    gl.framebufferTexture2D = (target, point, textureTarget, texture, level) => {
      if (repairRejected && texture === repairTexture) {
        repairAttempts++; repairAttach(0xdead, point, textureTarget, texture, level);
      } else repairAttach(target, point, textureTarget, texture, level);
    };
    let repairBlocked: number, repairBlockedOutput: number[], repairPeerBlocked: number, repairBatchBlocked: number;
    try {
      mutate(O.QOP_IMAGE_OBJECT_DELETE, [1, 33], 1);
      require(repairRejected && repairAttempts > 0, "native rollback rejected");
      require(gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME) === null, "native container remains dirty");
      const attempts = repairAttempts;
      new Uint32Array(memory.buffer, 64, 1).set([0x8069]);
      require(api.host_gl_query(7, O.QOP_GET_INTEGERV, 64, 4, memory.buffer.byteLength + 8, 4, 12) === -14 && repairAttempts === attempts, "repair output preflight");
      new Uint8Array(memory.buffer, 512, 4).fill(0xa5);
      repairBlocked = api.host_gl_query(7, O.QOP_GET_INTEGERV, 64, 4, 512, 4, 12);
      repairBlockedOutput = [...new Uint8Array(memory.buffer, 512, 4)];
      repairPeerBlocked = api.host_gl_query(7, O.QOP_GET_INTEGERV, 64, 4, 512, 4, 11);
      const commands = new DataView(memory.buffer, 4096, 8);
      commands.setUint16(0, O.OP_ACTIVE_TEXTURE, true); commands.setUint16(2, 4, true); commands.setUint32(4, 0x84c4, true);
      repairBatchBlocked = api.host_gl_submit(7, 0, 8, 12);
      require(repairBlocked === -5 && repairPeerBlocked === -5 && repairBatchBlocked === -5, "dependent recovery fence");
    } finally { gl.bindTexture = repairBind; gl.framebufferTexture2D = repairAttach; }
    require(error(12) === 0x500, "recovery preserves native error ownership");
    const repairRestored = pixels(94, 12);
    require(new DataView(query(O.QOP_GET_INTEGERV, [0x8069], 4, 12).buffer).getUint32(0, true) === 33, "old texture binding restored");
    mutate(O.QOP_IMAGE_OBJECT_DELETE, [1, 33]);
    // Storage rollback spans peer containers. Keep its old revision and BO
    // until inverse reattachment and later retired-view cleanup both accept.
    require(kernel.gl.createGpuBo(43, gl, 1, 1) !== null, "storage repair BO");
    const storageBo = kernel.gl.gpuBo(43)!;
    const storageSource = api.host_gl_bind_foreign_texture(7, 22, 43, WPK_IMAGE_SOURCE_TARGET);
    require(storageSource > 0, "storage repair source");
    checked(O.QOP_BIND_IMAGE_OBJECT, [1, 0x0de1, 34], 0, 12);
    send(O.OP_TEX_IMAGE_2D, [0x0de1, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 0], new Uint8Array(), 12);
    require(new DataView(query(O.QOP_BOUND_IMAGE_TARGET, [1, 0x0de1, storageSource], 16, 12).buffer).getUint32(0,true) === 0, "storage initial import");
    mutate(O.QOP_BIND_FRAMEBUFFER, [0x8d40, 95]); mutate(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, 34, 0]);
    send(O.OP_CLEAR_COLOR, [0x3f800000, 0, 0, 0x3f800000], new Uint8Array(), 12); send(O.OP_CLEAR, [0x4000], new Uint8Array(), 12);
    checked(O.QOP_BIND_FRAMEBUFFER, [0x8d40, 96], 0, 11);
    checked(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, 34, 0], 0, 11);
    checked(O.QOP_BIND_IMAGE_OBJECT, [1, 0x0de1, 34], 0, 12); mutate(O.QOP_BIND_FRAMEBUFFER, [0x8d40, 95]);
    const storageOwner = kernel.gl.get(7,12)!, storageObject = storageOwner.textures.get(34)!;
    const storageAttach = gl.framebufferTexture2D.bind(gl); let storageRejected = false, storageRetargets = 0;
    let storageChangedFrame: WebGLFramebuffer|null = null;
    gl.framebufferTexture2D = (target, point, textureTarget, texture, level) => {
      if (!storageRejected && target === gl.DRAW_FRAMEBUFFER && texture !== storageBo.tex && ++storageRetargets === 2) {
        storageRejected = true; storageAttach(0xdead,point,textureTarget,texture,level);
      } else if (storageRejected && texture === storageBo.tex) storageAttach(0xdead,point,textureTarget,texture,level);
      else {
        if (!storageRejected && target === gl.DRAW_FRAMEBUFFER && texture !== storageBo.tex) storageChangedFrame = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
        storageAttach(target,point,textureTarget,texture,level);
      }
    };
    let storageBlocked: number, storageBlockedOutput: number[];
    try {
      mutate(O.QOP_IMAGE_STORAGE, [O.OP_TEX_IMAGE_2D, 0x0de1, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 0], 1);
      require(storageRejected && storageChangedFrame, "storage retarget reached both containers");
      const storageDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,storageChangedFrame);
      const dirtyStorage = gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,storageDraw);
      require(dirtyStorage !== null && dirtyStorage !== storageBo.tex, "shared storage remains dirty");
      new Uint8Array(memory.buffer,512,4).fill(0xa5);
      storageBlocked = api.host_gl_query(7,O.QOP_GET_ERROR,64,0,512,4,11);
      storageBlockedOutput = [...new Uint8Array(memory.buffer,512,4)];
      require(storageBlocked === -5, "shared storage inverse fence");
    } finally { gl.framebufferTexture2D = storageAttach; }
    require(error(12) === 0x500, "storage inverse error ownership");
    const storageRestored = [pixels(95,12),pixels(96,11)];
    const storageReply = new DataView(query(O.QOP_BOUND_IMAGE_STATE,[1,0x0de1],16,12).buffer);
    require(storageReply.getUint32(0,true) === 0 && storageReply.getUint32(12,true) === 0x47514c33, "storage state reply");
    const storageState = [storageReply.getUint32(4,true) === storageSource ? 1 : 0,storageReply.getUint32(8,true)];
    const oldStorage = storageOwner.textureViews.get(storageObject)!;
    const storageDelete = gl.deleteTexture.bind(gl);
    gl.deleteTexture = texture => { if (texture === oldStorage.native) gl.bindTexture(0xdead,null); else storageDelete(texture); };
    let storageCommit: number[], storageCleanupBlocked: number;
    try {
      const accepted = mutate(O.QOP_IMAGE_STORAGE,[O.OP_TEX_IMAGE_2D,0x0de1,0,0x1908,1,1,0,0x1908,0x1401,0]);
      storageCommit = [accepted,storageOwner.textureViews.get(storageObject)!.source === null ? 0 : 1,storageOwner.imageRevisions.get(storageObject)!];
      kernel.gl.retireForeignBo(43);
      require(gl.isTexture(storageBo.tex) && kernel.gl.hasForeignRetirements(), "canonical BO waits for retired view cleanup");
      storageCleanupBlocked = api.host_gl_query(7,O.QOP_GET_ERROR,64,0,512,4,12);
      require(storageCleanupBlocked === -5 && gl.isTexture(oldStorage.native), "retired view cleanup fence");
    } finally { gl.deleteTexture = storageDelete; }
    require(error(12) === 0x500 && !gl.isTexture(storageBo.tex), "view cleanup before canonical BO retirement");
    send(O.OP_TEX_SUB_IMAGE_2D,[0x0de1,0,0,0,1,1,0x1908,0x1401,4],rgba([0,0,255,255]),12);
    const storageOwned = [pixels(95,12),pixels(96,11)];
    // Raw WPK publication must preserve every legal public number and give
    // each reimport a retained identity distinct from the BO's native anchor.
    send(O.OP_ACTIVE_TEXTURE, [0x84c0], new Uint8Array(), 12);
    const canonicalName = kernel.gl.createGpuBo(42, gl, 1, 1)!;
    const rawBo = kernel.gl.gpuBo(42)!;
    checked(O.QOP_BIND_IMAGE_OBJECT, [1, 0x0de1, canonicalName], 0, 12);
    send(O.OP_TEX_IMAGE_2D, [0x0de1, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 4], rgba([0, 0, 255, 255]), 12);
    mutate(O.QOP_BIND_FRAMEBUFFER, [0x8d40, 89]);
    mutate(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, canonicalName, 0]);
    const rawName = api.host_gl_bind_foreign_texture(7, 22, 42, 0x0de1);
    require(rawName > canonicalName && rawName > 0, "raw allocator collision");
    const rawNamespace = pixels(89, 12);
    checked(O.QOP_BIND_IMAGE_OBJECT, [1, 0x0de1, rawName], 0, 12);
    send(O.OP_TEX_PARAMETERI, [0x0de1, 0x2801, 0x2600], new Uint8Array(), 12);
    const rawParams = [gl.getTexParameter(0x0de1, 0x2801) as number];
    const rawPrevious = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(0x0de1, rawBo.tex); rawParams.push(gl.getTexParameter(0x0de1, 0x2801)); gl.bindTexture(0x0de1, rawPrevious);
    mutate(O.QOP_BIND_FRAMEBUFFER, [0x8d40, 90]);
    mutate(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, rawName, 0]);
    send(O.OP_CLEAR_COLOR, [0, 0x3f800000, 0, 0x3f800000], new Uint8Array(), 12); send(O.OP_CLEAR, [0x4000], new Uint8Array(), 12);
    checked(O.QOP_BIND_IMAGE_OBJECT, [1, 0x0de1, 32], 0, 12);
    mutate(O.QOP_IMAGE_STORAGE, [O.OP_TEX_IMAGE_2D, 0x0de1, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 0]);
    mutate(O.QOP_BIND_FRAMEBUFFER, [0x8d40, 91]); mutate(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, 32, 0]);
    send(O.OP_USE_PROGRAM, [103], new Uint8Array(), 12);
    checked(O.QOP_BIND_IMAGE_OBJECT, [1, 0x0de1, rawName], 0, 12);
    const sampleRaw = () => { send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 91], new Uint8Array(), 12); send(O.OP_DRAW_ARRAYS, [0, 0, 1], new Uint8Array(), 12); return pixels(91, 12); };
    const rawGreen = sampleRaw();
    send(O.OP_TEX_IMAGE_2D, [0x0de1, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 4], rgba([255, 0, 0, 255]), 12);
    const rawOrphan = [sampleRaw()];
    const oldRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rawBo.fbo);
    const canonicalPixels = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, canonicalPixels); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, oldRead);
    rawOrphan.push([...canonicalPixels]);
    require(api.host_gl_bind_foreign_texture(7, 22, 42, 0x0de1) === rawName, "raw explicit refresh");
    const rawRefresh = sampleRaw();
    checked(O.QOP_BIND_IMAGE_OBJECT, [1, 0x0de1, rawName], 0, 11);
    checked(O.QOP_BIND_FRAMEBUFFER, [0x8d40, 92], 0, 11);
    checked(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, rawName, 0], 0, 11);
    mutate(O.QOP_IMAGE_OBJECT_DELETE, [1, rawName]);
    const rawNext = api.host_gl_bind_foreign_texture(7, 22, 42, 0x0de1); require(rawNext > rawName, "raw retained reimport identity");
    send(O.OP_ACTIVE_TEXTURE, [0x84c1], new Uint8Array(), 12); checked(O.QOP_BIND_IMAGE_OBJECT, [1, 0x0de1, rawNext], 0, 12);
    send(O.OP_ACTIVE_TEXTURE, [0x84c0], new Uint8Array(), 12); checked(O.QOP_BIND_IMAGE_OBJECT, [1, 0x0de1, rawName], 0, 12);
    send(O.OP_TEX_IMAGE_2D, [0x0de1, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 4], rgba([0, 0, 255, 255]), 12);
    mutate(O.QOP_BIND_FRAMEBUFFER, [0x8d40, 93]); mutate(O.QOP_IMAGE_ATTACHMENT, [1, 0x8d40, 0x8ce0, 0x0de1, rawName, 0]);
    const retireAttach = gl.framebufferTexture2D.bind(gl); let retireRejects = 2;
    gl.framebufferTexture2D = (target, point, textureTarget, texture, level) => {
      if (texture === null && retireRejects) { retireRejects--; retireAttach(0xdead, point, textureTarget, texture, level); }
      else retireAttach(target, point, textureTarget, texture, level);
    };
    let rawBlocked: number, rawBlockedOutput: number[], rawInvalid: number;
    try {
      kernel.gl.retireForeignBo(42);
      require(kernel.gl.hasForeignRetirements() && gl.isTexture(rawBo.tex), "raw backing quarantined");
      new Uint32Array(memory.buffer, 64, 1).set([0x8069]); new Uint8Array(memory.buffer, 512, 4).fill(0xa5);
      rawInvalid = api.host_gl_query(7, O.QOP_GET_INTEGERV, 64, 4, memory.buffer.byteLength + 8, 4, 12);
      require(rawInvalid === -14 && retireRejects === 1, "raw output preflight before retirement");
      rawBlocked = api.host_gl_query(7, O.QOP_GET_INTEGERV, 64, 4, 512, 4, 12); rawBlockedOutput = [...new Uint8Array(memory.buffer, 512, 4)];
      require(rawBlocked === -5 && gl.isTexture(rawBo.tex), "raw pending group blocked");
    } finally { gl.framebufferTexture2D = retireAttach; }
    require(error(11) === 0x500 && !kernel.gl.hasForeignRetirements() && !gl.isTexture(rawBo.tex), "raw retirement retry");
    const rawRevoked = [new DataView(query(O.QOP_GET_INTEGERV, [0x8069], 4, 11).buffer).getUint32(0, true)];
    send(O.OP_ACTIVE_TEXTURE, [0x84c1], new Uint8Array(), 12); rawRevoked.push(new DataView(query(O.QOP_GET_INTEGERV, [0x8069], 4, 12).buffer).getUint32(0, true));
    send(O.OP_ACTIVE_TEXTURE, [0x84c0], new Uint8Array(), 12); rawRevoked.push(new DataView(query(O.QOP_GET_INTEGERV, [0x8069], 4, 12).buffer).getUint32(0, true) === rawName ? 1 : -1);
    const rawReplacement = pixels(93, 12);
    send(O.OP_BIND_FRAMEBUFFER, [0x8d40, 90], new Uint8Array(), 12);
    const rawMissing = new DataView(query(O.QOP_CHECK_FB_STATUS, [0x8d40], 4, 12).buffer).getUint32(0, true);
    const errors = [error(12)];
    api.host_gl_destroy_context(7, 21);
    const afterSourceRetirement = pixels(81, 12);
    errors.push(error(12));
    api.host_gl_destroy_context(7, 22);
    api.host_gl_unbind(7, 11);
    api.host_gl_unbind(7, 12);
    api.host_gbm_bo_destroy(7, 41);
    const clean = made.length === deleted.length && made.every(value => deleted.includes(value)) && live.every(check => !check());
    postMessage({ type: "image_storage_result", namespace, firstParam, secondParam, red, rboName, green, sampledGreen, orphan, aSource, bSource, mipOrphan, reimport, rboSource, rboOrphan, rejected, retargetRejected, reused, retained, retainedState, retainedImport, retainedImported, reusedAfterPeerImport, afterSourceRetirement, mutationRollback, storageReject, ownedStorageRetry, framebufferBindReject, framebufferBindRetry, bufferBindReject, bufferBindRetry, bufferDeleteRollback, bufferDeleteCleared, bufferDeleteRetry, captureEnd, captureBlocked, captureOutput, captureState, capturePixels, promotionSubmit, promotionBlocked, promotionDraws, promotionPixels, pointerSubmit, pointerBlocked, pointerOutput, pointerPixels, convertedRetryPixels, repairBlocked, repairBlockedOutput, repairPeerBlocked, repairBatchBlocked, repairRestored, storageBlocked, storageBlockedOutput, storageRestored, storageState, storageCommit, storageCleanupBlocked, storageOwned, rawNamespace, rawParams, rawGreen, rawOrphan, rawRefresh, rawInvalid, rawBlocked, rawBlockedOutput, rawRevoked, rawReplacement, rawMissing, errors, clean, error: gl.getError() });
  }
  catch (error) {
    postMessage({ type: "image_storage_failed", error: String(error) });
  }
};
