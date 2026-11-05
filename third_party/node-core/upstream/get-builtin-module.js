function getBuiltinModule(id) {
  validateString(id, 'id');
  const normalizedId = BuiltinModule.normalizeRequirableId(id);
  return normalizedId ? require(normalizedId) : undefined;
}
