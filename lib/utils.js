'use strict';

var Promise     = require('promise');
var https       = require('https');
var crypto      = require('crypto');
var querystring = require('querystring');
var debug       = require('debug')('azure:utils');
var assert      = require('assert');

/*
 * Return promise to sleep for a `delay` ms
 *
 * @param   {Number} delay - Number of ms to sleep.
 * @returns {Promise} A romise that will be resolved after `delay` ms
 */
var sleep = function sleep(delay) {
  return new Promise(function(resolve) {
    setTimeout(resolve, delay);
  });
};

// Export sleep
exports.sleep = sleep;

/*
 * Transient error codes from node https module
 * @const
 */
var TRANSIENT_HTTP_ERROR_CODES = [
  'ETIMEDOUT',
  'ECONNRESET',
  'EADDRINUSE',
  'ESOCKETTIMEDOUT',
  'ECONNREFUSED',
  'RequestTimeoutError',
  'RequestAbortedError',
  'RequestContentLengthError'
];

// Export TRANSIENT_HTTP_ERROR_CODES
exports.TRANSIENT_HTTP_ERROR_CODES = TRANSIENT_HTTP_ERROR_CODES;

/*
 * Retry the asynchronous function `f` until we have exhausted all `retries`,
 * succeed, or encounter an error code not in `transientErrorCodes`.
 * We sleep `Math.min(2 ^ retry * delayFactor, maxDelay)` between each retry.
 * Note, the `f` function must return a promise, and will be given the retry
 * count as first argument, zero for the first request which isn't a _retry_.
 *
 * Warning, for performance reasons this method has no default options, nor does
 * it validate that all options are present. Acceptable because this is mostly
 * intended to be an internal method.
 *
 * @param {Function} f
 * Callback which returns a promise that resolves to if the operation was
 * successful. The callback `f` is the function that will be retried.
 * @param {object} options - Retry options, defined as follows:
 * ```js
 * {
 *   // Max number of request retries
 *   retries:               5,
 *
 *   // Multiplier for computation of retry delay: 2 ^ retry * delayFactor
 *   delayFactor:           100,
 *
 *   // Maximum retry delay in ms (defaults to 30 seconds)
 *   maxDelay:              30 * 1000,
 *
 *   // Error codes for which we should retry
 *   transientErrorCodes:   TRANSIENT_HTTP_ERROR_CODES
 * }
 * ```
 * @returns {Promise} A promise that an iteration `f` of succeeded.
 */
var retry = function retry(f, options) {
  var retry = 0;
  function attempt() {
    return new Promise(function(accept) {
      accept(f(retry));
    }).catch(function(err) {
      // Add number of retries to the error object
      err.retries = retry;

      // Don't retry if this is a non-transient error
      if (options.transientErrorCodes.indexOf(err.code) === -1) {
        throw err;
      }

      // Don't retry if retries have been exhausted
      if (retry >= options.retries) {
        throw err;
      }
      retry += 1;

      // Compute delay
      var delay = Math.min(
        Math.pow(2, retry) * options.delayFactor,
        options.maxDelay
      );

      // Sleep for the delay and try again
      return sleep(delay).then(function() {
        return attempt();
      });
    });
  };
  return attempt();
};

// Export retry
exports.retry = retry;

/*
 * Auxiliary function to create `https.request` with `options` send `data` as
 * UTF-8 and buffer up the response as `payload` property on the response.
 *
 * @param {object} options - `options` compatible with `https.request`.
 * @param {string} data - String to send as UTF-8, or `undefined`.
 * @param {number} timeout - Client-side timeout in milliseconds.
 * @returns {Promise}
 * A promise for the response object with `payload` property as string.
 */
