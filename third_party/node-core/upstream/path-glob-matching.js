let minimatch;
function lazyMinimatch() {
  minimatch ??= require('internal/deps/minimatch/index');
  return minimatch;
}

function createMatcher(pattern, options = kEmptyObject) {
  const opts = {
    __proto__: null,
    nocase: isWindows || isMacOS,
    windowsPathsNoEscape: true,
    nonegate: true,
    nocomment: true,
    optimizationLevel: 2,
    platform: process.platform,
    nocaseMagicOnly: true,
    ...options,
  };
  return new (lazyMinimatch().Minimatch)(pattern, opts);
}

const kGlobPatternCacheLimit = 250;
const patternFnCache = new SafeMap();

/**
 * Check if a path matches a glob pattern
 * @param {string} path the path to check
 * @param {string} pattern the glob pattern to match
 * @param {boolean} windows whether the path is on a Windows system, defaults to `isWindows`
 * @returns {boolean}
 */
function matchGlobPattern(path, pattern, windows = isWindows) {
  validateString(path, 'path');
  validateString(pattern, 'pattern');

  const cacheKey = `${windows ? 'win32' : 'posix'}:${pattern}`;
  let matcher;
  if (patternFnCache.has(cacheKey)) {
    matcher = patternFnCache.get(cacheKey);
  } else {
    matcher = createMatcher(pattern, {
      kEmptyObject,
      platform: windows ? 'win32' : 'posix',
    });
    patternFnCache.set(cacheKey, matcher);

    if (patternFnCache.size >= kGlobPatternCacheLimit) {
      patternFnCache.delete(patternFnCache.keys().next().value);
    }
  }

  return matcher.match(path);
}
