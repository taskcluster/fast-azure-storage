'use strict';

var assert            = require('assert');
var crypto            = require('crypto');
var debug             = require('debug')('azure:blob');
var Promise           = require('promise');
var utils             = require('./utils');
var querystring       = require('querystring');
var xml               = require('./xml-parser');
var util              = require('util');
var events            = require('events');
var agent             = require('./agent');
var auth              = require('./authorization');

/*
 * Azure storage service version
 * @const
 */
var SERVICE_VERSION = '2016-05-31';

/*
 * The maximum size, in bytes, of a block blob that can be uploaded, before it must be separated into blocks.
 * @const
 */
var MAX_SINGLE_UPLOAD_BLOCK_BLOB_SIZE_IN_BYTES = 256 * 1024 * 1024;

/*
 * The maximum size of a single block.
 * @const
 */
var MAX_BLOCK_SIZE = 4 * 1024 * 1024;

/*
 * Page blob length.
 * @const
 */
var PAGE_SIZE = 512;

/*
 * The maximum size, in bytes, of a page blob.
 * @const
 */
var MAX_PAGE_SIZE = 1 * 1024 * 1024 * 1024;

/*
 * The maximum size of an append block.
 * @const
 */
var MAX_APPEND_BLOCK_SIZE = 4 * 1024 * 1024;

/* Transient error codes (we'll retry request when encountering these codes */
var TRANSIENT_ERROR_CODES = [
  // Azure error codes we should retry on according to azure docs
  'InternalError',
  'ServerBusy'
].concat(utils.TRANSIENT_HTTP_ERROR_CODES);

/*
 * List of query-string parameter supported in lexicographical order, used for
 * construction of the canonicalized resource.
 */
var QUERY_PARAMS_SUPPORTED = [
  'comp',
  'timeout',
  'restype',
  'prefix',
  'marker',
  'maxResults',
  'include',
  'delimiter',
  'blockid',
  'blocklisttype'
].sort();

function anonymous(method, path, query, headers) {
  // Serialize query-string
  var qs = querystring.stringify(query);
  if (qs.length > 0) {
    qs += '&';
  }
  return Promise.resolve({
    host:       this.hostname,
    method:     method,
    path:       path + '?' + qs,
    headers:    headers,
    agent:      this.options.agent
  });
}

/**
 * Blob client class for interacting with Azure Blob Storage.
 *
 * @class Blob
 * @constructor
 * @param {object} options - options on the form:
 *
 * ```js
 * {
 *   // Value for the x-ms-version header fixing the API version
 *   version:              SERVICE_VERSION,
 *
 *   // Value for the x-ms-client-request-id header identifying the client
 *   clientId:             'fast-azure-storage',
 *
 *   // Server-side request timeout
 *   timeout:              30 * 1000,
 *
 *   // Delay between client- and server-side timeout
 *   clientTimeoutDelay:   500,
 *
 *   // Max number of request retries
 *   retries:              5,
 *
 *    // HTTP Agent to use (defaults to a global azure.Agent instance)
 *   agent:                azure.Agent.globalAgent,
 *
 *   // Multiplier for computation of retry delay: 2 ^ retry * delayFactor
 *   delayFactor:          100,
 *
 *   // Randomization factor added as:
 *   // delay = delay * random([1 - randomizationFactor; 1 + randomizationFactor])
 *   randomizationFactor:  0.25,
 *
 *   // Maximum retry delay in ms (defaults to 30 seconds)
 *   maxDelay:             30 * 1000,
 *
 *   // Error codes for which we should retry
 *   transientErrorCodes:  TRANSIENT_ERROR_CODES,
 *
 *   // Azure storage accountId (required)
 *   accountId:            undefined,
 *
 *   // Azure shared accessKey, required unless options.sas is given
 *   accessKey:            undefined,
 *
 *   // Function that returns SAS string or promise for SAS string, in which
 *   // case we will refresh SAS when a request occurs less than
 *   // minSASAuthExpiry from signature expiry. This property may also be a
 *   // SAS string.
 *   sas:                  undefined,
 *
 *   // Minimum SAS expiry before refreshing SAS credentials, if a function for
 *   // refreshing SAS credentials is given as options.sas
 *   minSASAuthExpiry:     15 * 60 * 1000
 * }
 * ```
 */
function Blob(options) {
  // Initialize EventEmitter parent class
  events.EventEmitter.call(this);
  // Set default options
  this.options = {
    version:              SERVICE_VERSION,
    clientId:             'fast-azure-storage',
    timeout:              30 * 1000,
    clientTimeoutDelay:   500,
    agent:                agent.globalAgent,
    retries:              5,
    delayFactor:          100,
    maxDelay:             30 * 1000,
    transientErrorCodes:  TRANSIENT_ERROR_CODES,
    accountId:            undefined,
    accessKey:            undefined,
    sas:                  undefined,
    minSASAuthExpiry:     15 * 60 * 1000,
  };

  // Overwrite default options
  for (var key in options) {
    if (options.hasOwnProperty(key) && options[key] !== undefined) {
      this.options[key] = options[key];
    }
  }

  // Validate options
  assert(this.options.accountId, "`options.accountId` must be given");

  // Construct hostname
  this.hostname = this.options.accountId + '.blob.core.windows.net';

  // Compute `timeout` for client-side timeout (in ms), and `timeoutInSeconds`
  // for server-side timeout in seconds.
  this.timeout = this.options.timeout + this.options.clientTimeoutDelay;
  this.timeoutInSeconds = Math.floor(this.options.timeout / 1000);

  // Define `this.authorize`
  if (this.options.accessKey) {
    // If set authorize to use shared key signatures
    this.authorize = auth.authorizeWithSharedKey.call(this, 'blob', QUERY_PARAMS_SUPPORTED);

    // Decode accessKey
    this._accessKey = new Buffer(this.options.accessKey, 'base64');
  } else if (this.options.sas instanceof Function) {
    // Set authorize to use shared-access-signatures with refresh function
    this.authorize = auth.authorizeWithRefreshSAS;
    // Set state with _nextSASRefresh = -1, we'll refresh on the first request
    this._nextSASRefresh = -1;
    this._sas = '';
  } else if (typeof(this.options.sas) === 'string') {
    // Set authorize to use shared-access-signature as hardcoded
    this.authorize = auth.authorizeWithSAS;
  } else {
    this.authorize = anonymous;
  }
};

// Export Blob
module.exports = Blob;

// Subclass EventEmitter
util.inherits(Blob, events.EventEmitter);

/**
 * Generate a SAS string on the form 'key1=va1&key2=val2&...'.
 *
 * @method sas
 * @param {string}  container - Name of the container that this SAS string applies to.
 * @param {string}  blob - Name of the blob that this SAS string applies to.
 * @param {object} options - Options for the following form:
 *```js
 * {
 *   start:               new Date(),             // Time from which signature is valid (optional)
 *   expiry:              new Date(),             // Expiration of signature (required).
 *   resourceType:        'blob|container',       // Specifies which resources are accessible via the SAS(required)
 *                                                // Possible values are: 'blob' or 'container'.
 *                                                // Specify 'blob' if the shared resource is a 'blob'.
 *                                                // This grants access to the content and metadata of the blob.
 *                                                // Specify 'container' if the shared resource is a 'container'.
 *                                                // This grants access to the content and metadata of any
 *                                                // blob in the container, and to the list of blobs in
 *                                                // the container.
 *   permissions: {                               // Set of permissions delegated (required)
 *                                                // It must be omitted if it has been specified in the associated
 *                                                // stored access policy.
 *     read:              false,                  // Read the content, properties, metadata or block list of a blob
 *                                                // or of any blob in the container if the resourceType is
 *                                                // a container.
 *     add:               false,                  // Add a block to an append blob or to any append blob if the
 *                                                // resourceType is a container.
 *     create:            false,                  // Write a new blob, snapshot a blob, or copy a blob
 *                                                // to a new blob.
 *                                                // These operations can be done to any blob in the container
 *                                                // if the resourceType is a container.
 *     write:             false,                  // Create or write content, properties, metadata, or block list.
 *                                                // Snapshot or lease the blob. Resize the blob (page blob only).
 *                                                // These operations can be done for every blob in the container
 *                                                // if the resourceType is a container.
 *     delete:            false,                  // Delete the blob or any blob in the container if the
 *                                                // resourceType is a container.
 *     list:              false,                  // List blobs in the container.
 *   },
 *   cacheControl:        '...',                  // The value of the Cache-Control response header
 *                                                // to be returned. (optional)
 *   contentDisposition:  '...',                  // The value of the Content-Disposition response header
 *                                                // to be returned. (optional)
 *   contentEncoding:     '...',                  // The value of the Content-Encoding response header
 *                                                // to be returned. (optional)
 *   contentLanguage:     '...',                  // The value of the Content-Language response header
 *                                                // to be returned. (optional)
 *   contentType:         '...',                  // The value of the Content-Type response header to
 *                                                // be returned. (optional)
 *   accessPolicy:        '...'                   // Reference to stored access policy (optional)
 *                                                // A GUID string
 * }
 * ```
 * @returns {string} Shared-Access-Signature on string form.
 *
 */
Blob.prototype.sas = function sas(container, blob, options){
  // verify the required options
  assert(options, "options is required");
  assert(options.expiry instanceof Date,
    "options.expiry must be a Date object");
  assert(options.resourceType, 'options.resourceType is required');
  assert(options.resourceType === 'blob' || options.resourceType === 'container',
    'The possible values for options.resourceType are `blob` or `container`');
  assert(options.permissions || options.accessPolicy, "options.permissions or options.accessPolicy must be specified");
  if (options.resourceType === 'container' && blob){
    throw new Error('If `options.resourceType` is container, the blob cannot be specified.');
  }

  // Check that we have credentials
  if (!this.options.accountId ||
    !this.options.accessKey) {
    throw new Error("accountId and accessKey are required for SAS creation!");
  }

  // Construct query-string with required parameters
  var query = {
    sv:   SERVICE_VERSION,
    se:   utils.dateToISOWithoutMS(options.expiry),
    sr:   options.resourceType === 'blob' ? 'b' : 'c',
    spr:  'https'
  }

  if (options.permissions){
    if (options.permissions.list && options.resourceType === 'blob') {
      throw new Error('The permission `list` is forbidden for the blob resource type.');
    }
    // Construct permissions string (in correct order)
    var permissions = '';
    if (options.permissions.read)    permissions += 'r';
    if (options.permissions.add)     permissions += 'a';
    if (options.permissions.create)  permissions += 'c';
    if (options.permissions.write)   permissions += 'w';
    if (options.permissions.delete)  permissions += 'd';
    if (options.permissions.list && options.resourceType === 'container') permissions += 'l';

    query.sp = permissions;
  }

  // Add optional parameters to query-string
  if (options.cacheControl)       query.rscc = options.cacheControl;
  if (options.contentDisposition) query.rscd = options.contentDisposition;
  if (options.contentEncoding)    query.rsce = options.contentEncoding;
  if (options.contentLanguage)    query.rscl = options.contentLanguage;
  if (options.contentType)        query.rsct = options.contentType;

  if (options.start) {
    assert(options.start instanceof Date, "if specified start must be a Date object");
    query.st = utils.dateToISOWithoutMS(options.start);
  }

  if (options.accessPolicy) {
    assert(/^[0-9a-fA-F]{1,64}$/i.test(options.accessPolicy), 'The `options.accessPolicy` is not valid.' );
    query.si = options.accessPolicy;
  }

  // Construct string-to-sign
  var canonicalizedResource = '/blob/' + this.options.accountId.toLowerCase() + '/' + container;
  if (blob){
    canonicalizedResource += '/' + blob;
  }
  var stringToSign = [
    query.sp || '',
    query.st || '',
    query.se || '',
    canonicalizedResource,
    query.si  || '',
    '', // TODO: Support signed IP addresses
    query.spr,
    query.sv,
    query.rscc || '',
    query.rscd || '',
    query.rsce || '',
    query.rscl || '',
    query.rsct || ''
  ].join('\n');

  // Compute signature
  query.sig = utils.hmacSha256(this._accessKey, stringToSign);

  // Return Shared-Access-Signature as query-string
  return querystring.stringify(query);
};