var request = function request(options, data, timeout) {
  return new Promise(function(resolve, reject) {
    // Create https request
    var req = https.request(options);
    req.setTimeout(timeout, function() {
      req.abort();
    });

    // Reject promise
    req.once('error', reject);

    // Reject on abort which happens if there is a timeout
    req.once('abort', function() {
      var err = new Error('Requested aborted by client due to timeout');
      err.code = 'RequestTimeoutError';
      reject(err);
    });

    // Reject on aborted which happens if the server aborts the request
    req.once('aborted', function() {
      var err = new Error('Request aborted by server');
      err.code = 'RequestAbortedError';
      reject(err);
    });

    // On response, we buffer up the incoming stream and resolve with that
    req.once('response', function(res) {
      // Set response encoding
      res.setEncoding('utf8');

      // Buffer up chunks
      var chunks = [];
      res.on('data', function(chunk) {
        chunks.push(chunk);
      });

      // Reject on error
      res.once('error', reject);

      // Reject on aborted, if server aborts the request
      res.once('aborted', function() {
        var err = new Error('Request aborted by server');
        err.code = 'RequestAbortedError';
        reject(err);
      });

      // Resolve on request end
      res.once('end', function() {
        // Add payload property to response object
        res.payload = chunks.join('');

        // Validate content-length if one was provided
        // TODO - getBlobProperties returns content-length (the content length of the blob),but it does not have a payload!!

        var contentLength = res.headers['content-length'];
        // if (contentLength) {
        //   var length = Buffer.byteLength(res.payload, 'utf8');
        //   if (length !== parseInt(contentLength)) {
        //     var err = new Error('Content-Length mismatch');
        //     err.code = 'RequestContentLengthError';
        //     return reject(err);
        //   }
        // }

        resolve(res);
      });
    });

    // Send data with request
    req.end(data, 'utf-8');
  });
};

// Export request
exports.request = request;

/*
 * Convert Date object to JSON format without milliseconds
 *
 * @param {Date} date - Date object
 * @returns {string} ISO 8601 formatted string without milliseconds
 */
var dateToISOWithoutMS = function dateToISOWithoutMS(date) {
  return date.toJSON().replace(/\.\d+(?=Z$)/, '');
};

// Export dateToISOWithoutMS
exports.dateToISOWithoutMS = dateToISOWithoutMS;

/*
 * Parse JSON exactly like `JSON.parse(data)`, but wrap the error so that the
 * invalid JSON data is attached to the error as a property.
 *
 * @param {string} data - String data to parse as JSON
 * @returns {object} Resulting JSON object
 */
var parseJSON = function parseJSON(data) {
  try {
    return JSON.parse(data);
  } catch (err) {
    var e = new Error('Failed to parse JSON payload: ' + err.message);
    e.payload = data;
    throw e;
  }
}

// Export parseJSON
exports.parseJSON = parseJSON;

/**
 * Extracts the metadata from HTTP response header
 *
 * @param {object} response - HTTP response
 * @returns {object} Mapping from meta-data keys to values
 */
var extractMetadataFromHeaders = function extractMetadataFromHeaders(response) {
  var metadata = {};
  /*
   * Metadata names must adhere to the naming rules for C# identifiers, which are case-insensitive,
   * meaning that you can set,for example, a metadata with the following form:
   *   {
   *   applicationName: 'fast-azure-blob-storage'
   *   }
   * In order to return the original metadata name, the header names should be read from response.rawHeaders.
   * That is because 'https' library returns the response headers with lowercase.
   * The response.rawHeaders is a list that contains the raw header names and values. It is NOT a list of tuples.
   * So, the even-numbered offsets are key values, and the odd-numbered offsets are the associated values.
   */
  for(var i = 0; i < response.rawHeaders.length; i += 2) {
    var key = response.rawHeaders[i];
    if (/x-ms-meta-/.test(key)) {
      metadata[key.substr(10)] = response.headers[key.toLowerCase()];
    }
  }

  return metadata;
}

exports.extractMetadataFromHeaders = extractMetadataFromHeaders;

/**
 * Checks if the given value is a valid GUID
 *
 * A string that contains a GUID in one of the following formats (`d` represents a hexadecimal digit whose case is ignored):
 *
 * - 32 contiguous digits: dddddddddddddddddddddddddddddddd
 * - Groups of 8, 4, 4, 4, and 12 digits with hyphens between the groups
 *    dddddddd-dddd-dddd-dddd-dddddddddddd
 *  -or-
 *    {dddddddd-dddd-dddd-dddd-dddddddddddd}
 * -or-
 *    (dddddddd-dddd-dddd-dddd-dddddddddddd)
 * -Groups of 8, 4, and 4 digits, and a subset of eight groups of 2 digits, with each group prefixed by "0x" or "0X", and separated by commas.
 *    {0xdddddddd, 0xdddd, 0xdddd,{0xdd,0xdd,0xdd,0xdd,0xdd,0xdd,0xdd,0xdd}}
 *
 * @param {string} value - String value to be verified
 * @returns {boolean} True if the value is a valid GUID
 */
