var debug = require('debug')('azure:xml-parser');
try {
  module.exports = require('./libxmljs-parser');
} catch (err) {
  debug("Failed to load libxmljs, falling back to pixl-xml, error: %s",
        err.stack);
  module.exports = require('./pixl-xml-parser');
}