/**
 * Construct authorized request options by adding signature or
 * shared-access-signature, return promise for the request options.
 *
 * @protected
 * @method authorize
 * @param {string} method - HTTP verb in upper case, e.g. `GET`.
 * @param {string} path - Path on blob resource for storage account.
 * @param {object} query - Query-string parameters.
 * @param {object} header - Mapping from header key in lowercase to value.
 * @returns {Promise} A promise for an options object compatible with
 * `https.request`.
 */
Blob.prototype.authorize = function(method, path, query, headers) {
  throw new Error("authorize is not implemented, must be defined!");
};

/**
 * Make a signed request to `path` using `method` in upper-case and all `query`
 * parameters and `headers` keys in lower-case. The request will carry `data`
 * as payload and will be retried using the configured retry policy,
 *
 * @private
 * @method request
 * @param {string} method - HTTP verb in upper case, e.g. `GET`.
 * @param {string} path - Path on blob resource for storage account.
 * @param {object} query - Query-string parameters.
 * @param {object} header - Mapping from header key in lowercase to value.
 * @return {Promise} A promise for HTTPS response with `payload` property as
 * string containing the response payload.
 */
Blob.prototype.request = function request(method, path, query, headers, data) {
  // Set timeout, if not provided
  if (query.timeout === undefined) {
    query.timeout = this.timeoutInSeconds;
  }

  // Set date, version and client-request-id headers
  headers['x-ms-date']              = new Date().toUTCString();
  headers['x-ms-version']           = this.options.version;
  headers['x-ms-client-request-id'] = this.options.clientId;

  // Set content-length, if data is given
  if (data && data.length > 0 && !headers['content-length']) {
    headers['content-length'] = Buffer.byteLength(data, 'utf-8');
  }

  // Construct authorized request options with shared key signature or
  // shared-access-signature.
  var self = this;
  return this.authorize(method, path, query, headers).then(function(options) {
    // Retry with retry policy
    return utils.retry(function(retry) {
      debug("Request: %s %s, retry: %s", method, path, retry);

      // Construct a promise chain first handling the request, and then parsing
      // any potential error message
      return utils.request(options, data, self.timeout).then(function(res) {
        // Accept the response if it's 2xx, otherwise we construct and
        // throw an error
        if (200 <= res.statusCode && res.statusCode < 300) {
          return res;
        }

        // Parse error message
        var data = xml.parseError(res);

        // Construct error object
        var err         = new Error(data.message);
        err.name        = data.code + 'Error';
        err.code        = data.code;
        err.statusCode  = res.statusCode;
        err.message     = data.message;
        err.retries     = retry;

        debug("Error code: %s (%s) for %s %s on retry: %s",
              data.code, res.statusCode, method, path, retry);

        // Throw the constructed error
        throw err;
      });
    }, self.options);
  });
};

/**
 * Sets properties for a storage account’s Blob service endpoint
 *
 * @method setServiceProperties
 * @param {object} options - Options on the following form:
 * ```js
 * {
 *    logging: {                 // The Azure Analytics Logging settings.
 *      version: '...',          // The version of Storage Analytics to configure (required if logging specified)
 *      delete: true|false,      // Indicates whether all delete requests should be logged
 *                               // (required if logging specified)
 *      read: true|false,        // Indicates whether all read requests should be logged
 *                               // (required if logging specified)
 *      write: true|false,       // Indicates whether all write requests should be logged
 *                               // (required if logging specified)
 *      retentionPolicy: {
 *        enabled: true|false,   // Indicates whether a retention policy is enabled for the
 *                               // storage service. (required)
 *        days: '...',           // Indicates the number of days that metrics or logging data should be retained.
 *                               // Required only if a retention policy is enabled.
 *      },
 *    },
 *    hourMetrics: {             // The Azure Analytics HourMetrics settings
 *      version: '...',          // The version of Storage Analytics to configure
 *                               // (required if hourMetrics specified)
 *      enabled: true|false,     // Indicates whether metrics are enabled for the Blob service
 *                               //(required if hourMetrics specified).
 *      includeAPIs: true|false, // Indicates whether metrics should generate summary statistics for called API
 *                               // operations (Required only if metrics are enabled).
 *      retentionPolicy: {
 *        enabled: true|false,
 *        days: '...',
 *      },
 *    },
 *    minuteMetrics: {           // The Azure Analytics MinuteMetrics settings
 *      version: '...',          // The version of Storage Analytics to configure
 *                               // (required if minuteMetrics specified)
 *      enabled: true|false,     // Indicates whether metrics are enabled for the Blob service
 *                               // (required if minuteMetrics specified).
 *      includeAPIs: true|false, // Indicates whether metrics should generate summary statistics for called API
 *                               // operations (Required only if metrics are enabled).
 *      retentionPolicy: {
 *        enabled: true|false,
 *        days: '...',
 *      },
 *    },
 *    corsRules: [{              // CORS rules
 *      allowedOrigins: [],      // A list of origin domains that will be allowed via CORS,
 *                               // or "*" to allow all domains
 *      allowedMethods: [],      // List of HTTP methods that are allowed to be executed by the origin
 *      maxAgeInSeconds: [],     // The number of seconds that the client/browser should cache a
 *                               // preflight response
 *      exposedHeaders: [],      // List of response headers to expose to CORS clients
 *      allowedHeaders: [],      // List of headers allowed to be part of the cross-origin request
 *    }]
 * }
 * ```
 * @return {Promise} A promise that the properties have been set
 */
Blob.prototype.setServiceProperties = function setServiceProperties(options) {

  var payload = '<?xml version="1.0" encoding="utf-8"?>';
  payload += '<StorageServiceProperties>';

  if (options) {
    if (options.logging) {
      payload += '<Logging>';
      var logging = options.logging;
      assert(logging.version, 'The `options.logging.version` must be supplied if `options.logging` is specified');
      payload += '<Version>' + logging.version + '</Version>';

      assert(logging.delete, 'The `options.logging.delete` must be supplied if `options.logging` is specified');
      payload += '<Delete>' + logging.delete + '</Delete>';

      assert(logging.read, 'The `options.logging.read` must be supplied if `options.logging` is specified');
      payload += '<Read>' + logging.read + '</Read>';

      assert(logging.write, 'The `options.logging.write` must be supplied if `options.logging` is specified');
      payload += '<Write>' + logging.write + '</Write>';

      assert(logging.retentionPolicy, 'The `options.logging.retentionPolicy` must be supplied if `options.logging` is specified');
      payload += '<RetentionPolicy>';
      assert(logging.retentionPolicy.enabled, 'The `options.logging.retentionPolicy.enabled` must be supplied if `options.logging` is specified');
      payload += '<Enabled>' + logging.retentionPolicy.enabled + '</Enabled>';
      if (logging.retentionPolicy.enabled === true) {
        assert(logging.retentionPolicy.days, 'The `options.logging.retentionPolicy.days` must be supplied if a retention policy is enabled');
        assert(logging.retentionPolicy.days > 1 && logging.retentionPolicy.days < 365,
          'The `options.logging.retentionPolicy.days` must be a number between 1 and 365.');
        payload += '<Days>' + logging.retentionPolicy.days + '</Days>';
      }
      payload += '</RetentionPolicy>';

      payload += '</Logging>';
    }

    if(options.hourMetrics) {
      payload += '<HourMetrics>';
      var hourMetrics = options.hourMetrics;

      assert(hourMetrics.version, 'The `options.hourMetrics.version` must be supplied if `options.hourMetrics` is specified');
      payload += '<Version>' + hourMetrics.version + '</Version>';

      if (hourMetrics.enabled === undefined || hourMetrics.enabled === null) {
        throw new Error('The `options.hourMetrics.enabled` must be supplied if `options.hourMetrics` is specified');
      }
      payload += '<Enabled>' + hourMetrics.enabled + '</Enabled>';

      if (hourMetrics.enabled === true) {
        if (hourMetrics.includeAPIs === undefined || hourMetrics.includeAPIs === null) {
          throw new Error('The `options.hourMetrics.includeAPIs` must be supplied if `options.hourMetrics` is specified');
        }
        payload += '<IncludeAPIs>' + hourMetrics.includeAPIs + '</IncludeAPIs>';
      }

      assert(hourMetrics.retentionPolicy, 'The `options.hourMetrics.retentionPolicy` must be supplied if `options.hourMetrics` is specified');
      payload += '<RetentionPolicy>';
      if (hourMetrics.retentionPolicy.enabled === undefined || hourMetrics.retentionPolicy.enabled === null) {
        throw new Error('The `options.hourMetrics.retentionPolicy.enabled` must be supplied if `options.hourMetrics` is specified');
      }
      payload += '<Enabled>' + hourMetrics.retentionPolicy.enabled + '</Enabled>';
      if (hourMetrics.retentionPolicy.enabled === true) {
        assert(hourMetrics.retentionPolicy.days, 'The `options.hourMetrics.retentionPolicy.days` must be supplied if a retention policy is enabled');
        assert(hourMetrics.retentionPolicy.days > 1 && hourMetrics.retentionPolicy.days < 365,
          'The `options.hourMetrics.retentionPolicy.days` must be a number between 1 and 365.');
        payload += '<Days>' + hourMetrics.retentionPolicy.days + '</Days>';
      }
      payload += '</RetentionPolicy>';

      payload += '</HourMetrics>';
    }

    if(options.minuteMetrics) {
      payload += '<MinuteMetrics>';
      var minuteMetrics = options.minuteMetrics;

      assert(minuteMetrics.version, 'The `options.minuteMetrics.version` must be supplied if `options.minuteMetrics` is specified');
      payload += '<Version>' + minuteMetrics.version + '</Version>';

      if (minuteMetrics.enabled === undefined || minuteMetrics.enabled === null) {
        throw new Error('The `options.minuteMetrics.enabled` must be supplied if `options.minuteMetrics` is specified');
      }
      payload += '<Enabled>' + minuteMetrics.enabled + '</Enabled>';

      if (minuteMetrics.enabled === true) {
        if (minuteMetrics.includeAPIs === undefined || minuteMetrics.includeAPIs === null) {
          throw new Error('The `options.minuteMetrics.includeAPIs` must be supplied if `options.minuteMetrics` is specified');
        }
        payload += '<IncludeAPIs>' + minuteMetrics.includeAPIs + '</IncludeAPIs>';
      }

      assert(minuteMetrics.retentionPolicy, 'The `options.minuteMetrics.retentionPolicy` must be supplied if `options.minuteMetrics` is specified');
      payload += '<RetentionPolicy>';
      if (minuteMetrics.retentionPolicy.enabled === undefined || minuteMetrics.retentionPolicy.enabled === null) {
        throw new Error('The `options.minuteMetrics.retentionPolicy.enabled` must be supplied if `options.minuteMetrics` is specified');
      }
      payload += '<Enabled>' + minuteMetrics.retentionPolicy.enabled + '</Enabled>';
      if (minuteMetrics.retentionPolicy.enabled === true) {
        assert(minuteMetrics.retentionPolicy.days, 'The `options.minuteMetrics.retentionPolicy.days` must be supplied if a retention policy is enabled');
        assert(minuteMetrics.retentionPolicy.days >= 1 && minuteMetrics.retentionPolicy.days <= 365,
          'The `options.minuteMetrics.retentionPolicy.days` must be a number between 1 and 365.');
        payload += '<Days>' + minuteMetrics.retentionPolicy.days + '</Days>';
      }
      payload += '</RetentionPolicy>';

      payload += '</MinuteMetrics>';
    }

    if(options.corsRules) {
      payload += '<Cors>';
      options.corsRules.forEach(function(rule) {
        payload += '<CorsRule>';

        assert(rule.allowedOrigins, 'For CORS rule, the allowedOrigins must be specified');
        payload += '<AllowedOrigins>' + rule.allowedOrigins.join(',') + '</AllowedOrigins>';

        assert(rule.allowedMethods, 'For CORS rule, the allowedMethods must be specified');
        payload += '<AllowedMethods>' + rule.allowedMethods.join(',') + '</AllowedMethods>';

        assert(rule.maxAgeInSeconds, 'For CORS rule, the maxAgeInSeconds must be specified');
        if (rule.maxAgeInSeconds) payload += '<MaxAgeInSeconds>' + rule.maxAgeInSeconds + '</MaxAgeInSeconds>';

        assert(rule.exposedHeaders, 'For CORS rule, the exposedHeaders must be specified');
        if (rule.exposedHeaders) payload += '<ExposedHeaders>' + rule.exposedHeaders.join(',') + '</ExposedHeaders>';

        assert(rule.allowedHeaders, 'For CORS rule, the allowedHeaders must be specified');
        if (rule.allowedHeaders) payload += '<AllowedHeaders>' + rule.allowedHeaders.join(',') + '</AllowedHeaders>';

        payload += '</CorsRule>';
      });
      payload += '</Cors>';
    }
  }
  payload += '</StorageServiceProperties>';

  var query = {
    restype: 'service',
    comp: 'properties'
  };

  return this.request('PUT', '/', query, {}, payload).then(function(response) {
    if (response.statusCode !== 202) {
      throw new Error("setServiceProperties: Unexpected statusCode: " + response.statusCode);
    }
  });
};

