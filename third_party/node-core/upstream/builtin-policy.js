const builtinModulePolicies = [
  ['bench', true, '--experimental-bench'],
  ['bench/reporters', true, '--experimental-bench'],
  ['dtls', true, '--experimental-dtls'],
  ['ffi', true, '--experimental-ffi'],
  ['sea', true, null],
  ['sqlite', true, '--experimental-sqlite'],
  ['quic', true, '--experimental-quic'],
  ['stream/iter', false, '--experimental-stream-iter'],
  ['test', true, null],
  ['test/reporters', true, null],
  ['vfs', true, '--experimental-vfs'],
  ['zlib/iter', false, '--experimental-stream-iter'],
];

const schemelessBlockList = new SafeSet();
const optionGatedBuiltinOptions = new SafeMap();
for (let i = 0; i < builtinModulePolicies.length; i++) {
  const { 0: id, 1: schemeOnly, 2: option } = builtinModulePolicies[i];
  if (schemeOnly) {
    schemelessBlockList.add(id);
  }
  if (option !== null) {
    optionGatedBuiltinOptions.set(id, option);
  }
}

const publicBuiltinIds = builtinIds
  .filter((id) =>
    !StringPrototypeStartsWith(id, 'internal/') &&
      !optionGatedBuiltinOptions.has(id),
  );
// Do not expose the loaders to user land even with --expose-internals.
const internalBuiltinIds = builtinIds
  .filter((id) => StringPrototypeStartsWith(id, 'internal/') && id !== selfId);

// When --expose-internals is on we'll add the internal builtin ids to these.
let canBeRequiredByUsersList = new SafeSet(publicBuiltinIds);
let canBeRequiredByUsersWithoutSchemeList =
  new SafeSet(publicBuiltinIds.filter((id) => !schemelessBlockList.has(id)));

class BuiltinModule {
  static allowRequireByUsers(id) {
    if (id === selfId) {
      // No code because this is an assertion against bugs.
      // eslint-disable-next-line no-restricted-syntax
      throw new Error(`Should not allow ${id}`);
    }
    canBeRequiredByUsersList.add(id);
    if (!schemelessBlockList.has(id)) {
      canBeRequiredByUsersWithoutSchemeList.add(id);
    }
  }

  static allowOptionGatedBuiltins(getOptionValue) {
    for (const { 0: id, 1: option } of optionGatedBuiltinOptions) {
      if (getOptionValue(option)) {
        BuiltinModule.allowRequireByUsers(id);
      }
    }
  }

  static canBeRequiredByUsers(id) {
    return canBeRequiredByUsersList.has(id);
  }

  static canBeRequiredWithoutScheme(id) {
    return canBeRequiredByUsersWithoutSchemeList.has(id);
  }

  static normalizeRequirableId(id) {
    if (StringPrototypeStartsWith(id, 'node:')) {
      const normalizedId = StringPrototypeSlice(id, 5);
      if (BuiltinModule.canBeRequiredByUsers(normalizedId)) {
        return normalizedId;
      }
    } else if (BuiltinModule.canBeRequiredWithoutScheme(id)) {
      return id;
    }

    return undefined;
  }

  static isBuiltin(id) {
    return BuiltinModule.canBeRequiredWithoutScheme(id) || (
      typeof id === 'string' &&
        StringPrototypeStartsWith(id, 'node:') &&
        BuiltinModule.canBeRequiredByUsers(StringPrototypeSlice(id, 5))
    );
  }

  static getSchemeOnlyModuleNames() {
    return ArrayFrom(schemelessBlockList);
  }

  static getAllBuiltinModuleIds() {
    const allBuiltins = ArrayFrom(canBeRequiredByUsersWithoutSchemeList);
    ArrayPrototypePushApply(
      allBuiltins,
      ArrayPrototypeMap(
        ArrayPrototypeFilter(
          ArrayFrom(schemelessBlockList),
          (id) => canBeRequiredByUsersList.has(id),
        ),
        (id) => 'node:' + id,
      ),
    );
    return allBuiltins;
  }
}
