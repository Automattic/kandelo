// Public Database/Statement owners over real native SQLite handles. Incomplete
// callback/tag-store/backup features remain explicit;
// namespace presence is not complete SQLite conformance.
function _createNodeSqlitePlatform(platform) {
    'use strict';
    const P = _createNodePrimordials();
    const { SafeWeakMap, SafeMap, ObjectCreate, ObjectGetOwnPropertyNames, ObjectDefineProperty,
        ObjectSetPrototypeOf, Number, NumberIsInteger, ReflectApply, SymbolDispose, Uint8Array } = P;
    const databases = new SafeWeakMap(), statements = new SafeWeakMap(), sessions = new SafeWeakMap(), iterators = new SafeWeakMap();
    const limitNames = /* NODE_SQLITE_LIMIT_NAMES */;
    const decoder = new platform.TextDecoder();
    const decode = Function.call.bind(platform.TextDecoder.prototype.decode);
    const { isArrayBufferView, isAnyArrayBuffer } = platform.util.types;
    const sqliteNative = platform.native.sqlite;
    const native = (...args) => ReflectApply(sqliteNative, platform.native, args);
    function fail(code, message, Type = P.Error) { const error = new Type(message); error.code = code; throw error; }
    function unavailable(name) { return fail('ERR_NOT_IMPLEMENTED', 'SQLite feature is not implemented: ' + name); }
    function argument(name, type) { return fail('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be ${type}.`, P.TypeError); }
    function boolean(value, name, fallback) {
        if (value === undefined && fallback !== undefined) return fallback;
        if (typeof value !== 'boolean') argument(name, 'a boolean');
        return value;
    }
    function string(value, name) { if (typeof value !== 'string') argument(name, 'a string'); return value; }
    function optionsObject(value) {
        if (value === null || (typeof value !== 'object' && typeof value !== 'function')) argument('options', 'an object');
        return value;
    }
    function database(object) { const value = databases.get(object); if (!value) fail('ERR_INVALID_THIS', 'Invalid Database receiver', P.TypeError); return value; }
    function statement(object) { const value = statements.get(object); if (!value) fail('ERR_INVALID_THIS', 'Invalid Statement receiver', P.TypeError); return value; }
    function session(object) { const value = sessions.get(object); if (!value) fail('ERR_INVALID_THIS', 'Invalid Session receiver', P.TypeError); return value; }
    function limitValue(value, constructor, name) {
        if (!constructor && value === Infinity) return 2147483647;
        if (typeof value !== 'number' || !NumberIsInteger(value) || value < -2147483648 || value > 2147483647)
            fail('ERR_INVALID_ARG_TYPE', constructor ? `The "options.limits.${name}" argument must be an integer.` : 'Limit value must be a non-negative integer or Infinity.', P.TypeError);
        if (value < 0) fail('ERR_OUT_OF_RANGE', constructor ? `The "options.limits.${name}" argument must be non-negative.` : 'Limit value must be non-negative.', P.RangeError);
        return value;
    }
    function pathString(value) {
        if (value instanceof platform.URL) value = platform.fileURLToPath(value);
        if (platform.Buffer.isBuffer(value)) value = decode(decoder, value);
        if (typeof value !== 'string') argument('path', 'a string, Buffer, or URL');
        if (P.StringPrototypeIncludes(value, '\0')) fail('ERR_INVALID_ARG_VALUE', 'Database path must not contain null bytes');
        return value;
    }
    function integer(value, big) {
        if (big) return value;
        if (value < -9007199254740991n || value > 9007199254740991n) {
            fail('ERR_OUT_OF_RANGE', 'Value is too large to be represented as a JavaScript number: ' + value, P.RangeError);
        }
        return Number(value);
    }
    function config(options, defaults, prefix) {
        const result = { ...defaults };
        const names = ['returnArrays', 'readBigInts', 'allowBareNamedParameters', 'allowUnknownNamedParameters'];
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            result[name] = boolean(options[name], prefix + name, result[name]);
        }
        return result;
    }
    class Database {
        constructor(path, options) {
            const location = pathString(path);
            if (arguments.length > 1) optionsObject(options); else options = {};
            const open = boolean(options.open, 'options.open', true);
            const readOnly = boolean(options.readOnly, 'options.readOnly', false);
            const foreignKeys = boolean(options.enableForeignKeyConstraints, 'options.enableForeignKeyConstraints', true);
            const doubleQuotedStrings = boolean(options.enableDoubleQuotedStringLiterals, 'options.enableDoubleQuotedStringLiterals', false);
            const extensions = boolean(options.allowExtension, 'options.allowExtension', false);
            const timeoutOption = options.timeout;
            const timeout = timeoutOption === undefined ? 0 : timeoutOption;
            if (typeof timeout !== 'number' || !NumberIsInteger(timeout) || timeout < -2147483648 || timeout > 2147483647) argument('options.timeout', 'an integer');
            // Read constructor configuration in target order before creating a
            // native connection; getters may throw or mutate caller state.
            const defaults = { readBigInts: boolean(options.readBigInts, 'options.readBigInts', false),
                returnArrays: boolean(options.returnArrays, 'options.returnArrays', false),
                allowBareNamedParameters: boolean(options.allowBareNamedParameters, 'options.allowBareNamedParameters', true),
                allowUnknownNamedParameters: boolean(options.allowUnknownNamedParameters, 'options.allowUnknownNamedParameters', false) };
            const defensive = boolean(options.defensive, 'options.defensive', true);
            const limitOptions = options.limits, limits = [];
            if (limitOptions !== undefined) {
                if (limitOptions === null || (typeof limitOptions !== 'object' && typeof limitOptions !== 'function')) argument('options.limits', 'an object');
                for (let i = 0; i < limitNames.length; i++) {
                    const name = limitNames[i], value = limitOptions[name];
                    limits[i] = value === undefined ? undefined : limitValue(value, true, name);
                }
            }
            if (extensions) unavailable('extension permission and library owner');
            platform.markUncloneable(this);
            const handle = native('create', location, { open, readOnly, foreignKeys, doubleQuotedStrings, defensive, timeout, limits });
            try { databases.set(this, { handle, defaults }); }
            catch (error) {
                try { if (native('isOpen', handle)) native('close', handle); } catch {}
                throw error;
            }
        }
        open() { native('open', database(this).handle); }
        close() { native('close', database(this).handle); }
        get isOpen() { return native('isOpen', database(this).handle); }
        get isTransaction() { return native('isTransaction', database(this).handle); }
        exec(sql) { native('exec', database(this).handle, string(sql, 'sql')); }
        location(dbName = 'main') { return native('location', database(this).handle, string(dbName, 'dbName')); }
        prepare(sql, options) {
            const db = database(this);
            string(sql, 'sql');
            if (options !== undefined) optionsObject(options); else options = {};
            const settings = config(options, db.defaults, 'options.');
            const persistent = boolean(options.persistent, 'options.persistent', false);
            const result = ObjectCreate(Statement.prototype);
            platform.markUncloneable(result);
            const handle = native('prepare', db.handle, sql, persistent);
            try { statements.set(result, { handle, database: this, settings, active: false, generation: 0 }); }
            catch (error) {
                try { native('finalize', handle); } catch {}
                throw error;
            }
            return result;
        }
        function(...args) {
            const db = database(this); native('checkDatabase', db.handle);
            const name = string(args[0], 'name');
            const fnIndex = args.length < 3 ? 1 : 2;
            let big = false, varargs = false, deterministic = false, direct = false;
            if (fnIndex === 2) {
                const options = optionsObject(args[1]);
                big = boolean(options.useBigIntArguments, 'options.useBigIntArguments', false);
                varargs = boolean(options.varargs, 'options.varargs', false);
                deterministic = boolean(options.deterministic, 'options.deterministic', false);
                direct = boolean(options.directOnly, 'options.directOnly', false);
            }
            const fn = args[fnIndex];
            if (typeof fn !== 'function') argument('function', 'a function');
            const arity = varargs ? -1 : callbackArity(fn, 'function.length');
            // Every getter above can close the database. The native owner
            // checks again after those user calls, before SQLite registration.
            native('registerScalar', db.handle, name, fn, arity, big, deterministic, direct);
        }
        aggregate(...args) {
            const db = database(this); native('checkDatabase', db.handle);
            const name = string(args[0], 'name'), options = optionsObject(args[1]);
            const start = options.start;
            if (start === undefined) argument('options.start', 'a function or a primitive value');
            const step = options.step;
            if (typeof step !== 'function') argument('options.step', 'a function');
            const result = options.result;
            const big = boolean(options.useBigIntArguments, 'options.useBigIntArguments', false);
            const varargs = boolean(options.varargs, 'options.varargs', false);
            const direct = boolean(options.directOnly, 'options.directOnly', false);
            const inverse = options.inverse;
            if (inverse !== undefined && typeof inverse !== 'function') argument('options.inverse', 'a function');
            let arity = -1;
            if (!varargs) {
                const stepLength = callbackArity(step, 'options.step.length');
                const inverseLength = inverse === undefined ? stepLength : callbackArity(inverse, 'options.inverse.length');
                arity = P.MathMax((stepLength - 1) | 0, (inverseLength - 1) | 0, 0);
            }
            native('registerAggregate', db.handle, name, start, step, inverse,
                typeof result === 'function' ? result : undefined, arity, big, direct);
        }
        createSession(options) {
            const db = database(this);
            native('checkDatabase', db.handle);
            let schema = 'main', table = '';
            if (arguments.length) {
                optionsObject(options);
                if (P.ObjectPrototypeHasOwnProperty(options, 'table')) table = string(options.table, 'options.table');
                if (P.ObjectPrototypeHasOwnProperty(options, 'db')) schema = string(options.db, 'options.db');
            }
            // Option getters can close the connection. The native owner
            // rechecks its actual state before allocating a SQLite session.
            const result = ObjectCreate(Session.prototype);
            platform.markUncloneable(result);
            const handle = native('createSession', db.handle, schema, table);
            try { sessions.set(result, { handle, database: this }); }
            catch (error) { try { native('closeSession', handle, true); } catch {} throw error; }
            return result;
        }
        applyChangeset(changeset, options) {
            const db = database(this);
            native('checkDatabase', db.handle);
            if (!platform.util.types.isUint8Array(changeset)) argument('changeset', 'a Uint8Array');
            let conflict, filter;
            if (options !== undefined) {
                optionsObject(options);
                conflict = options.onConflict;
                if (conflict !== undefined && typeof conflict !== 'function') argument('options.onConflict', 'a function');
                if (P.ObjectPrototypeHasOwnProperty(options, 'filter')) {
                    filter = options.filter;
                    if (typeof filter !== 'function') argument('options.filter', 'a function');
                }
            }
            return native('applyChangeset', db.handle, changeset, filter, conflict);
        }
        createTagStore() { return unavailable('tag-store cache owner'); }
        setAuthorizer() { return unavailable('authorizer callback owner'); }
        enableLoadExtension() { return unavailable('extension permission/library owner'); }
        loadExtension() { return unavailable('extension permission/library owner'); }
        enableDefensive(active) {
            const db = database(this); native('checkDatabase', db.handle);
            native('defensive', db.handle, boolean(active, 'active'));
        }
        get limits() { const db = database(this); return db.limits ??= native('limits', db.handle); }
    }
    ObjectDefineProperty(Database.prototype, SymbolDispose, { configurable: true, writable: true,
        value() { const value = database(this); if (native('isOpen', value.handle)) native('close', value.handle); } });
    function callbackArity(fn, name) {
        const value = fn.length;
        if (typeof value !== 'number' || !NumberIsInteger(value) || P.ObjectIs(value, -0) || value < -2147483648 || value > 2147483647)
            fail('ERR_INVALID_ARG_TYPE', `The "${name}" property must be an integer.`, P.TypeError);
        return value;
    }
    function bind(owner, args) {
        owner.generation++;
        native('reset', owner.handle, true);
        const names = native('parameters', owner.handle);
        let start = 0;
        const first = args[0];
        if (first !== null && typeof first === 'object' && !isArrayBufferView(first) && !isAnyArrayBuffer(first)) {
            const bare = new SafeMap();
            if (owner.settings.allowBareNamedParameters) for (let i = 0; i < names.length; i++) {
                const name = names[i]; if (!name) continue;
                const key = P.StringPrototypeSlice(name, 1), previous = bare.get(key);
                if (previous !== undefined && previous !== name) fail('ERR_INVALID_STATE', `Cannot create bare named parameter '${key}' because of conflicting names '${previous}' and '${name}'.`);
                bare.set(key, name);
            }
            const keys = ObjectGetOwnPropertyNames(first);
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                let index = P.ArrayPrototypeIndexOf(names, key);
                if (index === -1 && owner.settings.allowBareNamedParameters) index = P.ArrayPrototypeIndexOf(names, bare.get(key));
                if (index === -1) {
                    if (owner.settings.allowUnknownNamedParameters) continue;
                    fail('ERR_INVALID_STATE', `Unknown named parameter '${key}'`);
                }
                bindValue(owner, index + 1, first[key]);
            }
            start = 1;
        }
        let index = 0;
        for (let i = start; i < args.length; i++) {
            while (names[index] && !P.StringPrototypeStartsWith(names[index], '?')) index++;
            bindValue(owner, ++index, args[i]);
        }

    }
    function bindValue(owner, index, value) {
        // Preserve raw-buffer versus view identity. Node's native contents
        // adapter gives a fixed empty ArrayBuffer a null data pointer, while
        // an empty view uses non-null scratch storage; SQLite distinguishes
        // SQL NULL from an empty BLOB at that ABI boundary.
        if (platform.util.types.isSharedArrayBuffer(value)) unavailable('shared SQLite binding storage');
        if (!(value === null || value === undefined || typeof value === 'number' || typeof value === 'bigint' ||
            typeof value === 'boolean' || typeof value === 'string' || isArrayBufferView(value) || isAnyArrayBuffer(value))) {
            fail('ERR_INVALID_ARG_TYPE', `Provided value cannot be bound to SQLite parameter ${index}.`, P.TypeError);
        }
        if (typeof value === 'bigint' && (value < -9223372036854775808n || value > 9223372036854775807n)) {
            fail('ERR_INVALID_ARG_VALUE', 'BigInt value is too large to bind.');
        }
        native('bind', owner.handle, index, value);
    }
    function row(owner, raw, names) {
        const result = owner.settings.returnArrays ? [] : ObjectCreate(null);
        for (let i = 0; i < raw.length; i++) {
            const type = raw[i][0], value = raw[i][1];
            const converted = type === 1 ? integer(value, owner.settings.readBigInts) : type === 3 ? decode(decoder, value) : value;
            // Define a data property even for __proto__/setter-looking names.
            ObjectDefineProperty(result, owner.settings.returnArrays ? i : names[i],
                { value: converted, writable: true, enumerable: true, configurable: true });
        }
        return result;
    }
    function execute(object, mode, args) {
        const owner = statement(object);
        if (owner.active) fail('ERR_INVALID_STATE', 'statement is already executing');
        owner.active = true;
        let failed = false;
        try {
            bind(owner, args);
            if (mode === 'run') {
                native('stepDiscard', owner.handle);
                native('reset', owner.handle);
                const db = database(owner.database);
                return { lastInsertRowid: integer(native('lastInsertRowid', db.handle), owner.settings.readBigInts),
                    changes: integer(native('changes', db.handle), owner.settings.readBigInts) };
            }
            const result = [];
            for (;;) {
                const raw = native('step', owner.handle);
                if (raw === null) return mode === 'get' ? undefined : result;
                const value = row(owner, raw, native('names', owner.handle));
                if (mode === 'get') return value;
                P.ArrayPrototypePush(result, value);
            }
        } catch (error) {
            failed = true; throw error;
        } finally {
            // Preserve a primary error if a getter finalized this statement.
            // A cleanup error after success must remain an observable failure.
            try { native('reset', owner.handle, false, failed); }
            catch (error) { if (!failed) throw error; }
            finally { owner.active = false; }
        }
    }
    class Statement {
        constructor() { fail('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', P.TypeError); }
        all(...args) { return execute(this, 'all', args); }
        get(...args) { return execute(this, 'get', args); }
        run(...args) { return execute(this, 'run', args); }
        get sourceSQL() { return native('sourceSQL', statement(this).handle); }
        get expandedSQL() { return native('expandedSQL', statement(this).handle); }
        setReadBigInts(value) { statement(this).settings.readBigInts = boolean(value, 'readBigInts'); }
        setReturnArrays(value) { statement(this).settings.returnArrays = boolean(value, 'returnArrays'); }
        setAllowBareNamedParameters(value) { statement(this).settings.allowBareNamedParameters = boolean(value, 'allowBareNamedParameters'); }
        setAllowUnknownNamedParameters(value) { statement(this).settings.allowUnknownNamedParameters = boolean(value, 'allowUnknownNamedParameters'); }
        iterate(...args) {
            const owner = statement(this);
            if (owner.active) fail('ERR_INVALID_STATE', 'statement is already executing');
            owner.active = true;
            try {
                bind(owner, args);
                const result = ObjectCreate(StatementIterator.prototype);
                iterators.set(result, { statement: this, generation: owner.generation, done: false });
                return result;
            } finally { owner.active = false; }
        }
        columns() {
            const rows = native('columns', statement(this).handle), result = [];
            const keys = ['column', 'database', 'name', 'table', 'type'];
            for (let i = 0; i < rows.length; i++) {
                const column = ObjectCreate(null);
                for (let j = 0; j < keys.length; j++) column[keys[j]] = rows[i][j];
                P.ArrayPrototypePush(result, column);
            }
            return result;
        }
    }
    function iterator(object) {
        const value = iterators.get(object);
        if (!value) fail('ERR_INVALID_THIS', 'Invalid StatementIterator receiver', P.TypeError);
        const owner = statement(value.statement);
        native('checkStatement', owner.handle); // finalized check even after done
        return [value, owner];
    }
    function iterationResult(done, value) { const result = ObjectCreate(null); result.done = done; result.value = value; return result; }
    class StatementIterator {
        constructor() { fail('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', P.TypeError); }
        next() {
            const [state, owner] = iterator(this);
            if (state.done) return iterationResult(true, null);
            if (owner.active) fail('ERR_INVALID_STATE', 'statement is already executing');
            if (state.generation !== owner.generation) fail('ERR_INVALID_STATE', 'iterator was invalidated');
            owner.active = true;
            try {
                const raw = native('step', owner.handle);
                if (raw === null) {
                    state.done = true; native('reset', owner.handle);
                    return iterationResult(true, null);
                }
                return iterationResult(false, row(owner, raw, native('names', owner.handle)));
            } finally { owner.active = false; }
        }
        return() {
            const [state, owner] = iterator(this);
            if (!state.done) {
                if (owner.active) fail('ERR_INVALID_STATE', 'statement is already executing');
                owner.active = true;
                try { native('reset', owner.handle, false, true); }
                finally { owner.active = false; }
            }
            state.done = true;
            return iterationResult(true, null);
        }
    }
    ObjectSetPrototypeOf(StatementIterator.prototype, P.Iterator.prototype);
    class Session {
        constructor() { fail('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor', P.TypeError); }
        changeset() { return native('sessionChangeset', session(this).handle, false); }
        patchset() { return native('sessionChangeset', session(this).handle, true); }
        close() { native('closeSession', session(this).handle, false); }
    }
    ObjectDefineProperty(Session.prototype, SymbolDispose, { configurable: true, writable: true,
        value() { native('closeSession', session(this).handle, true); } });
    const binding = { Database, Statement, Session, constants: platform.constants,
        backup() { return unavailable('asynchronous backup owner'); } };
    const module = { exports: {} };
    const internalBinding = name => name === 'sqlite' ? binding : unavailable(name);
    (function(module, exports, internalBinding) {
        /* NODE_PUBLIC_SQLITE */
    })(module, module.exports, internalBinding);
    return module.exports;
}