/**
 * Gets the properties of a storage account’s Blob service, including properties for Storage Analytics and
 * CORS (Cross-Origin Resource Sharing) rules.
 *
 * @method getServiceProperties
 * @return {Promise} A promise for an object on the form:
 * ```js
 * {
 *    logging: {                  // The Azure Analytics Logging settings.
 *      version: '...',           // The version of Storage Analytics to configure
 *      delete: true|false,       // Indicates whether all delete requests should be logged
 *      read: true|false,         // Indicates whether all read requests should be logged
 *      write: true|false,        // Indicates whether all write requests should be logged
 *      retentionPolicy: {
 *        enabled: true|false,    // Indicates whether a retention policy is enabled for the storage service
 *        days: '...',            // Indicates the number of days that metrics or logging data should be retained.
 *      },
 *    },
 *    hourMetrics: {              // The Azure Analytics HourMetrics settings
 *      version: '...',           // The version of Storage Analytics to configure
 *      enabled: true|false,      // Indicates whether metrics are enabled for the Blob service
 *      includeAPIs: true|false,  // Indicates whether metrics should generate summary statistics
 *                                // for called API operations.
 *      retentionPolicy: {
 *        enabled: true|false,
 *        days: '...',
 *      },
 *    },
 *    minuteMetrics: {            // The Azure Analytics MinuteMetrics settings
 *      version: '...',           // The version of Storage Analytics to configure
 *      enabled: true|false,      // Indicates whether metrics are enabled for the Blob service
 *      includeAPIs: true|false,  // Indicates whether metrics should generate summary statistics
 *                                // for called API operations.
 *      retentionPolicy: {
 *        enabled: true|false,
 *        days: '...',
 *      },
 *    },
 *    corsRules: [{               // CORS rules
 *      allowedOrigins: [],       // A list of origin domains that will be allowed via CORS,
 *                                // or "*" to allow all domains.
 *      allowedMethods: [],       // List of HTTP methods that are allowed to be executed by the origin
 *      maxAgeInSeconds: [],      // The number of seconds that the client/browser should cache a preflight response
 *      exposedHeaders: [],       // List of response headers to expose to CORS clients
 *      allowedHeaders: [],       // List of headers allowed to be part of the cross-origin request
 *    }]
 * }
 * ```
 */
Blob.prototype.getSeviceProperties = function getSeviceProperties() {
  var query = {
    restype: 'service',
    comp: 'properties'
  };
  return this.request('GET', '/', query, {}).then(function(response) {
    if (response.statusCode !== 200) {
      throw new Error("setServiceProperties: Unexpected statusCode: " + response.statusCode);
    }

    return xml.blobParseServiceProperties(response);
  });
};

/**
 * Create a new container with the given 'name' under the storage account.
 *
 * @method createContainer
 * @param {string} name -  Name of the container to create
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    metadata: '...',          // Mapping from metadata keys to values. (optional)
 *    publicAccessLevel: '...', // Specifies whether data in the container may be accessed
 *                              // publicly and the level of access.
 *                              // Possible values: container, blob. (optional)
 * }
 * ```
 * @returns {Promise} a promise for metadata key/value pair
 * A promise for an object on the form:
 * ```js
 * {
 *      eTag: '...',               // The entity tag of the container
 *      lastModified: '...',       // The date/time the container was last modified
 * }
 * ```
 */
Blob.prototype.createContainer = function createContainer(name, options) {
  assert(typeof name === 'string', 'The name of the container must be specified and must be a string value.');
  // Construct headers
  var headers = {};
  if (options){
    if (options.metadata) {
      for(var key in options.metadata) {
        if (options.metadata.hasOwnProperty(key)) {
          headers['x-ms-meta-' + key] = options.metadata[key];
        }
      }
    }
    if(options.publicAccessLevel) {
      assert( options.publicAccessLevel === 'container' || options.publicAccessLevel === 'blob',
        'The `publicAccessLevel` is invalid. The possible values are: container and blob.'
      )
      headers['x-ms-blob-public-access'] = options.publicAccessLevel;
    }
  }

  // Construct query string
  var query = {
    restype: 'container'
  };
  var path = '/' + name;
  return this.request('PUT', path, query, headers).then(function(response) {
    // container was created - response code 201
    if (response.statusCode !== 201) {
      throw new Error("createContainer: Unexpected statusCode: " + response.statusCode);
    }

    return {
      eTag: response.headers['etag'],
      lastModified: new Date(response.headers['last-modified'])
    };
  });
};

/**
 * Sets metadata for the specified container.
 * Overwrites all existing metadata that is associated with the container.
 *
 * @method setContainerMetadata
 * @param {string} name - Name of the container to set metadata on
 * @param {object} metadata - Mapping from metadata keys to values.
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    leaseId: '...',               // Lease unique identifier. A GUID string.(optional)
 *    ifModifiedSince: new Date(),  // Specify this to perform the operation only if the resource has been
 *                                  // modified since the specified time. (optional)
 * }
 *```
 * @returns {Promise} a promise for metadata key/value pair
 * A promise for an object on the form:
 * ```js
 * {
 *      eTag: '...',               // The entity tag of the container
 *      lastModified: '...',       // The date/time the container was last modified
 * }
 * ```
 */
Blob.prototype.setContainerMetadata = function setContainerMetadata(name, metadata, options) {
  assert(typeof name === 'string', 'The name of the container must be specified and must be a string value.');
  // Construct query string
  var query = {
    restype: 'container',
    comp: 'metadata'
  };
  // Construct headers
  var headers = {};
  if (options) {
    if (options.leaseId) {
      assert(utils.isValidGUID(options.leaseId), '`leaseId` is not a valid GUID.');
      headers['x-ms-lease-id'] = options.leaseId;
    }
    // set conditional header
    if (options.ifModifiedSince){
      assert(options.ifModifiedSince instanceof Date,
        'If specified, the `options.ifModifiedSince` must be a Date');
      headers['if-modified-since'] = options.ifModifiedSince.toUTCString();
    }
  }

  for(var key in metadata) {
    if (metadata.hasOwnProperty(key)) {
      headers['x-ms-meta-' + key] = metadata[key];
    }
  }
  var path = "/" + name;
  return this.request('PUT', path, query, headers).then(function(response) {
    if(response.statusCode !== 200) {
      throw new Error('setContainerMetadata: Unexpected statusCode: ' + response.statusCode);
    }
    return {
      eTag: response.headers['etag'],
      lastModified: new Date(response.headers['last-modified'])
    }
  });
};

/**
 * Get the metadata for the container with the given name.
 *
 * Note, this is a `HEAD` request, so if the container is missing you get an
 * error with `err.statusCode = 404`, but `err.code` property will be
 * `ErrorWithoutCode`.
 *
 * @method getContainerMetadata
 * @param {string} name - the name of the container to get metadata from.
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    leaseId: '...'  // Lease unique identifier. A GUID string.(optional)
 * }
 * @returns {Promise} a promise for metadata key/value pair
 * A promise for an object on the form:
 * ```js
 * {
 *      eTag: '...',               // The entity tag of the container
 *      lastModified: '...',       // The date/time the container was last modified
 * }
 * ```
 */
Blob.prototype.getContainerMetadata = function getContainerMetadata(name, options) {
  assert(typeof name === 'string', 'The name of the container must be specified and must be a string value.');
  // Construct the query string
  var query = {
    comp: 'metadata',
    restype: 'container'
  }
  var path = "/" + name;
  var headers = {};
  if (options && options.leaseId) {
    assert(utils.isValidGUID(options.leaseId), '`leaseId` is not a valid GUID.');
    headers['x-ms-lease-id'] = options.leaseId;
  }

  return this.request('HEAD', path, query, headers).then(function(response) {
    if (response.statusCode !== 200) {
      throw new Error("getContainerMetadata: Unexpected statusCode: " + response.statusCode);
    }
    return {
      eTag: response.headers['etag'],
      lastModified: new Date(response.headers['last-modified']),
      metadata: utils.extractMetadataFromHeaders(response)
    }
  });
};

/**
 * Delete container with the given 'name'.
 *
 * Note, when a container is deleted, a container with the same name cannot be created for at least 30 seconds;
 * the container may not be available for more than 30 seconds if the service is still processing the request.
 * Please see the documentation for more details.
 *
 * @method deleteContainer
 * @param {string} name -  Name of the container to delete
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    leaseId: '...',                   // Lease unique identifier. A GUID string.(optional)
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has
 *                                      // been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has
 *                                      // not been modified since the specified date/time. (optional)
 * }
 *```
 * @returns {Promise} A promise that container has been marked for deletion.
 */
Blob.prototype.deleteContainer = function deleteContainer(name, options) {
  assert(typeof name === 'string', 'The name of the container must be specified and must be a string value.');
  // construct query string
  var query = {
    restype: 'container'
  };
  var path = '/' + name;
  var headers = {};
  if (options) {
    if (options.leaseId) {
      assert(utils.isValidGUID(options.leaseId), '`leaseId` is not a valid GUID.');
      headers['x-ms-lease-id'] = options.leaseId;
    }

    utils.setConditionalHeaders(headers, options, true);
  }

  return this.request('DELETE', path, query, headers).then(function(response) {
    if(response.statusCode !== 202) {
      throw new Error('deleteContainer: Unexpected statusCode: ' + response.statusCode);
    }
  });
};