var isValidGUID = function isValidGUID(value) {
  // remove all embedded whitespaces
  value = value.replace(/\s/g, '');

  var patterns = [
    /^[0-9a-fA-F]{1,32}$/i,
    /^[0-9a-fA-F]{1,8}(-[0-9a-fA-F]{1,4}){3}-[0-9a-fA-F]{1,12}$/i,
    /^\{[0-9a-fA-F]{1,8}(-[0-9a-fA-F]{1,4}){3}-[0-9a-fA-F]{1,12}\}$/i,
    /^\([0-9a-fA-F]{1,8}(-[0-9a-fA-F]{1,4}){3}-[0-9a-fA-F]{1,12}\)$/i,
    /^\{0x[0-9a-fA-F]{1,8}(,0x[0-9a-fA-F]{1,4}){2},\{0x[0-9a-fA-F]{1,2}(,0x[0-9a-fA-F]{1,2}){7}\}\}$/i
  ];

  for (var x = 0 ; x < patterns.length ; x++) {
    if (patterns[x].test(value)) {
      return true;
    }
  }
  return false;
}

exports.isValidGUID = isValidGUID;

/**
 * Helper method to build the request options for Shared Key authentication.
 *
 * @param {object} options - Options on the form:
 * ```js
 * {
 *    accountId: '...',                 // Azure storage accountId (required)
 *    accessKey: '...',                 // Decoded Azure shared accessKey (required)
 *    agent: '...',                     // HTTP Agent to use  (required)
 *    hostname: '...',                  // The service hostname (required)
 *    hasCanonicalizedHeaders: false,   // Specify if the string to sign includes the canonicalized headers (optional)
 *    queryParamsSupported: '...'       // List of query-string parameter supported in lexicographical order, used for
 *                                      // construction of the canonicalized resource.
 *    headersValueToSign: '...'         // A string that includes all the headers value separated by a new line
 *                                      // that should be included in the string to sign. (for more details,
 *                                      // see the documentation of every service) (required)
 * }
 * ```
 * @param {string} method - HTTP verb in upper case, e.g. `GET`.
 * @param {string} path - Path on service resource for storage account.
 * @param {object} query - Query-string parameters.
 * @param {object} header - Mapping from header key in lowercase to value.
 *
 * @return {Promise} A promise for an options object compatible with `https.request`.
 */
var buildRequestOptionsForAuthSharedKey = function buildRequestOptionsForAuthSharedKey(options, method, path, query, headers) {
  // Find account id
  var accountId = options.accountId;

  // Build string to sign
  var stringToSign = (
    method + '\n' + options.headersValueToSign
  );

  // Construct fields as a sorted list of 'x-ms-' prefixed headers
  if (options.hasCanonicalizedHeaders) {
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
  }

  // Added lines from canonicalized resource and query-string parameters
  // supported by this library in lexicographical order as presorted in
  // options.queryParamsSupported
  stringToSign += '\n/' + accountId + path;
  var M = options.queryParamsSupported.length;
  for(var j = 0; j < M; j++) {
    var param = options.queryParamsSupported[j];
    var value = query[param];
    if (value) {
      stringToSign += '\n' + param + ':' + value;
    }
  }

  // Compute signature
  var signature = crypto
    .createHmac('sha256', options.accessKey)
    .update(stringToSign)
    .digest('base64');

  // Set authorization header
  headers.authorization = 'SharedKey ' + accountId + ':' + signature;

  // Encode query string
  var qs = querystring.stringify(query);

  // Construct request options
  return Promise.resolve({
    host:       options.hostname,
    method:     method,
    path:       (qs.length > 0 ? path + '?' + qs : path),
    headers:    headers,
    agent:      options.agent
  });
}

exports.buildRequestOptionsForAuthSharedKey = buildRequestOptionsForAuthSharedKey;

/**
 * Helper method to build the request options for Shared-Access-Signature authentication.
 *
 * @param {object} options - Options on the form:
 * ```js
 * {
 *    agent: '...',     // HTTP Agent to use  (required)
 *    hostname: '...',  // The service hostname (required)
 *    sas: '...'        // The Shared-Access-Signature string (required)
 * }
 * ```
 * @param {string} method - HTTP verb in upper case, e.g. `GET`.
 * @param {string} path - Path on service resource for storage account.
 * @param {object} query - Query-string parameters.
 * @param {object} header - Mapping from header key in lowercase to value.
 *
 * @return {Promise} A promise for an options object compatible with `https.request`.
 */
