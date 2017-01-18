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

/*
 * Authorize the request with shared key
 * Intended to define `Blob.prototype.authorize`.
 */
var authorizeWithSharedKey = function (method, path, query, headers) {
  var headersValueToSign = (
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
  var authOptions = {
    accountId: this.options.accountId,
    accessKey: this._accessKey,
    agent: this.options.agent,
    hostname: this.hostname,
    hasCanonicalizedHeaders: true,
    queryParamsSupported: QUERY_PARAMS_SUPPORTED,
    headersValueToSign: headersValueToSign
  };

  return utils.buildRequestOptionsForAuthSharedKey(authOptions, method, path, query, headers);
}

/*
 * Authorize the request with a shared-access-signature that is refreshed with
 * a function given as `options.sas`.
 * Intended to define `Blob.prototype.authorize`.
 */
function authorizeWithRefreshSAS(method, path, query, headers) {
  return utils.buildRequestOptionsForRefreshSAS(this, method, path, query, headers);
}

/**
 * Authorize the request with a shared-access-signature that is given with
 * `options.sas` as string.
 * Intended to define `Blob.prototype.authorize`.
 */
function authorizeWithSAS(method, path, query, headers) {
  var authOptions = {
    agent: this.options.agent,
    hostname: this.hostname,
    sas: this.options.sas
  };
  return utils.buildRequestOptionsForSAS(authOptions, method, path, query, headers);
}

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
    this.authorize = authorizeWithSharedKey;

    // Decode accessKey
    this._accessKey = new Buffer(this.options.accessKey, 'base64');
  } else if (this.options.sas instanceof Function) {
    // Set authorize to use shared-access-signatures with refresh function
    this.authorize = authorizeWithRefreshSAS;
    // Set state with _nextSASRefresh = -1, we'll refresh on the first request
    this._nextSASRefresh = -1;
    this._sas = '';
  } else if (typeof(this.options.sas) === 'string') {
    // Set authorize to use shared-access-signature as hardcoded
    this.authorize = authorizeWithSAS;
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
 * @param {string}  container - Name of the container that this SAS string applies to.
 * @param {string}  blob - Name of the blob that this SAS string applies to.
 * @param {object} options - Options for the following form:
 *  * ```js
 * {
 *   start:               new Date(),             // Time from which signature is valid (optional)
 *   expiry:              new Date(),             // Expiration of signature (required).
 *   resourceType:        'blob|container',       // Specifies which resources are accessible via the SAS. (required)
 *                                                // Possible values are: 'blob' or 'container'.
 *                                                // Specify 'blob' if the shared resource is a 'blob'. This grants access to the content and metadata of the blob.
 *                                                // Specify 'ccontainer' if the shared resource is a 'container'. This grants access to the content and metadata of any
 *                                                // blob in the container, and to the list of blobs in the container.
 *   permissions: {                               // Set of permissions delegated (required)
 *                                                // It must be omitted if it has been specified in the associated stored access policy.
 *     read:              false,                  // Read the content, properties, metadata or block list of a blob or of
 *                                                // any blob in the container if the resourceType is a container.
 *     add:               false,                  // Add a block to an append blob or to any append blob if the resourceType is a container.
 *     create:            false,                  // Write a new blob, snapshot a blob, or copy a blob to a new blob. These operations can be done to any blob in the container
 *                                                // if the resourceType is a container.
 *     write:             false,                  // Create or write content, properties, metadata, or block list. Snapshot or lease the blob. Resize the blob (page blob only).
 *                                                // These operations can be done for every blob in the container if the resourceType is a container
 *     delete:            false,                  // Delete the blob or any blob in the container if the resourceType is a container.
 *     list:              false,                  // List blobs in the container.
 *   },
 *   cacheControl:        '...',                  // The value of the Cache-Control response header to be returned. (optional)
 *   contentDisposition:  '...',                  // The value of the Content-Disposition response header to be returned. (optional)
 *   contentEncoding:     '...',                  // The value of the Content-Encoding response header to be returned. (optional)
 *   contentLanguage:     '...',                  // The value of the Content-Language response header to be returned. (optional)
 *   contentType:         '...',                  // The value of the Content-Type response header to be returned. (optional)
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
  query.sig = utils.getHmacSha256Sign(this._accessKey, stringToSign);

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
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    metadata: '...',          // Mapping from metadata keys to values. (optional)
 *    publicLevelAccess: '...', // Specifies whether data in the container may be accessed publicly and the level of access.
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
    if(options.publicLevelAccess) {
      assert( options.publicLevelAccess === 'container' || options.publicLevelAccess === 'blob',
        'The `publicLevelAccess` is invalid. The possible values are: container and blob.'
      )
      headers['x-ms-blob-public-access'] = options.publicLevelAccess;
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
      lastModified: response.headers['last-modified']
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
 *    ifModifiedSince: new Date(),  // Specify this to perform the operation only if the resource has been modified since the specified time. (optional)
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
    utils.setConditionalHeaders(headers, {
      ifModifiedSince: options.ifModifiedSince
    });
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
      lastModified: response.headers['last-modified']
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
      lastModified: response.headers['last-modified'],
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
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been modified since the specified date/time. (optional)
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

    utils.setConditionalHeaders(headers, {
      ifModifiedSince: options.ifModifiedSince,
      ifUnmodifiedSince: options.ifUnmodifiedSince,
    });
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
 * * @returns {Promise} A promise for an object on the form:
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
 *          publicAccessLevel: '...'  // Indicates whether data in the container may be accessed publicly and the level of access
 *                                    // If this is not returned in the response, the container is private to the account owner.
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
 *     publicAccessLevel: '...',  // Indicates whether data in the container may be accessed publicly and the level of access
 *                                // If this is not returned in the response, the container is private to the account owner.
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
    properties.lastModified = response.headers['last-modified'];
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
 *  *```js
 * {
 *    eTag: '...',                      // The entity tag of the container
 *    lastModified: '...',              // The date/time the container was last modified
 *    publicAccessLevel: '...',         // Indicate whether blobs in a container may be accessed publicly.(optional)
 *                                      // Possible values: container (full public read access for container and blob data)
 *                                      // or blob (public read access for blobs)
 *                                      // If it is not specified, the resource will be private and will be accessed only by the account owner
 *    accessPolicies: [{                // The container ACL settings. An array with five maximum access policies objects (optional)
 *      id:     '...',                  // Unique identifier, up to 64 chars in length
 *      start:  new Date(),             // Time from which access policy is valid
 *      expiry: new Date(),             // Expiration of access policy
 *      permission: {                   // Set of permissions delegated
 *        read:              false,     // Read the content, properties, metadata or block list of a blob or, of
 *                                      // any blob in the container if the resource is a container.
 *        add:               false,     // Add a block to an append blob or, to any append blob if the resource is a container.
 *        create:            false,     // Write a new blob, snapshot a blob, or copy a blob to a new blob. These operations can be done to any blob in the container
 *                                      // if the resource is a container.
 *        write:             false,     // Create or write content, properties, metadata, or block list. Snapshot or lease the blob. Resize the blob (page blob only).
 *                                      // These operations can be done for every blob in the container if the resource is a container
 *        delete:            false,     // Delete the blob or, any blob in the container if the resource is a container.
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
    var result = xml.blobParseContainerACL(response);
    if (response.headers['x-ms-blob-public-access']) {
      result.publicAccessLevel = response.headers['x-ms-blob-public-access'];
    }
    result.eTag = response.headers['etag'];
    result.lastModified = response.headers['last-modified'];
    return result;
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
 *    publicAccessLevel: '...',         // Indicate whether blobs in a container may be accessed publicly.(optional)
 *                                      // Possible values: container (full public read access for container and blob data)
 *                                      // or blob (public read access for blobs)
 *                                      // If it is not specified, the resource will be private and will be accessed only by the account owner
 *    accessPolicies: [{                // The container ACL settings. An array with five maximum access policies objects (optional)
 *      id:     '...',                  // Unique identifier, up to 64 chars in length
 *      start:  new Date(),             // Time from which access policy is valid
 *      expiry: new Date(),             // Expiration of access policy
 *      permission: {                   // Set of permissions delegated
 *        read:              false,     // Read the content, properties, metadata or block list of a blob or of
 *                                      // any blob in the container if the resourceType is a container.
 *        add:               false,     // Add a block to an append blob or to any append blob if the resourceType is a container.
 *        create:            false,     // Write a new blob, snapshot a blob, or copy a blob to a new blob. These operations can be done to any blob in the container
 *                                      // if the resourceType is a container.
 *        write:             false,     // Create or write content, properties, metadata, or block list. Snapshot or lease the blob. Resize the blob (page blob only).
 *                                      // These operations can be done for every blob in the container if the resourceType is a container
 *        delete:            false,     // Delete the blob or any blob in the container if the resourceType is a container.
 *        list:              false,     // List blobs in the container.
 *      }
 *    }],
 *    leaseId: '...',                   // GUID string; lease unique identifier (optional)
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been modified since the specified date/time. (optional)
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

    utils.setConditionalHeaders(headers, {
      ifModifiedSince: options.ifModifiedSince,
      ifUnmodifiedSince: options.ifUnmodifiedSince
    });
  }

  return this.request('PUT', path, query, headers, data).then(function(response){
    if(response.statusCode !== 200){
      throw new Error("setContainerACL: Unexpected statusCode: " + response.statusCode);
    }

    return {
      eTag: response.headers['etag'],
      lastModified: response.headers['last-modified']
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
 *       snapshot:    '...',              // A date and time value that uniquely identifies the snapshot relative to its base blob
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
 *          serverEncrypted: false,       // true if the blob and application metadata are completely encrypted, and false otherwise
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
      throw new Error("setContainerACL: Unexpected statusCode: " + response.statusCode);
    }
    return xml.blobParseListBlobs(response);
  });
};

/**
 * Establishes and manages a lock on a container for delete operations. The lock duration can be 15 to 60 seconds, or can be infinite.
 *
 * @method leaseContainer
 * @param name - Name of the container
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    leaseId: '...',                   // GUID string; it is required in case of renew, change, or release of the lease.
 *    leaseAction: '...',               // Lease container operation. The possible values are: acquire, renew, change, release, break (required)
 *    leaseBreakPeriod: '...',          // For a break operation, proposed duration the lease should continue before it is broken, in seconds, between 0 and 60.
 *    leaseDuration: '...',             // Specifies the duration of the lease, in seconds, or negative one (-1) for a lease that never expires.
 *                                      // Required for acquire.
 *    proposedLeaseId: '...'            // GUID string; Optional for acquire, required for change.
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been modified since the specified date/time. (optional)
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

  utils.setConditionalHeaders(headers, {
    ifModifiedSince: options.ifModifiedSince,
    ifUnmodifiedSince: options.ifUnmodifiedSince
  });

  return this.request('PUT', path, query, headers).then(function(response) {
    if (response.statusCode !== 200 && response.statusCode !== 201 && response.statusCode !== 202) {
      throw new Error("leaseContainer: Unexpected statusCode: " + response.statusCode);
    }

    var result = {
      leaseId: response.headers['x-ms-lease-id'],
      eTag: response.headers['etag'],
      lastModified: response.headers['last-modified']
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
 * @method putTextBlob
 * @param {string} container - Name of the container where the blob should be stored
 * @param {string} blob - Name of the blob
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    metadata: '...',                          // Name-value pairs associated with the blob as metadata
 *    contentType: 'application/octet-stream',  // The MIME content type of the blob (optional)
 *    contentEncoding: '...',                   // Specifies which content encodings have been applied to the blob. (optional)
 *    contentLanguage: '...',                   // Specifies the natural languages used by this resource. (optional)
 *    cacheControl: '...',                      // The Blob service stores this value but does not use or modify it. (optional)
 *    disableContentMD5Check: 'false',          // Enable/disable the content md5 check is disabled.(optional)
 *    blobType: BlockBlob|PageBlob|AppendBlob,  // The type of blob to create: block blob, page blob, or append blob (required)
 *    leaseId: '...',                           // Lease id (required if the blob has an active lease)
 *    contentDisposition: '...',                // Specifies the content disposition of the blob (optional)
 *    ifModifiedSince: new Date(),              // Specify this to perform the operation only if the resource has been modified since the specified time.
 *    ifUnmodifiedSince: new Date(),            // Specify this to perform the operation only if the resource has not been modified since the specified date/time.
 *    ifMatch: '...',                           // ETag value. Specify this to perform the operation only if the resource's ETag matches the value specified.
 *    ifNoneMatch: '...',                       // ETag value. Specify this to perform the operation only if the resource's ETag does not match the value specified.
 *    pageBlobContentLength: '...',             // Specifies the maximum size for the page blob, up to 1 TB. (required for page blobs)
 *    pageBlobSequenceNumber: 0,                // The sequence number - a user-controlled value that you can use to track requests (optional, only for page blobs)
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
  assert(options.blobType, 'The blob type must be specified');
  assert(options.blobType === 'BlockBlob'
    || options.blobType === 'PageBlob'
    || options.blobType === 'AppendBlob',
    'The blob type is invalid. The possible types are: BlockBlob, PageBlob or AppendBlob.');

  if (options.blobType === 'PageBlob' && content) {
    throw new Error('Do not include content when a page blob is created. Use putPage() to add/modify the content of a page blob');
  }
  if(options.blobType === 'AppendBlob' && content) {
    throw new Error('Do not include content when an append blob is created. Use appendBlock() to add content to the end of the append blob');
  }

  if ((options.blobType === 'BlockBlob'
    || options.blobType === 'AppendBlob')) {

    if (options.pageBlobContentLength) {
      throw new Error('Do not include page blob content length to a block blob or to an append blob.');
    }
    if (options.pageBlobSequenceNumber) {
      throw new Error('Do not include page blob sequence number to a block blob or to an append blob.');
    }
  }

  // check the content length
  var contentLength = !content ? 0 : ((Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content)));
  if (options.blobType === 'blockBlob'
    && contentLength > MAX_SINGLE_UPLOAD_BLOCK_BLOB_SIZE_IN_BYTES) {
    throw new Error('The maximum size of a block blob that can be uploaded with putBlob() is ' + MAX_SINGLE_UPLOAD_BLOCK_BLOB_SIZE_IN_BYTES + '.' +
      'In order to upload larger blobs, use putBlock() and putBlockList()');
  }
  if (options.blobType === 'PageBlob'){
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

  headers['content-length'] = options.blobType === 'PageBlob' || options.blobType === 'AppendBlob' ? 0 : contentLength;

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

  headers['x-ms-blob-type'] = options.blobType;

  if (!options.disableContentMD5Check && options.blobType === 'BlockBlob' && content) {
    headers['content-md5'] = utils.getContentMD5(content);
  }

  if (options.contentDisposition) {
    headers['x-ms-blob-content-disposition'] = options.contentDisposition;
  }

  // support for condition headers
  utils.setConditionalHeaders(headers, {
    ifModifiedSince: options.ifModifiedSince,
    ifUnmodifiedSince: options.ifUnmodifiedSince,
    ifMatch: options.ifMatch,
    ifNoneMatch: options.ifNoneMatch
  });

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
      lastModified: response.headers['last-modified'],
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
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been modified since the specified date/time. (optional)
 *    ifMatch: '...',                   // ETag value. Specify this to perform the operation only if the resource's ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',               // ETag value. Specify this to perform the operation only if the resource's ETag does not match the value specified. (optional)
 * }
 *```
 * @result {Promise} A promise for an object on the form:
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
 *    blobType: '...',                // The blob type: block, page or append blob.
 *    blobCommittedBlockCount: '...', // The number of committed blocks present in the blob. This is returned only for append blobs.
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

  utils.setConditionalHeaders(options);

  return this.request('GET', path, query, headers).then(function (response) {
    if (response.statusCode !== 200) {
      throw new Error("getBlob: Unexpected statusCode: " + response);
    }
    var responseHeaders = response.headers;
    var result = {
      blobType: responseHeaders['x-ms-blob-type'],
      eTag: responseHeaders['etag'],
      lastModified: responseHeaders['last-modified'],
      content: response.payload
    };

    if (responseHeaders['content-md5']) result.contentMD5 = responseHeaders['content-md5'];
    if (responseHeaders['content-encoding']) result.contentEncoding = responseHeaders['content-encoding'];
    if (responseHeaders['content-language']) result.contentLanguage = responseHeaders['content-language'];
    if (responseHeaders['cache-control']) result.cacheControl = responseHeaders['cache-control'];
    if (responseHeaders['content-disposition']) result.contentDisposition = responseHeaders['content-disposition'];
    if (responseHeaders['x-ms-blob-sequence-number']) result.pageBlobSequenceNumber = responseHeaders['x-ms-blob-sequence-number'];
    if (responseHeaders['x-ms-blob-committed-block-count']) result.blobCommittedBlockCount = responseHeaders['x-ms-blob-committed-block-count'];

    utils.extractMetadataFromHeaders(response);

    return result;
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
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been modified since the specified date/time. (optional)
 *    ifMatch: '...',                   // ETag value. Specify this to perform the operation only if the resource's ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',               // ETag value. Specify this to perform the operation only if the resource's ETag does not match the value specified. (optional)
 * }
 *```
 *
 * @return {Promise} A promise for an object on the form:
 * ```js
 * {
 *    metadata: '...',                // Name-value pairs that correspond to the user-defined metadata associated with this blob.
 *    lastModified: '...',            // The date/time the blob was last modified.
 *    blobType: '...',                // The blob type
 *    leaseDuration: '...',           // When a blob is leased, specifies whether the lease is of infinite or fixed duration
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
      blobType: response.headers['x-ms-blob-type'],
      leaseState: response.headers['x-ms-lease-state'],
      leaseStatus: response.headers['x-ms-lease-status'],
      contentLength: response.headers['content-length'],
      contentType: response.headers['content-type'],
      eTag: response.headers['etag']
    };
    if (response.headers['last-modified']) {
      result.lastModified = response.headers['last-modified'];
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
 *    cacheControl: '...',                                    // The cache control string for the blob (optional)
 *                                                            // If this property is not specified, then the property will be cleared for the blob
 *    contentType: '...',                                     // The MIME content type of the blob (optional)
 *                                                            // If this property is not specified, then the property will be cleared for the blob
 *    contentMD5: '...',                                      // The MD5 hash of the blob (optional)
 *                                                            // If this property is not specified, then the property will be cleared for the blob
 *    contentEncoding: '...',                                 // The content encodings of the blob. (optional)
 *                                                            // If this property is not specified, then the property will be cleared for the blob
 *    contentLanguage: '...',                                 // The content language of the blob. (optional)
 *                                                            // If this property is not specified, then the property will be cleared for the blob
 *    contentDisposition: '...',                              // The content disposition (optional)
 *                                                            // If this property is not specified, then the property will be cleared for the blob
 *    pageBlobContentLength: '...',                           // The new size of a page blob. If the specified value is less than the
 *                                                            // current size of the blob, then all pages above the specified value are cleared.
 *                                                            // This property applies to page blobs only.
 *    pageBlobSequenceNumberAction: 'max|update|increment',   // Indicates how the service should modify the blob's sequence number.
 *                                                            // - max: Sets the sequence number to be the higher of the value included with the request and the value currently stored for the blob.
 *                                                            // - update: Sets the sequence number to the value included with the request.
 *                                                            // - increment: Increments the value of the sequence number by 1.
 *                                                            // This property applies to page blobs only. (optional)
 *    pageBlobSequenceNumber: '...',                          // The page blob sequence number
 *                                                            // Optional, but required if the `pageBlobSequenceNumberAction` option is set to `max` or `update`.
 *                                                            // This property applies to page blobs only.
 *    ifModifiedSince: new Date(),                            // Specify this to perform the operation only if the resource has been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),                          // Specify this to perform the operation only if the resource has not been modified since the specified date/time. (optional)
 *    ifMatch: '...',                                         // ETag value. Specify this to perform the operation only if the resource's ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',                                     // ETag value. Specify this to perform the operation only if the resource's ETag does not match the value specified. (optional)
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

    utils.setConditionalHeaders(headers, {
      ifModifiedSince: options.ifModifiedSince,
      ifUnmodifiedSince: options.ifUnmodifiedSince,
      ifMatch: options.ifMatch,
      ifNoneMatch: options.ifNoneMatch
    });
  }

  return this.request('PUT', path, query, headers).then(function (response) {
    if (response.statusCode !== 200) {
      throw new Error("setBlobProperties: Unexpected statusCode: " + response);
    }

    var result = {
      eTag: response.headers['etag'],
      lastModified: response.headers['last-modified']
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
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been modified since the specified date/time. (optional)
 *    ifMatch: '...',                   // ETag value. Specify this to perform the operation only if the resource's ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',               // ETag value. Specify this to perform the operation only if the resource's ETag does not match the value specified. (optional)
 * }
 *```
 *
 * @returns {Promise} a promise for metadata key/value pair
 * A promise for an object on the form:
 * ```js
 * {
 *      eTag: '...',               // The entity tag of the blob
 *      lastModified: '...',       // The date/time the blob was last modified
 *      metadata: '...'            // Name-value pairs that correspond to the user-defined metadata associated with this blob.
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
      lastModified: response.headers['last-modified'],
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
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been modified since the specified date/time. (optional)
 *    ifMatch: '...',                   // ETag value. Specify this to perform the operation only if the resource's ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',               // ETag value. Specify this to perform the operation only if the resource's ETag does not match the value specified. (optional)
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

  if (options) {
    utils.setConditionalHeaders(headers, {
      ifModifiedSince: options.ifModifiedSince,
      ifUnmodifiedSince: options.ifUnmodifiedSince,
      ifMatch: options.ifMatch,
      ifNoneMatch: options.ifNoneMatch
    });
  }

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
      lastModified: response.headers['last-modified']
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
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been modified since the specified date/time. (optional)
 *    ifMatch: '...',                   // ETag value. Specify this to perform the operation only if the resource's ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',               // ETag value. Specify this to perform the operation only if the resource's ETag does not match the value specified. (optional)
 * }
 *```
 * * @return {Promise} A promise that container has been marked for deletion.
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
 *                                     // For a given blob, the length of the value specified for the blockId must be the same size for each block.(required)
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

  var contentLength = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
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
    headers['content-md5'] = utils.getContentMD5(content);
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
 * In order to be written as part of a blob, a block must have been successfully written to the server in a prior putBlock operation.
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
 *    metadata: '...',                  // Name-value pairs that correspond to the user-defined metadata associated with this blob.
 *    contentDisposition: '...',        // Blob's content disposition
 *    ifModifiedSince: new Date(),      // Specify this to perform the operation only if the resource has been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),    // Specify this to perform the operation only if the resource has not been modified since the specified date/time. (optional)
 *    ifMatch: '...',                   // ETag value. Specify this to perform the operation only if the resource's ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',               // ETag value. Specify this to perform the operation only if the resource's ETag does not match the value specified. (optional)
 *    committedBlockIds: [],            // List of block ids to indicate that the Blob service should search only the committed block list for the named blocks(optional)
 *    uncommittedBlockIds: [],          // List of block ids to indicate that the Blob service should search only the uncommitted block list for the named blocks (optional)
 *    latestBlockIds: [],               // List of block ids to indicate that the Blob service should first search the uncommitted block list.
 *                                      // If the block is found in the uncommitted list, that version of the block is the latest and should
 *                                      // be written to the blob. If the block is not found in the uncommitted list, then the service should
 *                                      // search the committed block list for the named block and write that block to the blob if it is found. (optional)
 * }
 *
 * @result {Promise} - A promise for an object on the form:
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
    utils.setConditionalHeaders(headers, {
      ifModifiedSince: options.ifModifiedSince,
      ifUnmodifiedSince: options.ifUnmodifiedSince,
      ifMatch: options.ifMatch,
      ifNoneMatch: options.ifNoneMatch
    })
  }

  return this.request('PUT', path, query, headers, data).then(function(response) {
    if(response.statusCode !== 201) {
      throw new Error('putBlockList: Unexpected statusCode: ' + response.statusCode);
    }
    return {
      eTag: response.headers['etag'],
      lastModified: response.headers['last-modified'],
    }
  });
};

/**
 * Retrieves the list of committed list blocks (that that have been successfully committed to a given blob with putBlockList()),
 * and uncommitted list blocks (that have been uploaded for a blob using Put Block, but that have not yet been committed)
 *
 * @method getBlockList
 * @param {string} container - Name of the container
 * @param {string} blob - Name of the blob
 * @param {object} options - Options on the following form
 * ```js
 * {
 *    blockListType: 'committed'  // Specifies whether to return the list of committed blocks, the list of
 *                                // uncommitted blocks, or both lists together. Valid values are committed, uncommitted, or all
 * }
 *```
 * @result {Promise} A promise for an object on the form:
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
 * @param prefix - the prefix of the block id
 * @param blockNumber - the block number
 * @param length - length of the block id
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
 *    blobConditionAppendPositionOffset: '...', //  A number indicating the byte offset to compare (optional)
 *    ifModifiedSince: new Date(),              // Specify this to perform the operation only if the resource has been modified since the specified time. (optional)
 *    ifUnmodifiedSince: new Date(),            // Specify this to perform the operation only if the resource has not been modified since the specified date/time. (optional)
 *    ifMatch: '...',                           // ETag value. Specify this to perform the operation only if the resource's ETag matches the value specified. (optional)
 *    ifNoneMatch: '...',                       // ETag value. Specify this to perform the operation only if the resource's ETag does not match the value specified. (optional)
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

  var contentLength = !content ? 0 : ((Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content)));
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
      headers['content-md5'] = utils.getContentMD5(content);
    }
    if (options.blobConditionMaxSize) {
      headers['x-ms-blob-condition-maxsize'] = options.blobConditionMaxSize;
    }
    if (options.blobConditionAppendPositionOffset) {
      assert(typeof options.blobConditionAppendPositionOffset === 'number',
        'The `options.blobConditionAppendPositionOffset` must be a number');
      headers['x-ms-blob-condition-appendpos'] = options.blobConditionAppendPositionOffset;
    }
    utils.setConditionalHeaders(headers, {
      ifModifiedSince: options.ifModifiedSince,
      ifUnmodifiedSince: options.ifUnmodifiedSince,
      ifMatch: options.ifMatch,
      ifNoneMatch: options.ifNoneMatch
    })
  }

  return this.request('PUT', path, query, headers, content).then(function(response) {
    if(response.statusCode !== 201) {
      throw new Error('appendBlock: Unexpected statusCode: ' + response.statusCode);
    }

    return {
      eTag: response.headers['etag'],
      lastModified: response.headers['last-modified'],
      contentMD5: response.headers['content-md5'],
      appendOffset: response.headers['x-ms-blob-append-offset'],
      committedBlockCount: response.headers['x-ms-blob-committed-block-count']
    };
  });
};