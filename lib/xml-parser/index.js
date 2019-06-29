var debug = require('debug')('azure:xml-parser');
try {
  module.exports = require('./libxmljs-parser');
} catch (err) {
  debug("Failed to load libxmljs, falling back to xml2js, error: %s",
        err.stack);
  try {
    module.exports = require('./xml2js-parser');
  } catch (err) {
    debug("Failed to load xml2js, falling back to pixl-xml, error: %s",
          err.stack);
    module.exports = require('./pixl-xml-parser');
  }
}