var buildRequestOptionsForSAS = function buildRequestOptionsForSAS(options, method, path, query, headers) {
  // Serialize query-string
  var qs = querystring.stringify(query);
  if (qs.length > 0) {
    qs += '&';
  }
  qs += options.sas;
  // Construct request optionss
  return Promise.resolve({
    host:       options.hostname,
    method:     method,
    path:       path + '?' + qs,
    headers:    headers,
    agent:      options.agent
  });
}

exports.buildRequestOptionsForSAS = buildRequestOptionsForSAS;

/**
 * Helper method to build the request options for Shared-Access-Signature authentication,
 * where the shared-access-signature is refreshed with a function given as `options.sas`
 *
 * @param serviceInstance - `this` service instance
 * @param method - HTTP verb in the upper case, e.g. `GET`
 * @param path - Path on service resource for storage account
 * @param query - Query-string parameters
 * @param headers - Mapping fro header key in lowercase to value
 *
 * @returns {Promise} A promise for an options object compatible with `https.request`
 */
var buildRequestOptionsForRefreshSAS = function buildRequestOptionsForRefreshSAS(serviceInstance, method, path, query, headers) {
  // Check if we should refresh SAS
  if (Date.now() > serviceInstance._nextSASRefresh && serviceInstance._nextSASRefresh !== 0) {
    debug("Refreshing shared-access-signature");
    // Avoid refreshing more than once
    serviceInstance._nextSASRefresh = 0;
    // Refresh SAS
    serviceInstance._sas = Promise.resolve(serviceInstance.options.sas());
    // Update _nextSASRefresh when the SAS has been refreshed
    serviceInstance._sas.then(function(sas) {
      sas = querystring.parse(sas);
      // Find next sas refresh time
      serviceInstance._nextSASRefresh = (
        new Date(sas.se).getTime() - serviceInstance.options.minSASAuthExpiry
      );
      debug("Refreshed shared-access-signature, will refresh in %s ms",
        serviceInstance._nextSASRefresh);
      // Throw an error if the signature expiration comes too soon
      if (Date.now() > serviceInstance._nextSASRefresh) {
        throw new Error("Refreshed SAS, but got a Shared-Access-Signature " +
          "that expires less than options.minSASAuthExpiry " +
          "from now, signature expiry: " + sas.se);
      }
    }).catch(function(err) {
      // If we have an error freshing SAS that's bad and we'll emit it; for most
      // apps it's probably best to ignore this error and just crash.
      serviceInstance.emit('error', err);
    });
  }

  // Construct request options, whenever the `_sas` promise is resolved.
  return serviceInstance._sas.then(function(sas) {
    var authOptions = {
      agent: serviceInstance.options.agent,
      hostname: serviceInstance.hostname,
      sas: sas
    };
    return buildRequestOptionsForSAS(authOptions, method, path, query, headers);
  });
}

exports.buildRequestOptionsForRefreshSAS = buildRequestOptionsForRefreshSAS;

/**
 * @param {object} conditionalHeaders - Conditional headers on the following form
 * ```js
 * {
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been modified since the specified date/time. (optional)
 *    ifMatch: '...',                   // ETag value. Specify this to perform the operation only if the resource's ETag matches the value specified. (optional)
 *    ifNoneMatch: '...'                // ETag value. Specify this to perform the operation only if the resource's ETag does not match the value specified. (optional)
 * }
 *```
 */
var setConditionalHeaders = function setConditionalHeaders(headers, conditionalHeaders) {
  if (conditionalHeaders) {
    if (conditionalHeaders.ifModifiedSince){
      assert(conditionalHeaders.ifModifiedSince instanceof Date,
        'If specified, the `options.ifModifiedSince` must be a Date');
      headers['if-modified-since'] = conditionalHeaders.ifModifiedSince.toUTCString();
    }
    if (conditionalHeaders.ifUnmodifiedSince) {
      assert(conditionalHeaders.ifUnmodifiedSince instanceof Date,
        'If specified, the `options.ifUnmodifiedSince` must be a Date');
      headers['if-unmodified-since'] = conditionalHeaders.ifUnmodifiedSince.toUTCString();
    }
    if (conditionalHeaders.ifMatch) headers['if-match'] = conditionalHeaders.ifMatch;
    if (conditionalHeaders.ifNoneMatch) headers['if-none-match'] = conditionalHeaders.ifNoneMatch;
  }
}

exports.setConditionalHeaders = setConditionalHeaders;