/**
 * List the containers under the storage account
 *
 * @method listContainers
 * @param {object} options - Options on the following form:
 *
 * ```js
 * {
 *   prefix:          '...',    // Prefix of containers to list
 *   marker:          '...',    // Marker to list containers from
 *   maxResults:      5000,     // Max number of results
 *   metadata:        false     // Whether or not to include metadata
 * }
 *
 * @returns {Promise} A promise for an object on the form:
 * ```js
 * {
 *   containers: [
 *     {
 *       name:       '...',           // Name of container
 *       properties: {
 *          lastModified: '...',      // Container's last modified time
 *          eTag: '...',              // The entity tag of the container
 *          leaseStatus: '...',       // The lease status of the container
 *          leaseState: '...',        // The lease state of the container
 *          leaseDuration: '...'      // The lease duration of the container
 *          publicAccessLevel: '...'  // Indicates whether data in the container may be accessed publicly
 *                                    // and the level of access. If this is not returned in the response,
 *                                    // the container is private to the account owner.
 *       }
 *       metadata:   {}               // Meta-data dictionary if requested
 *     }
 *   ],
 *   prefix:         '...',           // prefix given in options (if given)
 *   marker:         '...',           // marker given in options (if given)
 *   maxResults:     5000,            // maxResults given in options (if given)
 *   nextMarker:     '...'            // Next marker if not at end of list
 * }
 * ```
 */
Blob.prototype.listContainers = function listContainers(options) {
  // Ensure options
  options = options || {};

  // Construct query string
  var query = {
    comp: 'list'
  };
  if (options.prefix)     query.prefix      = options.prefix;
  if (options.marker)     query.marker      = options.marker;
  if (options.maxResults) query.maxresults  = options.maxResults;
  if (options.metadata)   query.include     = 'metadata';

  return this.request('GET', '/', query, {}).then(function(response) {
    if(response.statusCode !== 200) {
      throw new Error('listContainers: Unexpected statusCode: ' + response.statusCode);
    }
    return xml.blobParseListContainers(response);
  });
};

/**
 * Get all user-defined metadata and system properties for the container with the given name.
 *
 * Note, this is a `HEAD` request, so if the container is missing you get an
 * error with `err.statusCode = 404`, but `err.code` property will be
 * `ErrorWithoutCode`.
 *
 * @method getContainerProperties
 * @param {string} name - The name of the container to get properties from.
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    leaseId: '...' // GUID string; lease unique identifier (optional)
 * }
 * ```
 * @returns {Promise} A promise for an object on the form:
 * ```js
 * {
 *   metadata: {                 // Mapping from meta-data keys to values
 *     '<key>':      '<value>',  // Meta-data key/value pair
 *     ...
 *   },
 *   properties: {                // System properties
 *     eTag:          '...',      // The entity tag for the container
 *     lastModified: '...'        // The date and time the container was last modified
 *     leaseStatus: '...',        // The lease status of the container
 *     leaseState:  '...',        // Lease state of the container
 *     leaseDuration: '...',      // Specifies whether the lease on a container is of infinite or fixed duration.
 *     publicAccessLevel: '...',  // Indicates whether data in the container may be accessed publicly and
 *                                // the level of access. If this is not returned in the response,
 *                                // the container is private to the account owner.
 *   }
 * }
 * ```
 */
Blob.prototype.getContainerProperties = function getContainerProperties(name, options) {
  assert(typeof name === 'string', 'The name of the container must be specified and must be a string value.');
  var query = {
    restype: 'container'
  }
  var path = '/' + name;
  var headers = {};
  if (options && options.leaseId) {
    assert(utils.isValidGUID(options.leaseId), '`leaseId` is not a valid GUID.');
    headers['x-ms-lease-id'] = options.leaseId;
  }

  return this.request('HEAD', path, query, headers).then(function(response) {
    if (response.statusCode !== 200) {
      throw new Error("getContainerProperties: Unexpected statusCode: " + response.statusCode);
    }

    // Extract metadata
    var metadata = utils.extractMetadataFromHeaders(response);

    // Extract system properties
    var properties = {};
    properties.eTag = response.headers.etag;
    properties.lastModified = new Date(response.headers['last-modified']);
    properties.leaseStatus = response.headers['x-ms-lease-status'];
    properties.leaseState = response.headers['x-ms-lease-state'];
    if (response.headers['x-ms-lease-duration']) {
      properties.leaseDuration = response.headers['x-ms-lease-duration'];
    }
    if (response.headers['x-ms-blob-public-access']) {
      properties.publicAccessLevel = response.headers['x-ms-blob-public-access'];
    }

    return {
      metadata: metadata,
      properties: properties
    }
  });
};

/**
 * Gets the permissions for the container with the given name
 *
 * @method getContainerACL
 * @param {string} name - Name of the container to get ACL from
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    leaseId: '...' // GUID string; lease unique identifier (optional)
 * }
 * ```
 * @returns {Promise} A promise for permissions
 * ```js
 * {
 *    eTag: '...',                      // The entity tag of the container
 *    lastModified: '...',              // The date/time the container was last modified
 *    publicAccessLevel: '...',         // Indicate whether blobs in a container may be accessed publicly.(optional)
 *                                      // Possible values: container (full public read access for container
 *                                      // and blob data) or blob (public read access for blobs)
 *                                      // If it is not specified, the resource will be private and will be
 *                                      // accessed only by the account owner.
 *    accessPolicies: [{                // The container ACL settings.
 *                                      // An array with five maximum access policies objects (optional)
 *      id:     '...',                  // Unique identifier, up to 64 chars in length
 *      start:  new Date(),             // Time from which access policy is valid
 *      expiry: new Date(),             // Expiration of access policy
 *      permission: {                   // Set of permissions delegated
 *        read:              false,     // Read the content, properties, metadata or block list of a blob or, of
 *                                      // any blob in the container if the resource is a container.
 *        add:               false,     // Add a block to an append blob or, to any append blob
 *                                      // if the resource is a container.
 *        create:            false,     // Write a new blob, snapshot a blob, or copy a blob to a new blob.
 *                                      // These operations can be done to any blob in the container
 *                                      // if the resource is a container.
 *        write:             false,     // Create or write content, properties, metadata, or block list.
 *                                      // Snapshot or lease the blob. Resize the blob (page blob only).
 *                                      // These operations can be done for every blob in the container
 *                                      // f the resource is a container.
 *        delete:            false,     // Delete the blob or, any blob in the container if the resource
 *                                      // is a container.
 *        list:              false,     // List blobs in the container.
 *      }
 *    }]
 * }
 * ```
 */
Blob.prototype.getContainerACL = function getContainerACL(name, options){
  assert(typeof name === 'string', 'The name of the container must be specified and must be a string value.');
  var query = {
    restype: 'container',
    comp: 'acl'
  }
  var path = '/' + name;

  var headers = {};
  if (options && options.leaseId) {
    assert(utils.isValidGUID(options.leaseId), '`leaseId` is not a valid GUID.');
    headers['x-ms-lease-id'] = options.leaseId;
  }

  return this.request('GET', path, query, headers).then(function (response) {
    if (response.statusCode !== 200) {
      throw new Error("getContainerACL: Unexpected statusCode: " + response.statusCode);
    }
    return {
      accessPolicies: xml.blobParseContainerACL(response),
      publicAccessLevel: response.headers['x-ms-blob-public-access'],
      eTag: response.headers['etag'],
      lastModified: new Date(response.headers['last-modified'])
    };
  });
};

/**
 * Sets the permissions for the container with the given name.
 * The permissions indicate whether blobs in a container may be accessed publicly.
 *
 * @method setContainerACL
 * @param {string} name - Name of the container to set ACL to
 * @param {object} options - Options on the following form
 *```js
 * {
 *    publicAccessLevel: '...',       // Indicate whether blobs in a container may be accessed publicly.(optional)
 *                                    // Possible values: container (full public read access for container
 *                                    // and blob data) or blob (public read access for blobs).
 *                                    // If it is not specified, the resource will be private and will be accessed
 *                                    // only by the account owner.
 *    accessPolicies: [{              // The container ACL settings.
 *                                    // An array with five maximum access policies objects (optional)
 *      id:     '...',                // Unique identifier, up to 64 chars in length
 *      start:  new Date(),           // Time from which access policy is valid
 *      expiry: new Date(),           // Expiration of access policy
 *      permission: {                 // Set of permissions delegated
 *        read:              false,   // Read the content, properties, metadata or block list of a blob or of
 *                                    // any blob in the container if the resourceType is a container.
 *        add:               false,   // Add a block to an append blob or to any append blob
 *                                    // if the resourceType is a container.
 *        create:            false,   // Write a new blob, snapshot a blob, or copy a blob to a new blob.
 *                                    // These operations can be done to any blob in the container
 *                                    // if the resourceType is a container.
 *        write:             false,   // Create or write content, properties, metadata, or block list.
 *                                    // Snapshot or lease the blob. Resize the blob (page blob only).
 *                                    // These operations can be done for every blob in the container
 *                                    // if the resourceType is a container.
 *        delete:            false,   // Delete the blob or any blob in the container
 *                                    // if the resourceType is a container.
 *        list:              false,   // List blobs in the container.
 *      }
 *    }],
 *    leaseId: '...',                 // GUID string; lease unique identifier (optional)
 *    ifModifiedSince: new Date(),    // Specify this to perform the operation only if the resource has
 *                                    // been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),  // Specify this to perform the operation only if the resource has
 *                                    // not been modified since the specified date/time. (optional)
 * }
 * ```
 * @returns {Promise} a promise for metadata key/value pair
 * A promise for an object on the form:
 * ```js
 * {
 *      eTag: '...',               // The entity tag of the container
 *      lastModified: '...',       // The date/time the container was last modified
 * }
 * ```
 */
Blob.prototype.setContainerACL = function setContainerACL(name, options) {
  assert(typeof name === 'string', 'The name of the container must be specified and must be a string value.');
  var query = {
    restype: 'container',
    comp: 'acl'
  };
  var path = '/' + name;
  var headers = {};
  if (options) {
    if (options.leaseId) {
      assert(utils.isValidGUID(options.leaseId), '`leaseId` is not a valid GUID.');
      headers['x-ms-lease-id'] = options.leaseId;
    }

    if (options.publicAccessLevel){
      assert(options.publicAccessLevel === 'container' || options.publicAccessLevel === 'blob',
        "The supplied `publicAccessLevel` is incorrect. The possible values are: container and blob")
      headers['x-ms-blob-public-access'] = options.publicAccessLevel;
    }
    if (options.accessPolicies && options.accessPolicies.length > 5){
      throw new Error("The supplied access policy is wrong. The maximum number of the access policies is 5");
    }

    // Construct the payload
    var data = '<?xml version="1.0" encoding="utf-8"?>';
    data += '<SignedIdentifiers>';
    if (options.accessPolicies) {
      options.accessPolicies.forEach(function(policy){
        assert(/^[0-9a-fA-F]{1,64}$/i.test(policy.id), 'The access policy id is not valid.' );

        data += '<SignedIdentifier><Id>' + policy.id + '</Id>';
        data += '<AccessPolicy>';
        if (policy.start) {
          assert(policy.start instanceof Date, "If specified, policy.start must be a Date object");
          data += '<Start>' + utils.dateToISOWithoutMS(policy.start) + '</Start>';
        }
        if (policy.expiry) {
          assert(policy.expiry instanceof Date, "If specified, policy.expiry must be a Date object");
          data += '<Expiry>' + utils.dateToISOWithoutMS(policy.expiry) + '</Expiry>';
        }

        if (policy.permission) {
          var permissions = '';
          if (policy.permission.read)    permissions += 'r';
          if (policy.permission.add)     permissions += 'a';
          if (policy.permission.create)  permissions += 'c';
          if (policy.permission.write)   permissions += 'w';
          if (policy.permission.delete)  permissions += 'd';
          if (policy.permission.list)    permissions += 'l';

          data += '<Permission>' + permissions + '</Permission>';
        }

        data += '</AccessPolicy></SignedIdentifier>';
      });
    }

    data += '</SignedIdentifiers>';

    utils.setConditionalHeaders(headers, options, true);
  }

  return this.request('PUT', path, query, headers, data).then(function(response){
    if(response.statusCode !== 200){
      throw new Error("setContainerACL: Unexpected statusCode: " + response.statusCode);
    }

    return {
      eTag: response.headers['etag'],
      lastModified: new Date(response.headers['last-modified'])
    }
  });
};

