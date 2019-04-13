'use strict';

var https       = require('https');
var crypto      = require('crypto');
var querystring = require('querystring');
var debug       = require('debug')('azure:utils');
var assert      = require('assert');

/*
 * Return promise to sleep for a `delay` ms
 *
 * @param   {Number} delay - Number of ms to sleep.
 * @returns {Promise} A promise that will be resolved after `delay` ms
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
 *   // Randomization factor added as:
 *   // delay = delay * random([1 - randomizationFactor; 1 + randomizationFactor])
 *   randomizationFactor:   0.25,
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
      // Add 'fast-azure-storage' as module, so that errors can be traced
      err.module = 'fast-azure-storage';

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
      var delay = Math.pow(2, retry) * options.delayFactor;
      var rf = options.randomizationFactor;
      delay = delay * (Math.random() * 2 * rf + 1 - rf);
      delay = Math.min(delay, options.maxDelay);

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
        var contentLength = res.headers['content-length'];
        if (contentLength && options.method !== 'HEAD') {
          var length = Buffer.byteLength(res.payload, 'utf8');
          if (length !== parseInt(contentLength)) {
            var err = new Error('Content-Length mismatch');
            err.code = 'RequestContentLengthError';
            return reject(err);
          }
        }

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

/*
 * Extracts the metadata from HTTP response header
 *
 * @param {object} response - HTTP response
 * @returns {object} Mapping from meta-data keys to values
 */
var extractMetadataFromHeaders = function extractMetadataFromHeaders(response) {
  var metadata = {};
  /*
   * Metadata names must be valid C# identifiers and are case-insensitive, but case preserving,
   * meaning that you can set,for example, a metadata with the following form:
   *   {
   *     applicationName: 'fast-azure-blob-storage'
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

/*
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

/*
 * @param {object} headers - request headers
 * @param {object} conditionalHeaders - Conditional headers on the following form
 * ```js
 * {
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been modified since the specified date/time. (optional)
 *    ifMatch: '...',                   // ETag value. Specify this to perform the operation only if the resource's ETag matches the value specified. (optional)
 *    ifNoneMatch: '...'                // ETag value. Specify this to perform the operation only if the resource's ETag does not match the value specified. (optional)
 * }
 *```
 * @param {boolean} onlyDateSupport - true if the request supports only the if-modified-since and if-unmodified-since conditional headers
 */
var setConditionalHeaders = function setConditionalHeaders(headers, conditionalHeaders, onlyDateSupport) {
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
    if (!onlyDateSupport) {
      if (conditionalHeaders.ifMatch) headers['if-match'] = conditionalHeaders.ifMatch;
      if (conditionalHeaders.ifNoneMatch) headers['if-none-match'] = conditionalHeaders.ifNoneMatch;
    }
  }
}

exports.setConditionalHeaders = setConditionalHeaders;

/*
 * Computes a signature for the specified string using the HMAC-SHA256 algorithm.
 *
 * @param {string} accessKey - The access key
 * @param {string} stringToSign - The UTF-8-encoded string to sign.
 * @return A String that contains the HMAC-SHA256-encoded signature.
 */
var hmacSha256 = function hmacSha256(accessKey, stringToSign) {
  return crypto
    .createHmac('sha256', accessKey)
    .update(stringToSign)
    .digest('base64');
}

exports.hmacSha256 = hmacSha256;

/*
 * Calculate MD5sum for the content
 */
var md5 = function md5(content) {
  return crypto
    .createHash('md5')
    .update(content, 'utf8')
    .digest('base64');
}

exports.md5 = md5;
