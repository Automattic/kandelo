'use strict';
// Candidate URL/path/percent/error algorithms with the real vendored parser.
// Native process/inspection/Buffer are explicit optional dependency controls.
const fs = require('node:fs'), path = require('node:path'), util = require('node:util');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'third_party/node-core/node-core.js'), 'utf8');
const factories = Function(source + ';return { values:_createNodeValuesPlatform, path:_createNodePathPlatform, domain:_createNodeDomainHelpers, urls:_createNodeURLPathPlatform };')();
const webSource = fs.readFileSync(path.join(root, 'third_party/node-web-platform/node-web-platform.js'), 'utf8');
const createWeb = Function(webSource + ';return _createNodeWebPlatform;')();
exports.create = function create(options = {}) {
  const processControl = options.process || process;
  const Buffer = options.Buffer || globalThis.Buffer;
  const web = options.web || createWeb();
  const targetPath = factories.path({ process: processControl, getValues: () => values });
  const values = factories.values({ process: processControl, Buffer, util, inspection: util,
    os: require('node:os'), signals: require('node:os').constants.signals, getDOMException: () => DOMException });
  const domains = factories.domain({ values, web });
  const owner = factories.urls({ process: processControl, Buffer, values, path: targetPath,
    web, domainToUnicode: domains.domainToUnicode });
  return { ...owner, Buffer, URL: web.URL, web, path: targetPath, values };
};
