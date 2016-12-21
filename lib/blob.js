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
  'delimiter'
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
    headersValueTosign: headersValueToSign
  };

  return utils.buildRequestOptionsForAuthSharedKey(authOptions, method, path, query, headers);
}

/*
 * Authorize the request with a shared-access-signature that is refreshed with
 * a function given as `options.sas`.
 * Intended to define `Blob.prototype.authorize`.
 */
function authorizeWithRefreshSAS(method, path, query, headers) {
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
    }).catch(function(err) {
      // If we have an error freshing SAS that's bad and we'll emit it; for most
      // apps it's probably best to ignore this error and just crash.
      self.emit('error', err);
    });
  }

  // Construct request options, whenever the `_sas` promise is resolved.
  return this._sas.then(function(sas) {
    var authOptions = {
      agent: self.options.agent,
      hostname: self.hostname,
      sas: sas
    };
    return utils.buildRequestOptionsForSAS(authOptions, method, path, query, headers);
  });
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

  // Initialize EventEmitter parent class
  events.EventEmitter.call(this);
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
 *   start:               new Date(), // Time from which signature is valid (optional)
 *   expiry:              new Date(), // Expiration of signature (required). Can be omitted if it is specified in the
 *                                    // associated stored access policy
 *   resourceType:        '...',      // Specifies which resources are accessible via the SAS. (required)
 *                                    // Possible values are: 'b' or 'c'.
 *                                    // Specify 'b' if the shared resource is a 'blob'. This grants access to the content and metadata of the blob.
 *                                    // Specify 'c' if the shared resource is a 'container'. This grants access to the content and metadata of any
 *                                    // blob in the container, and to the list of blobs in the container.
 *   permissions: {                   // Set of permissions delegated (required)
 *                                    // It must be omitted if it has been specified in the associated stored access policy.
 *     read:              false,      // Read the content, properties, metadata or block list of a blob or of
 *                                    // any blob in the container if the resourceType is a container.
 *     add:               false,      // Add a block to an append blob or to any append blob if the resourceType is a container.
 *     create:            false,      // Write a new blob, snapshot a blob, or copy a blob to a new blob. These operations can be done to any blob in the container
 *                                    // if the resourceType is a container.
 *     write:             false,      // Create or write content, properties, metadata, or block list. Snapshot or lease the blob. Resize the blob (page blob only).
 *                                    // These operations can be done for every blob in the container if the resourceType is a container
 *     delete:            false,      // Delete the blob or any blob in the container if the resourceType is a container.
 *     list:              false,      // List blobs in the container.
 *   },
 *   cacheControl:        '...',      // The value of the Cache-Control response header to be returned. (optional)
 *   contentDisposition:  '...',      // The value of the Content-Disposition response header to be returned. (optional)
 *   contentEncoding:     '...',      // The value of the Content-Encoding response header to be returned. (optional)
 *   contentLanguage:     '...',      // The value of the Content-Language response header to be returned. (optional)
 *   contentType:         '...',      // The value of the Content-Type response header to be returned. (optional)
 *   ipAddresses:         '...',      // An IP address or a range of IP addresses. (optional)
 *   accessPolicy:        '...'       // Reference to stored access policy (optional)
 *                                    // A GUID string
 * }
 * ```
 * @returns {string} Shared-Access-Signature on string form.
 *
 */
Blob.prototype.sas = function sas(container, blob, options){
  // verify the required options
  assert(options, "options is required");
  assert(options.resourceType, 'options.resourceType is required');
  assert(options.resourceType === 'b' || options.resourceType === 'c',
    'The possible values for options.resourceType are `b` or `c`');
  assert(options.permissions || options.accessPolicy, "options.permissions or options.accessPolicy must be specified");

  // Check that we have credentials
  if (!this.options.accountId ||
    !this.options.accessKey) {
    throw new Error("accountId and accessKey are required for SAS creation!");
  }

  // Construct query-string with required parameters
  var query = {
    sv:   SERVICE_VERSION,
    sr:   options.resourceType,
    spr:  'https'
  }

  if (options.expiry) {
    assert(options.expiry instanceof Date, "if specified expiry must be a Date object");
    query.se = utils.dateToISOWithoutMS(options.expiry);
  }

  if (options.permissions){
    // Construct permissions string (in correct order)
    var permissions = '';
    if (options.permissions.read)    permissions += 'r';
    if (options.permissions.add)     permissions += 'a';
    if (options.permissions.create)  permissions += 'c';
    if (options.permissions.write)   permissions += 'w';
    if (options.permissions.delete)  permissions += 'd';
    if (options.permissions.list && options.resourceType === 'c') permissions += 'l';

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

  if(options.ipAddresses){
    query.sip = options.ipAddresses;
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
    query.sip || '',
    query.spr,
    query.sv,
    query.rscc || '',
    query.rscd || '',
    query.rsce || '',
    query.rscl || '',
    query.rsct || ''
  ].join('\n');

  // Compute signature
  query.sig = crypto
    .createHmac('sha256', this._accessKey)
    .update(stringToSign)
    .digest('base64');

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
  if (data && data.length > 0) {
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
 * @param {object} metadata - Mapping from metadata keys to values.
 * @param {string} publicLevelAccess - Specifies whether data in the container may be accessed publicly and the level of access.
 *                                    Possible values: container, blob.
 * @returns {Promise} A promise that container has been created.
 */
Blob.prototype.createContainer = function createContainer(name, metadata, publicLevelAccess) {
  assert(name, 'The name of the container must be specified');
  // Construct headers
  var headers = {};
  for(var key in metadata) {
    if (metadata.hasOwnProperty(key)) {
      headers['x-ms-meta-' + key] = metadata[key];
    }
  }

  if(publicLevelAccess) {
    assert( publicLevelAccess === 'container' || publicLevelAccess === 'blob',
      'The `publicLevelAccess` is invalid. The possible values are: container and blob.'
    )
    headers['x-ms-blob-public-access'] = publicLevelAccess;
  }

  // Construct query string
  var query = {
    restype: 'container'
  };
  var path = '/' + name;
  return this.request('PUT', path, query, headers).then(function(response) {
    // container was created - response code 201
    if (response.statusCode === 201) {
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
 * @param {object} metadata - Mapping from metadata keys to values.
 * @param {string} leaseId - Lease unique identifier. A GUID string.(optional)
 * @returns {Promise} A promise that the metadata was set.
 */
Blob.prototype.setContainerMetadata = function setContainerMetadata(name, metadata, leaseId) {
  assert(name, 'The name of the container must be specified');
  // Construct query string
  var query = {
    restype: 'container',
    comp: 'metadata'
  };
  // Construct headers
  var headers = {};
  if (leaseId) {
    assert(utils.isValidGUID(leaseId), '`leaseId` is not a valid GUID.');
    headers['x-ms-lease-id'] = leaseId;
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
 * @param {string} leaseId - Lease unique identifier. A GUID string.(optional)
 * @returns {Promise} a promise for metadata key/value pair
 */
Blob.prototype.getContainerMetadata = function getContainerMetadata(name, leaseId) {
  assert(name, 'The name of the container must be specified');
  // Construct the query string
  var query = {
    comp: 'metadata',
    restype: 'container'
  }
  var path = "/" + name;
  var headers = {};
  if (leaseId) {
    assert(utils.isValidGUID(leaseId), '`leaseId` is not a valid GUID.');
    headers['x-ms-lease-id'] = leaseId;
  }
  return this.request('HEAD', path, query, headers).then(function(response) {
    if (response.statusCode !== 200) {
      throw new Error("getContainerMetadata: Unexpected statusCode: " + response.statusCode);
    }
    // Extract meta-data
    return utils.extractMetadataFromHeaders(response);
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
 * @param {string} leaseId - Lease unique identifier. A GUID string.(optional)
 * @returns {Promise} A promise that container has been marked for deletion.
 */
Blob.prototype.deleteContainer = function deleteContainer(name, leaseId) {
  assert(name, 'The name of the container must be specified');
  // construct query string
  var query = {
    restype: 'container'
  };
  var path = '/' + name;
  var headers = {};
  if (leaseId) {
    assert(utils.isValidGUID(leaseId), '`leaseId` is not a valid GUID.');
    headers['x-ms-lease-id'] = leaseId;
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
 * @param {string} leaseId - GUID string; lease unique identifier (optional)
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
Blob.prototype.getContainerProperties = function getContainerProperties(name, leaseId) {
  assert(name, 'The name of the container must be specified');
  var query = {
    restype: 'container'
  }
  var path = '/' + name;
  var headers = {};
  if (leaseId) {
    assert(utils.isValidGUID(leaseId), '`leaseId` is not a valid GUID.');
    headers['x-ms-lease-id'] = leaseId;
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
 * @param {string} leaseId - GUID string; lease unique identifier (optional)
 * @returns {Promise} A promise for permissions
 *  *```js
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
Blob.prototype.getContainerACL = function getContainerACL(name, leaseId){
  assert(name, 'The name of the container must be specified');
  var query = {
    restype: 'container',
    comp: 'acl'
  }
  var path = '/' + name;

  var headers = {};
  if (leaseId) {
    assert(utils.isValidGUID(leaseId), '`leaseId` is not a valid GUID.');
    headers['x-ms-lease-id'] = leaseId;
  }

  return this.request('GET', path, query, headers).then(function (response) {
    if (response.statusCode !== 200) {
      throw new Error("getContainerACL: Unexpected statusCode: " + response.statusCode);
    }
    return xml.blobParseContainerACL(response);
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
 *    }]
 * }
 * ```
 * @param {string} leaseId - GUID string; lease unique identifier (optional)
 * @returns {Promise} A promise that the permissions have been set
 */
Blob.prototype.setContainerACL = function setContainerACL(name, options, leaseId) {
  assert(name, 'The name of the container must be specified');
  var query = {
    restype: 'container',
    comp: 'acl'
  };
  var path = '/' + name;
  var headers = {};
  if (leaseId) {
    assert(utils.isValidGUID(leaseId), '`leaseId` is not a valid GUID.');
    headers['x-ms-lease-id'] = leaseId;
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
  options.accessPolicies.forEach(function(policy){
    assert(/^[0-9a-fA-F]{1,64}$/i.test(policy.id), 'The access policy id is not valid.' );

    data += '<SignedIdentifier><Id>' + policy.id + '</Id>';
    data += '<AccessPolicy>';
    if (policy.start) {
      data += '<Start>' + utils.dateToISOWithoutMS(policy.start) + '</Start>';
    }
    if (policy.expiry) {
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
  data += '</SignedIdentifiers>';

  return this.request('PUT', path, query, headers, data).then(function(response){
    if(response.statusCode !== 200){
      throw new Error("setContainerACL: Unexpected statusCode: " + response.statusCode);
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
  assert(container, 'The name of the container must be specified');
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
      var includeValue = '';
      if (options.include.snapshot) {
        includeValue += 'snapshot%82';
      }
      if (options.include.metadata) {
        includeValue += 'metadata%82';
      }
      if (options.include.uncommittedBlobs) {
        includeValue += 'uncommittedBlobs%82';
      }
      if (options.include.copy) {
        includeValue += 'copy%82';
      }
      query.include = includeValue;
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
 *    leaseId: '...',           // GUID string; it is required in case of renew, change, or release of the lease.
 *    leaseAction: '...',       // Lease container operation. The possible values are: acquire, renew, change, release, break (required)
 *    leaseBreakPeriod: '...',  // For a break operation, proposed duration the lease should continue before it is broken, in seconds, between 0 and 60.
 *    leaseDuration: '...',     // Specifies the duration of the lease, in seconds, or negative one (-1) for a lease that never expires.
 *                              // Required for acquire.
 *    proposedLeaseId: '...'    // GUID string; Optional for acquire, required for change.
 * }
 * ```
 * @returns {Promise} A promise for an object on the form:
 * ```js
 * {
 *    leaseId: '...',   // The unique lease id.
 *    leaseTime: '...'  // Approximate time remaining in the lease period, in seconds.
 * }
 * ```
 */
Blob.prototype.leaseContainer = function leaseContainer(name, options) {
  assert(name, 'The name of the container must be specified');
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

  assert(options.leaseAction === 'acquire' || options.leaseAction === 'renew' || options.leaseAction === 'change' || options.leaseAction === 'release' || options.leaseAction === 'break',
    'The supplied `options.leaseAction` is not valid. The possible values are: acquire, renew, change, release, break');
  headers['x-ms-lease-action'] = options.leaseAction;

  if((options.leaseAction === 'renew' || options.leaseAction === 'change' || options.leaseAction === 'release') && !options.leaseId) {
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

  return this.request('PUT', path, query, headers).then(function(response) {
    if (response.statusCode !== 200 && response.statusCode !== 201 && response.statusCode !== 202) {
      throw new Error("leaseContainer: Unexpected statusCode: " + response.statusCode);
    }

    var result = {
      leaseId: response.headers['x-ms-lease-id']
    };
    if (response.headers['x-ms-lease-time']) {
      result.leaseTime = response.headers['x-ms-lease-time'];
    }
    return result;
  });
};