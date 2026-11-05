let INSPECT_MAX_BYTES = 50;
// Override how buffers are presented by util.inspect().
Buffer.prototype[customInspectSymbol] = function inspect(recurseTimes, ctx) {
  const max = INSPECT_MAX_BYTES;
  const actualMax = MathMin(max, this.length);
  const remaining = this.length - max;
  let str = StringPrototypeTrim(RegExpPrototypeSymbolReplace(
    /(.{2})/g, hexSlice(this, 0, actualMax), '$1 '));
  if (remaining > 0)
    str += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;
  // Inspect special properties as well, if possible.
  if (ctx) {
    let extras = false;
    const filter = ctx.showHidden ? ALL_PROPERTIES : ONLY_ENUMERABLE;
    const obj = { __proto__: null };
    ArrayPrototypeForEach(getOwnNonIndexProperties(this, filter),
                          (key) => {
                            extras = true;
                            obj[key] = this[key];
                          });
    if (extras) {
      if (this.length !== 0)
        str += ', ';
      // '[Object: null prototype] {'.length === 26
      // This is guarded with a test.
      str += StringPrototypeSlice(utilInspect(obj, {
        ...ctx,
        breakLength: Infinity,
        compact: true,
      }), 27, -2);
    }
  }
  let constructorName = 'Buffer';
  try {
    const { constructor } = this;
    if (typeof constructor === 'function' && ObjectPrototypeHasOwnProperty(constructor, 'name')) {
      constructorName = constructor.name;
    }
  } catch { /* Ignore error and use default name */ }
  return `<${constructorName} ${str}>`;
};
Buffer.prototype.inspect = Buffer.prototype[customInspectSymbol];