/**
 * Get the list of blobs under the specified container.
 *
 * @method listBlobs
 * @param {string} container - Name of the container(required)
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    prefix: '...',              // Prefix of blobs to list (optional)
 *    delimiter: '...',           // Delimiter, i.e. '/', for specifying folder hierarchy. (optional)
 *    marker: '...',              // Marker to list blobs from (optional)
 *    maxResults: 5000,           // The maximum number of blobs to return (optional)
 *    include: {                  // Specifies one or more datasets to include in the response (optional)
 *      snapshots: false,         // Include snapshots in listing
 *      metadata: false,          // Include blob metadata in listing
 *      uncommittedBlobs: false,  // Include uncommitted blobs in listing
 *      copy: false               // Include metadata related to any current or previous Copy Blob operation
 *    }
 * }
 * ```
 * @returns {Promise} A promise for an object on the form:
 * ```js
 * {
 *   blobs: [
 *     {
 *       name:       '...',               // Name of blob
 *       snapshot:    '...',              // A date and time value that uniquely identifies the snapshot
 *                                        // relative to its base blob
 *       properties:  {
 *          lastModified: '...',          // The date and time the blob was last modified
 *          eTag: '...',                  // The entity tag of the blob
 *          contentLength: '...',         // The content length of the blob
 *          contentType: '...',           // The MIME content type of the blob
 *          contentEncoding: '...',       // The content encoding of the blob
 *          contentLanguage: '...',       // The content language of the blob
 *          contentMD5: '...',            // An MD5 hash of the blob content
 *          cacheControl: '...',          // The blob cache control
 *          xmsBlobSequenceNumber: '...', // The page blob sequence number
 *          blobType: '...',              // The type of the blob: BlockBlob | PageBlob | AppendBlob
 *          leaseStatus: '...',           // The lease status of the blob
 *          leaseState: '...',            // The lease state of the blob
 *          leaseDuration: '...',         // The lease duration of the blob
 *          copyId: '...',                // String identifier for the copy operation
 *          copyStatus: '...',            // The state of the copy operation: pending | success | aborted | failed
 *          copySource: '...',            // The name of the source blob of the copy operation
 *          copyProgress: '...',          // The bytes copied/total bytes
 *          copyCompletionTime: '...',    // The date and time the copy operation finished
 *          copyStatusDescription: '...', // The status of the copy operation
 *          serverEncrypted: false,       // true if the blob and application metadata are completely encrypted,
 *                                        // and false otherwise
 *          incrementalCopy: '...',       // true for the incremental copy blobs operation and snapshots
 *       }
 *       metadata:   {}                   // Meta-data dictionary if requested
 *     }
 *   ],
 *   blobPrefixName: '...',
 *   prefix:         '...',               // prefix given in options (if given)
 *   marker:         '...',               // marker given in options (if given)
 *   maxResults:     5000,                // maxResults given in options (if given)
 *   nextMarker:     '...'                // Next marker if not at end of list
 *   delimiter:      '...'                // Delimiter
 * }
 * ```
 */
Blob.prototype.listBlobs = function listBlobs(container, options) {
  assert(typeof container === 'string', 'The name of the container must be specified and must be a string value.');
  // Construct the query string
  var query = {
    restype: 'container',
    comp: 'list'
  };

  assert(container, 'The container name must be specified');

  if (options) {
    if (options.prefix)     query.prefix      = options.prefix;
    if (options.marker)     query.marker      = options.marker;
    if (options.maxResults) query.maxresults  = options.maxResults;
    if (options.include)  {
      var includeValues = [];
      if (options.include.snapshot) includeValues.push('snapshot');
      if (options.include.metadata) includeValues.push('metadata');
      if (options.include.uncommittedBlobs) includeValues.push('uncommittedblobs');
      if (options.include.copy) includeValues.push('copy');

      query.include = includeValues.join(',');
    }
    if (options.delimiter)  query.delimiter = options.delimiter;
  }

  var path = '/' + container;
  var headers = {};

  return this.request('GET', path, query, headers).then(function(response){
    if(response.statusCode !== 200){
      throw new Error("listBlobs: Unexpected statusCode: " + response.statusCode);
    }
    return xml.blobParseListBlobs(response);
  });
};

/**
 * Establishes and manages a lock on a container for delete operations.
 * The lock duration can be 15 to 60 seconds, or can be infinite.
 *
 * @method leaseContainer
 * @param name - Name of the container
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    leaseId: '...',                   // GUID string; it is required in case of renew, change,
 *                                      // or release of the lease
 *    leaseAction: '...',               // Lease container operation. The possible values are: acquire, renew,
 *                                      // change, release, break (required)
 *    leaseBreakPeriod: '...',          // For a break operation, proposed duration the lease should continue
 *                                      // before it is broken, in seconds, between 0 and 60.
 *    leaseDuration: '...',             // Specifies the duration of the lease, in seconds, or negative one (-1)
 *                                      // for a lease that never expires. Required for `acquire` action.
 *    proposedLeaseId: '...'            // GUID string; Optional for `acquire`, required for `change` action.
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been
 *                                      // modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been
 *                                      // modified since the specified date/time. (optional)
 * }
 * ```
 * @returns {Promise} A promise for an object on the form:
 * ```js
 * {
 *    leaseId: '...',             // The unique lease id.
 *    leaseTime: '...'            // Approximate time remaining in the lease period, in seconds.
 *    eTag: '...',                // The entity tag of the container
 *    lastModified: '...',        // The date/time the container was last modified
 * }
 * ```
 */
Blob.prototype.leaseContainer = function leaseContainer(name, options) {
  assert(typeof name === 'string', 'The name of the container must be specified and must be a string value.');
  assert(options, "options is required");
  var query = {
    restype: 'container',
    comp: 'lease'
  };

  var path = '/' + name;
  var headers = {};

  assert(options.leaseAction, "The `options.leaseAction` must be given");

  if (options.leaseId) {
    assert(utils.isValidGUID(options.leaseId), 'The supplied `leaseId` is not a valid GUID');
    headers['x-ms-lease-id'] = options.leaseId;
  }

  assert(
    options.leaseAction === 'acquire'
    || options.leaseAction === 'renew'
    || options.leaseAction === 'change'
    || options.leaseAction === 'release'
    || options.leaseAction === 'break',
    'The supplied `options.leaseAction` is not valid. The possible values are: acquire, renew, change, release, break'
  );
  headers['x-ms-lease-action'] = options.leaseAction;

  if((options.leaseAction === 'renew'
    || options.leaseAction === 'change'
    || options.leaseAction === 'release')
    && !options.leaseId) {
    throw new Error('The `options.leaseId` must be given if the `options.leaseAction` is `renew` or `change` or `release`');
  }

  if (options.leaseBreakPeriod){
    assert(Number.isInteger(options.leaseBreakPeriod) && (options.leaseBreakPeriod >= 0 || options.leaseBreakPeriod <= 60),
      'The `options.leaseBreakPeriod` is not valid; it should be a number between 0 and 60');
    headers['x-ms-lease-break-period'] = this.options.leaseBreakPeriod;
  }

  if(options.leaseAction === 'acquire' && !options.leaseDuration){
    throw new Error ('The `options.leaseDuration` must be given if the lease action is `acquire`');
  }

  if (options.leaseDuration) {
    assert(options.leaseDuration >= 15 && (options.leaseDuration <= 60 || options.leaseDuration === -1),
      'The `options.leaseDuration` must be a value between 15 and 60 or -1.');
    headers['x-ms-lease-duration'] = options.leaseDuration.toString();
  }

  if (options.leaseAction === 'change' && !options.proposedLeaseId) {
    throw new Error('The `options.proposedLeaseId` must be given if the lease action is `change`');
  }
  if(options.proposedLeaseId){
    assert(utils.isValidGUID(this.options.leaseId), 'The supplied `proposedLeaseId` is not a valid GUID');
    headers['x-ms-proposed-lease-id'] = options.proposedLeaseId;
  }

  utils.setConditionalHeaders(headers, options, true);

  return this.request('PUT', path, query, headers).then(function(response) {
    if (response.statusCode !== 200 && response.statusCode !== 201 && response.statusCode !== 202) {
      throw new Error("leaseContainer: Unexpected statusCode: " + response.statusCode);
    }

    var result = {
      leaseId: response.headers['x-ms-lease-id'],
      eTag: response.headers['etag'],
      lastModified: new Date(response.headers['last-modified'])
    };
    if (response.headers['x-ms-lease-time']) {
      result.leaseTime = response.headers['x-ms-lease-time'];
    }
    return result;
  });
};

/**
 * Creates a new block, page, or append blob, or updates the content of an existing block blob.
 * Updating an existing block blob overwrites any existing metadata on the blob,
 * and the content of the existing blob is overwritten with the content of the new blob.
 *
 * Note that a call to a putBlob to create a page blob or an append blob only initializes the blob.
 * To add content to a page blob, call the putPage. To add content to an append blob, call the appendBlock.
 *
 * @method putBlob
 * @param {string} container - Name of the container where the blob should be stored
 * @param {string} blob - Name of the blob
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    metadata: '...',                          // Name-value pairs associated with the blob as metadata
 *    contentType: 'application/octet-stream',  // The MIME content type of the blob (optional)
 *    contentEncoding: '...',                   // Specifies which content encodings have been applied
 *                                              // to the blob. (optional)
 *    contentLanguage: '...',                   // Specifies the natural languages used by this resource(optional)
 *    cacheControl: '...',                      // The Blob service stores this value but does not
 *                                              // use or modify it. (optional)
 *    disableContentMD5Check: 'false',          // Enable/disable the content md5 check is disabled.(optional)
 *    type: BlockBlob|PageBlob|AppendBlob,      // The type of blob to create: block blob, page blob,
 *                                              // or append blob (required)
 *    leaseId: '...',                           // Lease id (required if the blob has an active lease)
 *    contentDisposition: '...',                // Specifies the content disposition of the blob (optional)
 *    ifModifiedSince: new Date(),              // Specify this to perform the operation only if the resource
 *                                              // has been modified since the specified time.
 *    ifUnmodifiedSince: new Date(),            // Specify this to perform the operation only if the resource
 *                                              // has not been modified since the specified date/time.
 *    ifMatch: '...',                           // ETag value. Specify this to perform the operation only if the
 *                                              // resource's ETag matches the value specified.
 *    ifNoneMatch: '...',                       // ETag value. Specify this to perform the operation only if the
 *                                              //resource's ETag does not match the value specified.
 *    pageBlobContentLength: '...',             // Specifies the maximum size for the page blob, up to 1 TB.
 *                                              // (required for page blobs)
 *    pageBlobSequenceNumber: 0,                // The sequence number - a user-controlled value that you can use
 *                                              // to track requests (optional, only for page blobs)
 * }
 *```
 * @param {string|buffer} content - The content of the blob
 * @return {Promise} A promise for an object on the form:
 * ```js
 * {
 *    eTag: '...',         // The entity tag of the blob
 *    lastModified: '...', // The date/time the blob was last modified
 *    contentMD5: '...',   // The MD5 hash of the blob
 * }
 * ```
 */
