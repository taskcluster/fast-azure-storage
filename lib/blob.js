'use strict';

var assert            = require('assert');
var crypto            = require('crypto');
var debug             = require('debug')('azure:blob');
var Promise           = require('promise');
var utils             = require('./utils');
var querystring       = require('querystring');
var xml               = require('./xml-parser');
var Constants         = require('./constants');
var HttpConstants     = Constants.HttpConstants;
var HttpVerbs         = HttpConstants.HttpVerbs;
var HttpResponseCodes = HttpConstants.HttpResponseCodes;

/*
 * Azure storage service version
 * @const
 */
var SERVICE_VERSION = '2015-12-11';

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
  'restype'
].sort();

/*
 * Authorize the request with shared key
 * Intended to define `Blob.prototype.authorize`.
 */
var authorizeWithSharedKey = function (method, path, query, headers) {
  // Find account id
  var accountId = this.options.accountId;

  // Build string to sign
  var stringToSign = (
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

  var fields;
  // Construct fields as a sorted list of 'x-ms-' prefixed headers
  fields = [];
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
  var M = QUERY_PARAMS_SUPPORTED.length;
  for(var j = 0; j < M; j++) {
    var param = QUERY_PARAMS_SUPPORTED[j];
    var value = query[param];
    if (value) {
      stringToSign += '\n' + param + ':' + value;
    }
  }

  // Compute signature
  var signature = crypto
    .createHmac('sha256', this._accessKey)
    .update(stringToSign)
    .digest('base64');

  // Set authorization header
  headers.authorization = 'SharedKey ' + accountId + ':' + signature;

  // Encode query string
  var qs = querystring.stringify(query);

  // Construct request options
  return Promise.resolve({
    host:       this.hostname,
    method:     method,
    path:       (qs.length > 0 ? path + '?' + qs : path),
    headers:    headers
  });
}

function Blob(options) {
  // Set default options
  this.options = {
    version:              SERVICE_VERSION,
    clientId:             'fast-azure-storage',
    timeout:              30 * 1000,
    clientTimeoutDelay:   500,
    retries:              5,
    delayFactor:          100,
    maxDelay:             30 * 1000,
    transientErrorCodes:  TRANSIENT_ERROR_CODES,
    accountId:            undefined,
    accessKey:            undefined,
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
    this.authorize = authorizeWithSharedKey;
    // Decode accessKey
    this._accessKey = new Buffer(this.options.accessKey, 'base64');
  } else {
    throw new Error("Either options.accessKey, options.sas as function or " +
      "options.sas as string must be given!");
  }
};

// Export Blob
module.exports = Blob;

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
        // TODO rename the function to something generic
        var data = xml.queueParseError(res);

        // Construct error object
        var err         = new Error(data.message);
        err.name        = data.code + 'Error';
        err.code        = data.code;
        err.statusCode  = res.statusCode;
        err.message     = data.message;
        err.retries     = retry;

        debug("Error code: %s for %s %s on retry: %s",
          err.code, method, path, retry);

        // Throw the constructed error
        throw err;
      });
    }, self.options);
  });
};

/**
 * Create a new container with the given 'name' under the storage account.
 *
 * @method createContainer
 * @param {string} name -  Name of the container to create
 * @param {object} metadata - A name-value pair to associate with the container as metadata.
 * @param {string} publicLevelAccess - Specifies whether data in the container may be accessed publicly and the level of access.
 *                                    Possible values: container, blob.
 * @returns {Promise} A promise that container has been created.
 */
Blob.prototype.createContainer = function createContainer(name, metadata, publicLevelAccess) {
  // Construct headers
  var headers = {};
  for(var key in metadata) {
    if (metadata.hasOwnProperty(key)) {
      headers['x-ms-meta-' + key] = metadata[key];
    }
  }

  if(publicLevelAccess && publicLevelAccess === 'container' || publicLevelAccess === 'blob') {
    headers['x-ms-blob-public-access'] = publicLevelAccess;
  }

  // Construct query string
  var query = {
    restype: 'container'
  };
  var path = '/' + name;
  return this.request(HttpVerbs.PUT, path, query, headers).then(function(response) {
    // container was created - response code 201
    if (response.statusCode === HttpResponseCodes.Created) {
      return true;
    }

    throw new Error("createContainer: Unexpected statusCode: " + response.statusCode);
  });
};

/**
 * Sets metadata for the specified container.
 * Overwrites all existing metadata that is associated with the container.
 *
 * @method setContainerMetadata
 * @param {string} name - Name of the container to set metadata on
 * @param {object} metadata - A name-value pair to associate with the container as metadata.
 * @returns {Promise} A promise that the metadata was set.
 */
Blob.prototype.setContainerMetadata = function setContainerMetadata(name, metadata) {
  // Construct query string
  var query = {
    restype: 'container',
    comp: 'metadata'
  };
  // Construct headers
  var headers = {};
  for(var key in metadata) {
    if (metadata.hasOwnProperty(key)) {
      headers['x-ms-meta-' + key] = metadata[key];
    }
  }
  var path = "/" + name;
  return this.request(HttpVerbs.PUT, path, query, headers).then(function(response) {
    if(response.statusCode !== HttpResponseCodes.Ok) {
      throw new Error('setContainerMetadata: Unexpected statusCode: ' + response.statusCode);
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
 * @param name - the name of the container to get metadata from.
 * @returns {Promise} a promise for metadata key/value pair
 */
Blob.prototype.getContainerMetadata = function getContainerMetadata(name) {
  // Construct the query string
  var query = {
    comp: 'metadata',
    restype: 'container'
  }
  var path = "/" + name;
  return this.request(HttpVerbs.HEAD, path, query, {}).then(function(response) {
    if (response.statusCode !== HttpResponseCodes.Ok) {
      throw new Error("getContainerMetadata: Unexpected statusCode: " + response.statusCode);
    }
    // Extract meta-data
    var metadata = {};
    var rawHeaderCounter = 0;
    for(var field in response.headers) {
      rawHeaderCounter++;
      if (/x-ms-meta-/.test(field)) {
        // Metadata names must adhere to the naming rules for C# identifiers, which are case-insensitive,
        // meaning that you can set,for example, a metadata with the following form:
        // {
        //    applicationName: 'fast-azure-blob-storage'
        // }
        // In order to return the original metadata name, the header names should be read from response.rawHeaders.
        // That is because 'https' library returns the response headers with lowercase.
        var key = response.rawHeaders[rawHeaderCounter * 2 - 2];
        metadata[key.substr(10)] = response.headers[field];
      }
    }

    return metadata;
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
 * @param {object} name -  Name of the container to delete
 * @returns {Promise} A promise that container has been marked for deletion.
 */
Blob.prototype.deleteContainer = function deleteContainer(name) {
  // construct query string
  var query = {
    restype: 'container'
  };
  var path = '/' + name;
  // TODO conditional headers
  return this.request(HttpVerbs.DELETE, path, query, {}).then(function(response) {
    if(response.statusCode !== HttpResponseCodes.Accepted) {
      throw new Error('deleteContainer: Unexpected statusCode: ' + response.statusCode);
    }
  });
};