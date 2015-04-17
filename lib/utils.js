var Promise     = require('promise');
var https       = require('https');

/** Return promise to sleep for a `delay` ms */
var sleep = function(delay) {
  return new Promise(function(resolve) {
    setTimeout(resolve, delay);
  });
};

// Export sleep
exports.sleep = sleep;

/** Transient error codes from node https module */
var TRANSIENT_HTTP_ERROR_CODES = [
  'ETIMEDOUT',
  'ECONNRESET',
  'EADDRINUSE',
  'ESOCKETTIMEDOUT',
  'ECONNREFUSED'
];

// Export list of transient HTTP errors
exports.TRANSIENT_HTTP_ERROR_CODES = TRANSIENT_HTTP_ERROR_CODES;

/**
 * Retry the asynchronous function `tryOnce` until we have exhausted all
 * `retries`, succeed, or encounter an error code not in `transientErrorCodes`.
 * We sleep `Math.min(2 ^ retry * delayFactor, maxDelay)` between each retry.
 * Note, the `tryOnce` function must return a promise, and will be given the retry
 * count as first argument, zero for the first request which isn't a _retry_.
 *
 * Call with `options` as follows.
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
 * Warning, for performance reasons this method has no default options, nor does
 * it validate that all options are present. Acceptable because this is an
 * internal method.
 */
var retry = function retry(tryOnce, options) {
  var retry = 0;
  function attempt() {
    return tryOnce(retry).catch(function(err) {
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

/**
 * Auxiliary function to create `https.request` with `options` send `data` as
 * UTF-8 and buffer up the response as `payload` property on the response.
 *
 * Returns promise for the response object with `payload` property as string.
 */
var request = function(options, data) {
  return new Promise(function(resolve, reject) {
    // Create https request
    var req = https.request(options);

    // Reject promise
    req.once('error', reject);

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

      // Resolve on request end
      res.once('end', function() {
        // Add payload property to response object
        res.payload = chunks.join('');
        resolve(res);
      });
    });

    // Send data with request
    req.end(data, 'utf-8');
  });
};

// Export request
exports.request = request;

// Convert Date object to JSON format without milliseconds
var dateToISOWithoutMS = function(date) {
  return date.toJSON().replace(/\.\d+(?=Z$)/, '');
};

// Export dateToISOWithoutMS
exports.dateToISOWithoutMS = dateToISOWithoutMS;