Blob.prototype.putBlob = function putBlob(container, blob, options, content) {
  assert(typeof container === 'string', 'The name of the container must be specified and must be a string value.');
  assert(typeof blob === 'string', 'The name of the blob must be specified and must be a string value.');
  assert(options, "options is required");
  assert(options.type, 'The blob type must be specified');
  assert(options.type === 'BlockBlob'
    || options.type === 'PageBlob'
    || options.type === 'AppendBlob',
    'The blob type is invalid. The possible types are: BlockBlob, PageBlob or AppendBlob.');

  if (options.type === 'PageBlob' && content) {
    throw new Error('Do not include content when a page blob is created. Use putPage() to add/modify the content of a page blob');
  }
  if(options.type === 'AppendBlob' && content) {
    throw new Error('Do not include content when an append blob is created. Use appendBlock() to add content to the end of the append blob');
  }

  if ((options.type === 'BlockBlob'
    || options.type === 'AppendBlob')) {

    if (options.pageBlobContentLength) {
      throw new Error('Do not include page blob content length to a block blob or to an append blob.');
    }
    if (options.pageBlobSequenceNumber) {
      throw new Error('Do not include page blob sequence number to a block blob or to an append blob.');
    }
  }

  // check the content length
  var contentLength = 0;
  if (content && Buffer.isBuffer(content)) {
    contentLength = content.length;
  } else if (content) {
    contentLength = Buffer.byteLength(content);
  }

  if (options.type === 'BlockBlob'
    && contentLength > MAX_SINGLE_UPLOAD_BLOCK_BLOB_SIZE_IN_BYTES) {
    throw new Error('The maximum size of a block blob that can be uploaded with putBlob() is ' + MAX_SINGLE_UPLOAD_BLOCK_BLOB_SIZE_IN_BYTES + '.' +
      'In order to upload larger blobs, use putBlock() and putBlockList()');
  }
  if (options.type === 'PageBlob'){
    if (options.pageBlobContentLength % PAGE_SIZE !== 0) {
      throw new Error('Page blob length must be multiple of ' + PAGE_SIZE + '.');
    }
    if (options.pageBlobContentLength < MAX_PAGE_SIZE) {
      throw new Error('The maximum size of the page blob (options.pageBlobContentLength) is ' + MAX_PAGE_SIZE + '.');
    }
    if (options.pageBlobSequenceNumber && typeof options.pageBlobSequenceNumber !== 'number') {
      throw new Error('The `options.pageBlobSequenceNumber` is invalid. It must be a number');
    }
    if (options.pageBlobSequenceNumber
      && options.pageBlobSequenceNumber >= 0
      && options.pageBlobSequenceNumber < Math.pow(2, 63)) {
      throw new Error('The `options.pageBlobSequenceNumber` is invalid. It must be a number between 0 and 2^63 - 1');
    }
  }

  var query = {};
  var path = '/' + container + '/' + blob;
  var headers = {};

  headers['content-length'] = options.type === 'PageBlob' || options.type === 'AppendBlob' ? 0 : contentLength;

  if (options.contentType) {
    headers['content-type'] = options.contentType;
  }
  if (options.contentEncoding) {
    headers['content-encoding'] = options.contentEncoding;
  }
  if (options.contentLanguage) {
    headers['content-language'] = options.contentLanguage;
  }
  if (options.cacheControl) {
    headers['cache-control'] = options.cacheControl;
  }

  headers['x-ms-blob-type'] = options.type;

  if (!options.disableContentMD5Check && options.type === 'BlockBlob' && content) {
    headers['content-md5'] = utils.md5(content);
  }

  if (options.contentDisposition) {
    headers['x-ms-blob-content-disposition'] = options.contentDisposition;
  }

  // support for condition headers
  utils.setConditionalHeaders(headers, options);

  if (options.pageBlobContentLength) {
    headers['x-ms-blob-content-length'] = options.pageBlobContentLength;
  }
  if (options.pageBlobSequenceNumber) {
    headers['x-ms-blob-sequence-number'] = options.pageBlobSequenceNumber;
  }

  // add metadata
  if (options.metadata){
    for(var key in options.metadata) {
      if (options.metadata.hasOwnProperty(key)) {
        headers['x-ms-meta-' + key] = options.metadata[key];
      }
    }
  }

  return this.request('PUT', path, query, headers, content).then(function(response){
    if(response.statusCode !== 201) {
      throw new Error("putBlob: Unexpected statusCode: " + response.statusCode);
    }

    return {
      eTag: response.headers['etag'],
      lastModified: new Date(response.headers['last-modified']),
      contentMd5: response.headers['content-md5']
    }
  });
};

/**
 * Reads or downloads a blob from the system, including its metadata and properties.
 *
 * @method getBlob
 * @param {string} container - Name of the container where the blob should be stored
 * @param {string} blob - Name of the blob
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been
 *                                      // modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not
 *                                      // been modified since the specified date/time. (optional)
 *    ifMatch: '...',                   // ETag value. Specify this to perform the operation only if the resource's
 *                                      // ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',               // ETag value. Specify this to perform the operation only if the resource's
 *                                      // ETag does not match the value specified. (optional)
 * }
 *```
 * @return {Promise} A promise for an object on the form:
 * ```js
 * {
 *    eTag: '...',                    // The entity tag of the blob
 *    lastModified: '...',            // The date/time the blob was last modified.
 *    contentMD5: '...',              // The MD5 hash fo the blob
 *    contentEncoding: '...',         // The content encoding of the blob
 *    contentLanguage: '...',         // The content language of the blob
 *    cacheControl: '...',            // The cache control of the blob
 *    contentDisposition: '...',      // The content disposition of the blob
 *    pageBlobSequenceNumber: '...',  // The current sequence number for a page blob.
 *    type: '...',                    // The blob type: block, page or append blob.
 *    blobCommittedBlockCount: '...', // The number of committed blocks present in the blob.
 *                                    // This is returned only for append blobs.
 *    metadata: '...',                // Name-value pairs associated with the blob as metadata
 *    content: '...'                  // The content
 * }
 * ```
 */
Blob.prototype.getBlob = function getBlob(container, blob, options) {
  assert(typeof container === 'string', 'The name of the container must be specified and must be a string value.');
  assert(typeof blob === 'string', 'The name of the blob must be specified and must be a string value.');

  var query = {};
  var path = '/' + container + '/' + blob;
  var headers = {};

  utils.setConditionalHeaders(headers, options);

  return this.request('GET', path, query, headers).then(function (response) {
    if (response.statusCode !== 200) {
      throw new Error("getBlob: Unexpected statusCode: " + response);
    }
    var responseHeaders = response.headers;

    return {
      contentMD5: responseHeaders['content-md5'],
      contentEncoding: responseHeaders['content-encoding'],
      contentLanguage: responseHeaders['content-language'],
      cacheControl: responseHeaders['cache-control'],
      contentDisposition: responseHeaders['content-disposition'],
      pageBlobSequenceNumber: responseHeaders['x-ms-blob-sequence-number'],
      blobCommittedBlockCount: responseHeaders['x-ms-blob-committed-block-count'],
      metadata: utils.extractMetadataFromHeaders(response),
      type: responseHeaders['x-ms-blob-type'],
      eTag: responseHeaders['etag'],
      lastModified: new Date(responseHeaders['last-modified']),
      content: response.payload
    };
  });
};

/**
 * Returns all user-defined metadata, standard HTTP properties, and system properties for the blob.
 *
 * @method getBlobProperties
 * @param {string} container - Name of the container
 * @param {string} blob - Name of the blob
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been
 *                                      // modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been
 *                                      // modified since the specified date/time. (optional)
 *    ifMatch: '...',                   // ETag value. Specify this to perform the operation only if the resource's
 *                                      // ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',               // ETag value. Specify this to perform the operation only if the resource's
 *                                      // ETag does not match the value specified. (optional)
 * }
 *```
 *
 * @return {Promise} A promise for an object on the form:
 * ```js
 * {
 *    metadata: '...',                // Name-value pairs that correspond to the user-defined metadata
 *                                    // associated with this blob.
 *    lastModified: '...',            // The date/time the blob was last modified.
 *    type: '...',                    // The blob type
 *    leaseDuration: '...',           // When a blob is leased, specifies whether the lease is of
 *                                    // infinite or fixed duration
 *    leaseState: '...',              // Lease state of the blob
 *    leaseStatus: '...',             // The lease status of the blob.
 *    contentLength: '...',           // The size of the blob in bytes
 *    contentType: '...',             // The content type specified for the blob
 *    eTag: '...',                    // The blob Etag
 *    contentMD5: '...'               // The content-md5 of the blob
 *    contentEncoding: '...',         // The content encoding of the blob
 *    contentLanguage: '...'          // The content language of the blob
 *    contentDisposition: '...',      // The content disposition of the blob
 *    cacheControl: '...',            // The cache control of the blob
 *    pageBlobSequenceNumber: '...',  // The current sequence number for a page blob.
 *    committedBlockCount: '...',     // The number of committed blocks present in the blob (for append blob).
 * }
 * ```
 */
Blob.prototype.getBlobProperties = function getBlobProperties(container, blob, options) {
  assert(typeof container === 'string', 'The name of the container must be specified and must be a string value.');
  assert(typeof blob === 'string', 'The name of the blob must be specified and must be a string value.');

  var query = {};
  var path = '/' + container + '/' + blob;
  var headers = {};

  utils.setConditionalHeaders(headers, options);

  return this.request('HEAD', path, query, headers).then(function (response) {
    if (response.statusCode !== 200) {
      throw new Error("getBlobProperties: Unexpected statusCode: " + response);
    }

    /**
     * TODO information about:
     * - copyCompletionTime,
     * - copyStatusDescription,
     * - copyStatusDescription,
     * - copyId,
     * - copyProgress,
     * - copySource,
     * - copyStatus,
     * - copyDestinationSnapshot
     * - incrementalCopy
     *
     * will be added after the copyBlob will be implemented
     */
    var result = {
      metadata: utils.extractMetadataFromHeaders(response),
      type: response.headers['x-ms-blob-type'],
      leaseState: response.headers['x-ms-lease-state'],
      leaseStatus: response.headers['x-ms-lease-status'],
      contentLength: response.headers['content-length'],
      contentType: response.headers['content-type'],
      eTag: response.headers['etag']
    };
    if (response.headers['last-modified']) {
      result.lastModified = new Date(response.headers['last-modified']);
    }
    if (response.headers['x-ms-lease-duration']) {
      result.leaseDuration = response.headers['x-ms-lease-duration'];
    }
    if (response.headers['content-md5']) {
      result.contentMD5 = response.headers['content-md5'];
    }
    if (response.headers['content-encoding']) {
      result.contentEncoding = response.headers['content-encoding'];
    }
    if (response.headers['content-language']) {
      result.contentLanguage = response.headers['content-language'];
    }
    if (response.headers['content-disposition']) {
      result.contentDisposition = response.headers['content-disposition'];
    }
    if (response.headers['content-control']) {
      result.cacheControl = response.headers['content-control'];
    }
    if (response.headers['x-ms-blob-sequence-number']) {
      result.pageBlobSequenceNumber = response.headers['x-ms-blob-sequence-number'];
    }
    if (response.headers['x-ms-blob-committed-block-count']) {
      result.committedBlockCount = response.headers['x-ms-blob-committed-block-count'];
    }
    return result;
  });
};

