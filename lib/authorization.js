var querystring       = require('querystring');
var debug             = require('debug')('azure:authorization');
var utils             = require('./utils');

/*
 * Authorize the request with a shared-access-signature that is refreshed with
 * the a function given as `options.sas`.
 * Intended to define `<Queue|Table|Blob>.prototype.authorize`.
 */
var authorizeWithRefreshSAS = function authorizeWithRefreshSAS(method, path, query, headers) {
  var self = this;
  // Check if we should refresh SAS
  if (Date.now() > this._nextSASRefresh && this._nextSASRefresh !== 0) {
    debug("Refreshing shared-access-signature");
    // Avoid refreshing more than once
    this._nextSASRefresh = 0;
    // Refresh SAS
    this._sas = Promise.resolve(this.options.sas());
    // Update _nextSASRefresh when the SAS has been refreshed
    this._sas.then(function(sas) {
      sas = querystring.parse(sas);
      // Find next sas refresh time
      self._nextSASRefresh = (
        new Date(sas.se).getTime() - self.options.minSASAuthExpiry
      );
      debug("Refreshed shared-access-signature, will refresh in %s ms",
        self._nextSASRefresh);
      // Throw an error if the signature expiration comes too soon
      if (Date.now() > self._nextSASRefresh) {
        throw new Error("Refreshed SAS, but got a Shared-Access-Signature " +
          "that expires less than options.minSASAuthExpiry " +
          "from now, signature expiry: " + sas.se);
      }
    });
  }

  // Construct request options, whenever the `_sas` promise is resolved.
  return this._sas.then(function(sas) {
    // Serialize query-string
    var qs = querystring.stringify(query);
    if (qs.length > 0) {
      qs += '&';
    }
    qs += sas
    return {
      host:       self.hostname,
      method:     method,
      path:       path + '?' + qs,
      headers:    headers,
      agent:      self.options.agent,
    };
  });
}

exports.authorizeWithRefreshSAS = authorizeWithRefreshSAS;

/*
 * Authorize the request with a shared-access-signature that is given with
 * `options.sas` as string.
 * Intended to define `<Queue|Table|Blob>.prototype.authorize`.
 */
function authorizeWithSAS(method, path, query, headers) {
  // Serialize query-string
  var qs = querystring.stringify(query);
  if (qs.length > 0) {
    qs += '&';
  }
  qs += this.options.sas;
  // Construct request options
  return Promise.resolve({
    host:       this.hostname,
    method:     method,
    path:       path + '?' + qs,
    headers:    headers,
    agent:      this.options.agent,
  });
}

exports.authorizeWithSAS = authorizeWithSAS;

/*
 * Authorize the request with shared key
 * Intended to define `<Queue|Table|Blob>.prototype.authorize`.
 *
 * Note that this function should be called in the service context.
 * @param {string} service - the name of the service: queue|blob|table
 * @param {Array} queryParamsSupported - a sorted array which contains the query parameters supported by the storage service
 */
var authorizeWithSharedKey = function (service, queryParamsSupported) {
  var self = this;
  return function(method, path, query, headers) {
    // Find account id
    var accountId = self.options.accountId;

    // Build string to sign
    var stringToSign;
    if(service === 'table') {
      stringToSign = (
        method + '\n' +
        (headers['content-md5']  || '') + '\n' +
        (headers['content-type'] || '') + '\n' +
        headers['x-ms-date']
      );
      stringToSign += '\n/' + accountId + path;
      if (query.comp !== undefined) {
        stringToSign += '?comp=' + query.comp;
      }
    } else {
      stringToSign = (
        method + '\n' +
        (headers['content-encoding']     || '') + '\n' +
        (headers['content-language']     || '') + '\n' +
        (headers['content-length']       || '') + '\n' +
        (headers['content-md5']          || '') + '\n' +
        (headers['content-type']         || '') + '\n' +
        '\n' + // we always include x-ms-date, so we never specify date header
        (headers['if-modified-since']    || '') + '\n' +
        (headers['if-match']             || '') + '\n' +
        (headers['if-none-match']        || '') + '\n' +
        (headers['if-unmodified-since']  || '') + '\n' +
        (headers['range']                || '')
      );

      // Construct fields as a sorted list of 'x-ms-' prefixed headers
      var fields = [];
      for (var field in headers) {
        if (/^x-ms-/.test(field)) {
          fields.push(field);
        }
      }
      fields.sort();

      // Add lines for canonicalized headers using presorted list of fields
      var N = fields.length;
      for(var i = 0; i < N; i++) {
        var field = fields[i];
        var value = headers[field];
        if (value) {
          // Convert each HTTP header to lower case and
          // trim any white space around the colon in the header.
          stringToSign += '\n' + field.toLowerCase() + ':' + value.trim();
        }
      }

      // Added lines from canonicalized resource and query-string parameters
      // supported by this library in lexicographical order as presorted in
      // QUERY_PARAMS_SUPPORTED
      stringToSign += '\n/' + accountId + path;
      var M = queryParamsSupported.length;
      for(var j = 0; j < M; j++) {
        var param = queryParamsSupported[j];
        var value = query[param];
        if (value) {
          stringToSign += '\n' + param + ':' + value;
        }
      }
    }

    // Compute signature
    var signature = utils.hmacSha256(self._accessKey, stringToSign);

    // Set authorization header
    headers.authorization = 'SharedKey ' + accountId + ':' + signature;

    // Encode query string
    var qs = querystring.stringify(query);

    // Construct request options
    return Promise.resolve({
      host:       self.hostname,
      method:     method,
      path:       (qs.length > 0 ? path + '?' + qs : path),
      headers:    headers,
      agent:      self.options.agent,
    });
  };
}

exports.authorizeWithSharedKey = authorizeWithSharedKey;
