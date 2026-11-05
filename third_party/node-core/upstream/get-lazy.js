function getLazy(initializer) {
  let value;
  let initialized = false;
  return function() {
    if (initialized === false) {
      value = initializer();
      initialized = true;
    }
    return value;
  };
}