/**
 * Sets system properties on the blob
 *
 * @method setBlobProperties
 * @param {string} container - Name of the container
 * @param {string} blob - Name of the blob
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    cacheControl: '...',                      // The cache control string for the blob (optional)
 *                                              // If this property is not specified, then the property
 *                                              // will be cleared for the blob.
 *    contentType: '...',                       // The MIME content type of the blob (optional)
 *                                              // If this property is not specified, then the property
 *                                              // will be cleared for the blob.
 *    contentMD5: '...',                        // The MD5 hash of the blob (optional)
 *                                              // If this property is not specified, then the property
 *                                              // will be cleared for the blob.
 *    contentEncoding: '...',                   // The content encodings of the blob. (optional)
 *                                              // If this property is not specified, then the property
 *                                              // will be cleared for the blob.
 *    contentLanguage: '...',                   // The content language of the blob. (optional)
 *                                              // If this property is not specified, then the property
 *                                              // will be cleared for the blob.
 *    contentDisposition: '...',                // The content disposition (optional)
 *                                              // If this property is not specified, then the property
 *                                              // will be cleared for the blob.
 *    pageBlobContentLength: '...',             // The new size of a page blob. If the specified value is
 *                                              // less than the current size of the blob, then all pages
 *                                              // above the specified value are cleared.
 *                                              // This property applies to page blobs only.
 *    pageBlobSequenceNumberAction:
 *              'max|update|increment',         // Indicates how the service should modify the blob's
 *                                              // sequence number.
 *                                              // - max: Sets the sequence number to be the higher of the
 *                                              //        value included with the request and the value
 *                                              //        currently stored for the blob.
 *                                              // - update: Sets the sequence number to the value
 *                                              //           included with the request.
 *                                              // - increment: Increments the value of the sequence
 *                                              //              number by 1.
 *                                              // This property applies to page blobs only. (optional)
 *    pageBlobSequenceNumber: '...',            // The page blob sequence number.
 *                                              // Optional, but required if the
 *                                              // `pageBlobSequenceNumberAction` option is set to `max`
 *                                              // or `update`.
 *                                              // This property applies to page blobs only.
 *    ifModifiedSince: new Date(),              // Specify this to perform the operation only if the
 *                                              // resource has been modified since the specified time.
 *                                              // (optional)
 *    ifUnmodifiedSince: new Date(),            // Specify this to perform the operation only if the
 *                                              // resource has not been modified since the specified
 *                                              // date/time. (optional)
 *    ifMatch: '...',                           // ETag value. Specify this to perform the operation only
 *                                              // if the resource's ETag matches the value specified.
 *                                              // (optional)
 *    ifNoneMatch: '...',                       // ETag value. Specify this to perform the operation only
 *                                              // if the resource's ETag does not match the value
 *                                              // specified. (optional)
 * }
 *```
 *
 * @return {Promise} A promise for an object on the form:
 * ```js
 * {
 *      eTag: '...',               // The entity tag of the blob
 *      lastModified: '...',       // The date/time the blob was last modified
 *      blobSequenceNumber: '...', // The blob's current sequence number (if the blob is a page blob)
 * }
 * ```
 */
Blob.prototype.setBlobProperties = function setBlobProperties(container, blob, options) {
  assert(typeof container === 'string', 'The name of the container must be specified and must be a string value.');
  assert(typeof blob === 'string', 'The name of the blob must be specified and must be a string value.');

  var query = {
    comp: 'properties'
  };
  var path = '/' + container + '/' + blob;
  var headers = {};

  if (options){
    if (options.cacheControl) headers['x-ms-blob-cache-control'] = options.cacheControl;
    if (options.contentType) headers['x-ms-blob-content-type'] = options.contentType;
    if (options.contentMD5) headers['x-ms-blob-content-md5'] = options.contentMD5;
    if (options.contentEncoding) headers['x-ms-blob-content-encoding'] = options.contentEncoding;
    if (options.contentLanguage) headers['x-ms-blob-content-language'] = options.contentLanguage;
    if (options.contentDisposition) headers['x-ms-blob-content-disposition'] = options.contentDisposition;
    if (options.pageBlobContentLength) headers['x-ms-blob-content-length'] = options.pageBlobContentLength;
    if (options.pageBlobSequenceNumberAction){
      assert(options.pageBlobSequenceNumberAction === 'max'
        || options.pageBlobSequenceNumberAction === 'update'
        || options.pageBlobSequenceNumberAction === 'increment',
        'The `options.pageBlobSequenceNumberAction` is invalid. The possible values are: max, update and increment.');
      headers['x-ms-sequence-number-action'] = options.pageBlobSequenceNumberAction;
      if (options.pageBlobSequenceNumberAction === 'max'
        || options.pageBlobSequenceNumberAction === 'update'
        && !options.pageBlobSequenceNumber) {
        throw new Error('If `options.pageBlobSequenceNumberAction` is `max` or `update`, the `options.pageBlobSequenceNumber` must be supplied.');
      }
      if (options.pageBlobSequenceNumber) headers['x-ms-blob-sequence-number'] = options.pageBlobSequenceNumber;
    }

    utils.setConditionalHeaders(headers, options);
  }

  return this.request('PUT', path, query, headers).then(function (response) {
    if (response.statusCode !== 200) {
      throw new Error("setBlobProperties: Unexpected statusCode: " + response);
    }

    var result = {
      eTag: response.headers['etag'],
      lastModified: new Date(response.headers['last-modified'])
    };
    if (response.headers['x-ms-blob-sequence-number']) {
      result.blobSequenceNumber = response.headers['x-ms-blob-sequence-number'];
    }

    return result;
  });
};

/**
 * Get the metadata for the blob with the given name.
 *
 * Note, this is a `HEAD` request, so if the container is missing you get an
 * error with `err.statusCode = 404`, but `err.code` property will be
 * `ErrorWithoutCode`.
 *
 * @method getBlobMetadata
 * @param {string} container - the name of the container
 * @param {string} blob - the name of the blob
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been
 *                                      // modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not
 *                                      // been modified since the specified date/time. (optional)
 *    ifMatch: '...',                   // ETag value. Specify this to perform the operation only if the resource's
 *                                      // ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',               // ETag value. Specify this to perform the operation only if the resource's
 *                                      // ETag does not match the value specified. (optional)
 * }
 *```
 *
 * @returns {Promise} a promise for metadata key/value pair
 * A promise for an object on the form:
 * ```js
 * {
 *      eTag: '...',               // The entity tag of the blob
 *      lastModified: '...',       // The date/time the blob was last modified
 *      metadata: '...'            // Name-value pairs that correspond to the user-defined metadata
 *                                 // associated with this blob.
 * }
 * ```
 */
Blob.prototype.getBlobMetadata = function getBlobMetadata(container, blob, options) {
  assert(typeof container === 'string', 'The name of the container must be specified and must be a string value.');
  assert(typeof blob === 'string', 'The name of the blob must be specified and must be a string value.');

  var query = {
    comp: 'metadata'
  }
  var path = '/' + container + '/' + blob;
  var headers = {};

  utils.setConditionalHeaders(headers, options);

  return this.request('HEAD', path, query, headers).then(function(response) {
    if (response.statusCode !== 200) {
      throw new Error("getBlobMetadata: Unexpected statusCode: " + response.statusCode);
    }
    var result = {
      eTag: response.headers['etag'],
      lastModified: new Date(response.headers['last-modified']),
      metadata: utils.extractMetadataFromHeaders(response)
    };
    return result;
  });
};

/**
 * Sets metadata for the specified blob.
 * Overwrites all existing metadata that is associated with that blob.
 *
 * @method setBlobMetadata
 * @param {string} container - Name of the container
 * @param {string} blob - Name of the blob
 * @param {object} metadata - Mapping from metadata keys to values.
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been
 *                                      // modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not
 *                                      // been modified since the specified date/time. (optional)
 *    ifMatch: '...',                   // ETag value. Specify this to perform the operation only if the resource's
 *                                      // ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',               // ETag value. Specify this to perform the operation only if the resource's
 *                                      // ETag does not match the value specified. (optional)
 * }
 *```
 * @returns {Promise} A promise for an object on the form:
 * ```js
 * {
 *      eTag: '...',               // The entity tag of the blob
 *      lastModified: '...'        // The date/time the blob was last modified.
 * }
 * ```
 */
Blob.prototype.setBlobMetadata = function setBlobMetadata(container, blob, metadata, options) {
  assert(typeof container === 'string', 'The name of the container must be specified and must be a string value.');
  assert(typeof blob === 'string', 'The name of the blob must be specified and must be a string value.');

  // Construct query string
  var query = {
    comp: 'metadata'
  };
  // Construct headers
  var headers = {};

  utils.setConditionalHeaders(headers, options);

  for(var key in metadata) {
    if (metadata.hasOwnProperty(key)) {
      headers['x-ms-meta-' + key] = metadata[key];
    }
  }
  var path = '/' + container + '/' + blob;
  return this.request('PUT', path, query, headers).then(function(response) {
    if(response.statusCode !== 200) {
      throw new Error('setBlobMetadata: Unexpected statusCode: ' + response.statusCode);
    }

    return {
      eTag: response.headers.etag,
      lastModified: new Date(response.headers['last-modified'])
    }
  });
};

/**
 * Marks the specified blob for deletion. The blob is later deleted during garbage collection.
 *
 * @method deleteBlob
 * @param {string} container - Name of the container
 * @param {string} blob - Name of the blob
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been
 *                                      // modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been
 *                                      // modified since the specified date/time. (optional)
 *    ifMatch: '...',                   // ETag value. Specify this to perform the operation only if the resource's
 *                                      // ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',               // ETag value. Specify this to perform the operation only if the resource's
 *                                      // ETag does not match the value specified. (optional)
 * }
 *```
 * @return {Promise} A promise that container has been marked for deletion.
 */
Blob.prototype.deleteBlob = function deleteBlob(container, blob, options) {
  assert(typeof container === 'string', 'The name of the container must be specified and must be a string value.');
  assert(typeof blob === 'string', 'The name of the blob must be specified and must be a string value.');

  var query = {};
  var path = '/' + container + '/' + blob;
  var headers = {};

  utils.setConditionalHeaders(headers, options);

  return this.request('DELETE', path, query, headers).then(function(response) {
    if(response.statusCode !== 202) {
      throw new Error('deleteBlob: Unexpected statusCode: ' + response.statusCode);
    }
  });
};

/**
 * Creates a new block to be committed as part of a blob.
 *
 * @method putBlock
 * @param {string} container - Name of the container
 * @param {string} blob - Name of the blob
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    blockId: '...',                  // A valid Base64 string value that identifies the block
 *                                     // For a given blob, the length of the value specified for the
 *                                     // blockId must be the same size for each block.(required)
 *    disableContentMD5Check: 'false', // Enable/disable the content md5 check is disabled.(optional)
 * }
 * ```
 * @param {string|buffer} content - The content of the block
 *
 * @returns {Promise}  A promise for an object on the form:
 * ```js
 * {
 *    contentMD5: '...'   // The MD5 hash of the block
 * }
 */
Blob.prototype.putBlock = function putBlock(container, blob, options, content) {
  assert(typeof container === 'string', 'The name of the container must be specified and must be a string value.');
  assert(typeof blob === 'string', 'The name of the blob must be specified and must be a string value.');
  assert(content, 'The content must be specified');
  assert(options, 'options is required');
  assert(options.blockId, 'The block identifier must be specified');

  var blockIdLength = Buffer.byteLength(new Buffer(options.blockId, 'base64'));
  assert(blockIdLength <= 64, 'The block id is invalid. It must be less than or equal to 64 bytes in size.');

  var contentLength = 0;
  if (content && Buffer.isBuffer(content)) {
    contentLength = content.length;
  } else if (content){
    contentLength = Buffer.byteLength(content);
  }
  if (contentLength > MAX_BLOCK_SIZE) {
    throw new Error('The maximum size of a block is ' + MAX_BLOCK_SIZE + '.');
  }

  var query = {
    comp: 'block',
    blockid: options.blockId
  };

  var path = '/' + container + '/' + blob;
  var headers = {};
  headers['content-length'] = contentLength;
  if (options && !options.disableContentMD5Check){
    headers['content-md5'] = utils.md5(content);
  }

  return this.request('PUT', path, query, headers, content).then(function(response) {
    if(response.statusCode !== 201) {
      throw new Error('putBlock: Unexpected statusCode: ' + response.statusCode);
    }

    return {
      contentMD5: response.headers['content-md5']
    }
  });
};

/**
 * Writes a blob by specifying the list of block IDs that make up the blob.
 * In order to be written as part of a blob, a block must have been successfully written
 * to the server in a prior putBlock operation.
 *
 * @method putBlockList
 * @param {string} container - Name of the container
 * @param {string} blob - Name of the blob
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    cacheControl: '...',              // Blob's cache control (optional)
 *    contentType: '...',               // Blob's content type (optional)
 *    contentEncoding: '...',           // Blob's content encoding (optional)
 *    contentLanguage: '...',           // Blob's content language (optional)
 *    metadata: '...',                  // Name-value pairs that correspond to the user-defined metadata
 *                                      // associated with this blob.
 *    contentDisposition: '...',        // Blob's content disposition
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been
 *                                      // modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been
 *                                      // modified since the specified date/time. (optional)
 *    ifMatch: '...',                   // ETag value. Specify this to perform the operation only if the resource's
 *                                      // ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',               // ETag value. Specify this to perform the operation only if the resource's
 *                                      // ETag does not match the value specified. (optional)
 *    committedBlockIds: [],            // List of block ids to indicate that the Blob service should search only
 *                                      // the committed block list for the named blocks(optional)
 *    uncommittedBlockIds: [],          // List of block ids to indicate that the Blob service should search only
 *                                      // the uncommitted block list for the named blocks (optional)
 *    latestBlockIds: [],               // List of block ids to indicate that the Blob service should first
 *                                      // search the uncommitted block list. If the block is found in the
 *                                      // uncommitted list, that version of the block is the latest and should
 *                                      // be written to the blob.
 *                                      // If the block is not found in the uncommitted list, then the service
 *                                      // should search the committed block list for the named block and write
 *                                      // that block to the blob if it is found. (optional)
 * }
 *
 * @return {Promise} - A promise for an object on the form:
 * ```js
 * {
 *    eTag: '...',         // The entity tag of the blob
 *    lastModified: '...', // The date/time the blob was last modified.
 * }
 */
Blob.prototype.putBlockList = function putBlockList(container, blob, options) {
  assert(typeof container === 'string', 'The name of the container must be specified and must be a string value.');
  assert(typeof blob === 'string', 'The name of the blob must be specified and must be a string value.');

  var query = {
    comp: 'blocklist'
  };

  var path = '/' + container + '/' + blob;
  var headers = {};

  // TODO content-md5 check
  if (options) {
    var data = '<?xml version="1.0" encoding="utf-8"?>';
    data += '<BlockList>';
    if (options.committedBlockIds){
      for(var i = 0; i < options.committedBlockIds.length; i++){
        data += '<Committed>' + options.committedBlockIds[i] + '</Committed>';
      }
    }

    if (options.uncommittedBlockIds){
      for(var i = 0; i < options.uncommittedBlockIds.length; i++){
        data += '<Uncommitted>' + options.uncommittedBlockIds[i] + '</Uncommitted>';
      }
    }

    if (options.latestBlockIds){
      for(var i = 0; i < options.latestBlockIds.length; i++){
        data += '<Latest>' + options.latestBlockIds[i] + '</Latest>';
      }
    }
    data += '</BlockList>';

    if (options.cacheControl){
      headers['x-ms-blob-cache-control'] = options.cacheControl;
    }
    if (options.contentType) {
      headers['x-ms-blob-content-type'] = options.contentType;
    }
    if (options.contentEncoding) {
      headers['x-ms-blob-content-encoding'] = options.contentEncoding;
    }
    if (options.contentLanguage) {
      headers['x-ms-blob-content-language'] = options.contentLanguage;
    }
    if (options.metadata) {
      for(var key in options.metadata) {
        if (options.metadata.hasOwnProperty(key)) {
          headers['x-ms-meta-' + key] = options.metadata[key];
        }
      }
    }
    if (options.contentDisposition) {
      headers['x-ms-blob-content-disposition'] = options.contentDisposition;
    }
    utils.setConditionalHeaders(headers, options);
  }

  return this.request('PUT', path, query, headers, data).then(function(response) {
    if(response.statusCode !== 201) {
      throw new Error('putBlockList: Unexpected statusCode: ' + response.statusCode);
    }
    return {
      eTag: response.headers['etag'],
      lastModified: new Date(response.headers['last-modified']),
    }
  });
};

/**
 * Retrieves the list of committed list blocks (that that have been successfully committed to a given blob with
 * putBlockList()), and uncommitted list blocks (that have been uploaded for a blob using Put Block, but that have
 * not yet been committed)
 *
 * @method getBlockList
 * @param {string} container - Name of the container
 * @param {string} blob - Name of the blob
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    blockListType: 'committed'  // Specifies whether to return the list of committed blocks, the list of
 *                                // uncommitted blocks, or both lists together. Valid values are committed,
 *                                // uncommitted, or all
 * }
 *```
 * @return {Promise} A promise for an object on the form:
 * ```js
 * {
 *    eTag: '...',
 *    committedBlocks: [
 *      {
 *        blockId: '...',     // Base64 encoded block identifier
 *        size: '...'         // Block size in bytes
 *      }
 *    ],
 *    uncommittedBlocks: [
 *    {
 *        blockId: '...',     // Base64 encoded block identifier
 *        size: '...'         // Block size in bytes
 *      }
 *   ]
 * }
 * ```
 */
Blob.prototype.getBlockList = function getBlockList(container, blob, options) {
  assert(typeof container === 'string', 'The name of the container must be specified and must be a string value.');
  assert(typeof blob === 'string', 'The name of the blob must be specified and must be a string value.');

  var query = {
    comp: 'blocklist'
  };
  if (options && options.blockListType){
    if(options.blockListType !== 'committed'
      && options.blockListType !== 'uncommitted'
      && options.blockListType !== 'all') {
      throw new Error('The `options.blockListType` is invalid. The possible values are: committed, uncommitted and all');
    }
    query.blocklisttype = options.blockListType;
  }

  var path = '/' + container + '/' + blob;
  var headers = {};

  return this.request('GET', path, query, headers).then(function(response) {
    if(response.statusCode !== 200) {
      throw new Error('getBlockList: Unexpected statusCode: ' + response.statusCode);
    }

    var result = xml.blobParseListBlock(response);

    // The ETag is returned only if the blob has committed blocks
    if (response.headers['ETag']) {
      result.eTag = response.headers['ETag'];
    }

    return result;
  });
};

/**
 * Generates a base64 string that identifies a block.
 *
 * @method getBlockId
 * @param {string} prefix - the prefix of the block id
 * @param {number} blockNumber - the block number
 * @param {number} length - length of the block id
 *
 * @return {string} - a base64 string as a block identifier
 */
Blob.prototype.getBlockId = function getBlockId(prefix, blockNumber, length) {
  assert (typeof prefix === 'string', 'prefix must be specified and must be a string value and must be a string value.');
  assert (typeof blockNumber === 'number', 'blockNumber must be specified and must be a number.');
  assert (length, 'The block id length must be specified');

  var paddingStr = blockNumber + '';
  while (paddingStr.length < length){
    paddingStr = '0' + paddingStr;
  }
  return new Buffer(prefix + '-' + paddingStr).toString('base64');
};

/**
 * Commits a new block of data to the end of an existing append blob.
 *
 * @method appendBlock
 * @param {string} container - Name of the container
 * @param {string} blob - Name of the blob
 * @param {object} options - Options on the following form
 * ```js
 * {
 *
 *    disableContentMD5Check: 'false',          // Enable/disable the content md5 check is disabled.(optional)
 *    blobConditionMaxSize: '...',              // The max length in bytes permitted for the append blob (optional)
 *    blobConditionAppendPositionOffset: '...', // A number indicating the byte offset to compare (optional)
 *    ifModifiedSince: new Date(),              // Specify this to perform the operation only if the resource has
 *                                              // been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),            // Specify this to perform the operation only if the resource has
 *                                              // not been modified since the specified date/time. (optional)
 *    ifMatch: '...',                           // ETag value. Specify this to perform the operation only if the
 *                                              // resource's ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',                       // ETag value. Specify this to perform the operation only if the
 *                                              // resource's ETag does not match the value specified. (optional)
 * }
 *```
 * @param {string|buffer} content - the content of the block
 *
 * @return {Promise} A promise for an object on the form:
 * ```js
 * {
 *    eTag: '...',                // The entity tag for the append blob
 *    lastModified: '...',        // The date/time the blob was last modified
 *    contentMD5: '...',          // The MD5 hash of the append blob
 *    appendOffset: '...',        // The offset at which the block was committed, in bytes.
 *    committedBlockCount: '...', // The number of committed blocks present in the blob.
 *                                // This can be used to control how many more appends can be done.
 * }
 * ```
 */
Blob.prototype.appendBlock = function appendBlock(container, blob, options, content) {
  assert(typeof container === 'string', 'The name of the container must be specified and must be a string value.');
  assert(typeof blob === 'string', 'The name of the blob must be specified and must be a string value.');
  assert(content, 'The content of block must be specified');

  var contentLength = 0;
  if (content && Buffer.isBuffer(content)) {
    contentLength = content.length;
  } else if (content){
    contentLength = Buffer.byteLength(content);
  }
  if (contentLength > MAX_APPEND_BLOCK_SIZE) {
    throw new Error('The maximum size of an append block is ' + MAX_APPEND_BLOCK_SIZE + '.');
  }
  var query = {
    comp: 'appendblock'
  };

  var path = '/' + container + '/' + blob;
  var headers = {};
  headers['content-length'] = contentLength;
  if (options) {
    if (!options.disableContentMD5Check) {
      headers['content-md5'] = utils.md5(content);
    }
    if (options.blobConditionMaxSize) {
      headers['x-ms-blob-condition-maxsize'] = options.blobConditionMaxSize;
    }
    if (options.blobConditionAppendPositionOffset) {
      assert(typeof options.blobConditionAppendPositionOffset === 'number',
        'The `options.blobConditionAppendPositionOffset` must be a number');
      headers['x-ms-blob-condition-appendpos'] = options.blobConditionAppendPositionOffset;
    }
    utils.setConditionalHeaders(headers, options);
  }

  return this.request('PUT', path, query, headers, content).then(function(response) {
    if(response.statusCode !== 201) {
      throw new Error('appendBlock: Unexpected statusCode: ' + response.statusCode);
    }

    return {
      eTag: response.headers['etag'],
      lastModified: new Date(response.headers['last-modified']),
      contentMD5: response.headers['content-md5'],
      appendOffset: response.headers['x-ms-blob-append-offset'],
      committedBlockCount: response.headers['x-ms-blob-committed-block-count']
    };
  });
};
