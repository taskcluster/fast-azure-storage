'use strict';

var assert      = require('assert');
var _           = require('lodash');
var debug       = require('debug')('azure:queue');
var Promise     = require('promise');
var querystring = require('querystring');
var crypto      = require('crypto');
var events      = require('events');
var util        = require('util');
var libxml      = require('libxmljs');
var agent       = require('./agent');
var utils       = require('./utils');

/* Transient error codes (we'll retry request when encountering these codes */
var TRANSIENT_ERROR_CODES = [
  // Error code for when we encounter a 5xx error, but the XML document doesn't
  // have a code property, or we fail to parse the XML payload. This is unlikely
  // to happen unless you have an HTTP proxy that returns 5xx for some reason.
  'InternalErrorWithoutCode',

  // Azure error codes we should retry on according to azure docs
  'InternalError',
  'ServerBusy'
].concat(utils.TRANSIENT_HTTP_ERROR_CODES);

/*
 * List of x-ms-* headers supported in lexicographical order, used for
 * construction of the canonicalized headers.
 */
var X_MS_HEADERS_SUPPORTED = [
  'x-ms-client-request-id',
  'x-ms-date',
  'x-ms-version'
].sort();

/*
 * List of query-string parameter supported in lexicographical order, used for
 * construction of the canonicalized resource.
 */
var QUERY_PARAMS_SUPPORTED = [
  'timeout',
  'comp',
  'prefix',
  'marker',
  'maxresults',
  'include',
  'messagettl',
  'visibilitytimeout',
  'numofmessages',
  'peekonly',
  'popreceipt'
].sort();

/*
 * Authorize the request with shared key
 * Intended to define `Queue.prototype.authorize`.
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

  // Check if we have meta-data header fields, if we don't we can use a
  // presorted list of headers which doesn't involve any allocations.
  // Otherwise, we callback to building a list of 'x-ms-' prefixed headers and
  // sorting it.
  var hasMetadata = false;
  for (var field in headers) {
    hasMetadata = hasMetadata || /^x-ms-meta/.test(field);
  }
  var fields;
  if (hasMetadata) {
    // Construct fields as a sorted list of 'x-ms-' prefixed headers
    fields = [];
    for (var field in headers) {
      if (/^x-ms-/.test(field)) {
        fields.push(field);
      }
    }
    fields.sort();
  } else {
    // Fields used in most API methods presorted in lexicographical order.
    fields = X_MS_HEADERS_SUPPORTED;
  }

  // Add lines for canonicalized headers using presorted list of fields
  var N = fields.length;
  for(var i = 0; i < N; i++) {
    var field = fields[i];
    var value = headers[field];
    if (value) {
      stringToSign += '\n' + field + ':' + value;
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
    host:       this._hostname,
    method:     method,
    path:       (qs.length > 0 ? path + '?' + qs : path),
    headers:    headers,
    agent:      this.options.agent,
  });
}

/*
 * Authorize the request with a shared-access-signature that is refreshed with
 * the a function given as `options.sas`.
 * Intended to define `Queue.prototype.authorize`.
 */
function authorizeWithRefreshSAS(method, path, query, headers) {
  var self = this;
  // Check if we should refresh SAS
  if (Date.now() > this._nextSASRefresh && this._nextSASRefresh !== 0) {
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
    // Serialize query-string
    var qs = querystring.stringify(query);
    if (qs.length > 0) {
      qs += '&';
    }
    qs += sas
    return {
      host:       self._hostname,
      method:     method,
      path:       path + '?' + qs,
      headers:    headers,
      agent:      self.options.agent,
    };
  });
}

/*
 * Authorize the request with a shared-access-signature that is given with
 * `options.sas` as string.
 * Intended to define `Queue.prototype.authorize`.
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
    host:       this._hostname,
    method:     method,
    path:       path + '?' + qs,
    headers:    headers,
    agent:      this.options.agent,
  });
}

/**
 * Queue client class.
 *
 * @constructor
 * @param {object} options - options on the form:
 * ```js
 * {
 *   // Value for the x-ms-version header fixing the API version
 *   version:              '2014-02-14',
 *
 *   // Value for the x-ms-client-request-id header identifying the client
 *   clientId:             'fast-azure-storage',
 *
 *   // Server-side request timeout
 *   timeout:              30,
 *
 *   // HTTP Agent to use (defaults to a global azure.Agent instance)
 *   agent:                azure.Agent.globalAgent,
 *
 *   // Max number of request retries
 *   retries:              5,
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
function Queue(options) {
  // Set default options
  options = _.defaults({}, options, {
    version:              '2014-02-14',
    clientId:             'fast-azure-storage',
    timeout:              30,
    agent:                agent.globalAgent,
    retries:              5,
    delayFactor:          100,
    maxDelay:             30 * 1000,
    transientErrorCodes:  TRANSIENT_ERROR_CODES,
    accountId:            undefined,
    accessKey:            undefined,
    sas:                  undefined,
    minSASAuthExpiry:     15 * 60 * 1000,
  });

  // Validate options
  assert(options.accountId, "`options.accountId` must be given");

  // Construct hostname
  this._hostname  = options.accountId + '.queue.core.windows.net';

  // Save options
  this.options = options;

  // Define `this.authorize`
  if (options.accessKey) {
    // If set authorize to use shared key signatures
    this.authorize = authorizeWithSharedKey;
    // Decode accessKey
    this._accessKey = new Buffer(options.accessKey, 'base64');
  } else if (options.sas instanceof Function) {
    // Set authorize to use shared-access-signatures with refresh function
    this.authorize = authorizeWithRefreshSAS;
    // Set state with _nextSASRefresh = -1, we'll refresh on the first request
    this._nextSASRefresh = -1;
    this._sas = '';
  } else if (typeof(options.sas) === 'string') {
    // Set authorize to use shared-access-signature as hardcoded
    this.authorize = authorizeWithSAS;
  } else {
    throw new Error("Either options.accessKey, options.sas as function or " +
                    "options.sas as string must be given!");
  }
};

// Export Queue
module.exports = Queue;

// Subclass EventEmitter
util.inherits(Queue, events.EventEmitter);

/**
 * Generate a SAS string on the form `'key1=val1&key2=val2&...'`.
 *
 * @param {string} queue - Name of queue that this SAS string applies to.
 * @param {object} options - Options for the following form:
 * ```js
 * {
 *   start:           new Date(), // Time from which signature is valid
 *   expiry:          new Date(), // Expiration of signature (required)
 *   permissions: {               // Set of permissions delegated (required)
 *     read:          false,      // Read meta-data and peek messages
 *     add:           false,      // Add new messages
 *     update:        false,      // Update messages (after get messages)
 *     process:       false       // Process messages (get and delete messages)
 *   },
 *   accessPolicy:    '...'       // Reference to stored access policy
 * }
 * ```
 * @returns {string} Shared-Access-Signature on string form.
 */
Queue.prototype.sas = function sas(queue, options) {
  assert(options, "options is required");
  assert(options.expiry instanceof Date,
         "options.expiry must be a Date object");
  assert(options.permissions, "options.permissions is required");

  // Check that we have credentials
  if (!this.options.accountId ||
      !this.options.accessKey) {
    throw new Error("accountId and accessKey are required for SAS creation!");
  }

  // Construct permissions string (in correct order)
  var permissions = '';
  if (options.permissions.read)     permissions += 'r';
  if (options.permissions.add)      permissions += 'a';
  if (options.permissions.update)   permissions += 'u';
  if (options.permissions.process)  permissions += 'p';

  // Construct query-string with required parameters
  var query = {
    sv:   '2014-02-14',
    se:   utils.dateToISOWithoutMS(options.expiry),
    sp:   permissions,
    sig:  null
  };

  // Add optional parameters to query-string
  if (options.start) {
    assert(options.start instanceof Date,
           "if specified start must be a Date object");
    query.st = utils.dateToISOWithoutMS(options.start);
  }
  if (options.accessPolicy) {
    query.se = options.accessPolicy;
  }

  // Construct string to sign
  var stringToSign = [
    query.sp,
    query.st  || '',
    query.se,
    '/' + this.options.accountId.toLowerCase() + '/' + queue,
    query.si  || '',
    query.sv
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
 * @param {string} method - HTTP verb in upper case, e.g. `GET`.
 * @param {string} path - Path on queue resource for storage account.
 * @param {object} query - Query-string parameters.
 * @param {object} header - Mapping from header key in lowercase to value.
 * @returns {Promise} A promise for an options object compatible with
 * `https.request`.
 */
Queue.prototype.authorize = function(method, path, query, headers) {
  throw new Error("authorize is not implemented, must be defined!");
};

/**
 * Make a signed request to `path` using `method` in upper-case and all `query`
 * parameters and `headers` keys in lower-case. The request will carry `data`
 * as payload and will be retried using the configured retry policy,
 *
 * @param {string} method - HTTP verb in upper case, e.g. `GET`.
 * @param {string} path - Path on queue resource for storage account.
 * @param {object} query - Query-string parameters.
 * @param {object} header - Mapping from header key in lowercase to value.
 * @param {string} data - String data to send as UTF-8 payload.
 * @return {Promise} A promise for HTTPS response with `payload` property as
 * string containing the response payload.
 */
Queue.prototype.request = function request(method, path, query, headers, data) {
  // Set timeout, if not provided
  if (query.timeout === undefined && this.options.timeout !== null) {
    query.timeout = this.options.timeout;
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
      // Construct a promise chain first handling the request, and then parsing
      // any potential error message
      return utils.request(options, data).then(function(res) {
        // Accept the response if it's 2xx, otherwise we construct and
        // throw an error
        if (200 <= res.statusCode && res.statusCode < 300) {
          return res;
        }

        // Parse payload
        var xml = libxml.parseXml(res.payload);

        // Find error message
        var message = xml.get('/Error/Message');
        if (message) {
          message = message.text();
        } else {
          message = "No error message given, in payload '" + res.payload + "'";
        }

        // Find error code
        var code = xml.get('/Error/Code');
        if (code) {
          code = code.text();
        } else if (500 <= res.statusCode && res.statusCode < 600) {
          code = 'InternalErrorWithoutCode';
        } else {
          code = 'ErrorWithoutCode';
        }

        // Construct error object
        var err         = new Error(message);
        err.name        = code + 'Error';
        err.code        = code;
        err.statusCode  = res.statusCode;
        err.payload     = res.payload;

        // Throw the constructed error
        throw err;
      });
    }, self.options);
  });
};

/**
 * List queues under the storage account.
 *
 * @param {object} options -  `options` on the following form:
 * ```js
 * {
 *   prefix:          '',     // Prefix of queues to list
 *   marker:          '',     // Marker to list queues from
 *   maxResults:      5000,   // Max number of results
 *   metadata:        false   // Whether or not to include metadata
 * }
 * ```
 * @returns {Promise} A promise for an object on the form:
 * ```js
 * {
 *   queues: [
 *     {
 *       name:       '...',      // Name of queue
 *       metadata:   {}          // Meta-data dictionary if requested
 *     }
 *   ],
 *   prefix:         '...',      // prefix given in options (if given)
 *   marker:         '...',      // marker given in options (if given)
 *   maxResults:     5000,       // maxResults given in options (if given)
 *   nextMarker:     '...'       // Next marker if not at end of list
 * }
 * ```
 */
Queue.prototype.listQueues = function listQueues(options) {
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

  // Send request with retry policy
  return this.request('GET', '/', query, {}).then(function(res) {
    // Get results
    var xml     = libxml.parseXml(res.payload);
    var queues  = xml.get('/EnumerationResults/Queues').childNodes();

    // Construct results
    var result = {
      queues: queues.map(function(queue) {
        var metadata = undefined;
        var metaNode = queue.get('Metadata');
        if (metaNode) {
          metadata = {};
          metaNode.childNodes().forEach(function(node) {
            metadata[node.name()] = node.text();
          });
        }
        return {
          name:     queue.get('Name').text(),
          metadata: metadata
        };
      })
    };

    // Get Marker, Prefix, MaxResults and NextMarker, if present
    var marker = xml.get('/EnumerationResults/Marker');
    if (marker) {
      result.marker = marker.text();
    }
    var prefix = xml.get('/EnumerationResults/Prefix');
    if (prefix) {
      result.prefix = prefix.text();
    }
    var maxResults = xml.get('/EnumerationResults/MaxResults');
    if (maxResults) {
      result.maxResults = parseInt(maxResults.text());
    }
    var nextMarker = xml.get('/EnumerationResults/NextMarker');
    if (nextMarker ) {
      result.nextMarker = nextMarker.text();
    }

    // Return result
    return result;
  });
};

// TODO: Implement someday when we need it:
// Queue.prototype.getServiceProperties = function getServiceProperties() {};
// Queue.prototype.setServiceProperties = function setServiceProperties() {};
// Queue.prototype.getServiceStats = function getServiceStats() {};
// Queue.prototype.setServiceStats = function setServiceStats() {};

/**
 * Create queue with given `name`, returns promise that resolves to `true`, if
 * the queue didn't already exist. Do not rely on this behavior unless you
 * disable the retry logic. Note, if queue exists with different
 * meta-data an error will be thrown.
 *
 * @param {string} queue - Name of queue to create.
 * @param {object} metadata - Mapping from metadata keys to values.
 * @returns {Promise} A promise that queue has been created.
 */
Queue.prototype.createQueue = function createQueue(name, metadata) {
  // Construct headers
  var headers = {};
  for(var key in metadata) {
    if (metadata.hasOwnProperty(key)) {
      headers['x-ms-meta-' + key] = metadata[key];
    }
  }
  return this.request('PUT', '/' + name, {}, headers).then(function(res) {
    // Queue was created
    if (res.statusCode === 201) {
      return true;
    }

    // Identical queue already existed, or was created in a failed request
    // that we retried.
    if (res.statusCode === 204) {
      return false;
    }

    throw new Error("createQueue: Unexpected statusCode: " + res.statusCode);
  });
};

/**
 * Delete queue, return promise queue is deleted.
 * Note, Azure may take a while to garbage collect the queue, see documentation
 * for relevant details, if you plan to recreate the queue again.
 *
 * @param {string} queue - Name of queue to delete.
 * @returns {Promise} A promise that the queue has been marked for deletion.
 */
Queue.prototype.deleteQueue = function deleteQueue(name) {
  return this.request('DELETE', '/' + name, {}, {}).then(function(res) {
    if (res.statusCode !== 204) {
      throw new Error("deleteQueue: Unexpected statusCode: " + res.statusCode);
    }
  });
};

/**
 * Get meta-data for given `queue`. This includes approximate message count,
 * note that the approximate message is an upper-bound on the number of messages
 * in the queue.
 *
 * @param {string} queue - Name of queue to get meta-data from.
 * @returns {Promise} A promise for an object on the form:
 * ```js
 * {
 *   messageCount:   50,         // Upper-bound on message count
 *   metadata: {                 // Mapping from meta-data keys to values
 *     '<key>':      '<value>',  // Meta-data key/value pair
 *     ...
 *   }
 * }
 * ```
 */
Queue.prototype.getMetadata = function getMetadata(queue) {
  // Construct path for queue
  var path = '/' + queue;
  // Construct query-string
  var query = {comp: 'metadata'};
  // Send request with retry policy
  return this.request('HEAD', path, query, {}).then(function(res) {
    if (res.statusCode !== 200) {
      throw new Error("getMetadata: Unexpected statusCode: " + res.statusCode);
    }
    // Extract meta-data
    var metadata = {};
    for(var field in res.headers) {
      if (/x-ms-meta-/.test(field)) {
        metadata[field.substr(10)] = res.headers[field];
      }
    }
    return {
      messageCount: parseInt(res.headers['x-ms-approximate-messages-count']),
      metadata:     metadata
    };
  });
};

/**
 * Set meta-data for given `queue`, note that this overwrites all existing
 * meta-data key/value pairs.
 *
 * @param {string} queue - Name of queue to set meta-data on.
 * @param {object} metadata - Mapping from meta-data keys to values.
 * @returns {Promise} A promise that the meta-data was set.
 */
Queue.prototype.setMetadata = function setMetadata(queue, metadata) {
  // Construct path for queue
  var path = '/' + queue;
  // Construct query-string
  var query = {comp: 'metadata'};
  // Construct headers
  var headers = {};
  for(var key in metadata) {
    if (metadata.hasOwnProperty(key)) {
      headers['x-ms-meta-' + key] = metadata[key];
    }
  }
  // Send request with retry policy
  return this.request('PUT', path, query, headers).then(function(res) {
    if (res.statusCode !== 204) {
      throw new Error("setMetadata: Unexpected statusCode: " + res.statusCode);
    }
  });
};

// TODO: Implement someday when we need it:
// Queue.prototype.getQueueACL = function getQueueACL() {};
// Queue.prototype.setQueueACL = function setQueueACL() {};

/**
 * Put a message with XML-safe `text` into `queue` with TTL and visibility-
 * timeout, as given in `options`.
 *
 * Notice that the `text` must be XML-safe, for JSON it's useful to base64
 * encode the message. This is what many other libraries does, so make sense for
 * interoperability. Encoding this way is trivial in node.js:
 * ```js
 * var text = new Buffer(JSON.stringify(jsonMessage)).toString('base64');
 * ```
 *
 * @param {string} queue - Name of queue to put message into.
 * @param {string} text - XML-safe string to send.
 * @param {object} options - options on the following form:
 * ```js
 * {
 *   visibilityTimeout:    7 * 24 * 60 * 60, // Visibility timeout in seconds
 *   messageTTL:           7 * 24 * 60 * 60  // Message Time-To-Live in seconds
 * }
 * ```
 * @returns {Promise} A promise that the messages was inserted in the queue.
 */
Queue.prototype.putMessage = function putMessage(queue, text, options) {
  // Construct path for queue
  var path = '/' + queue + '/messages';
  // Construct query-string
  var query = {};
  if (options && options.visibilityTimeout !== undefined) {
    query.visibilitytimeout = '' + options.visibilityTimeout;
  }
  if (options && options.messageTTL !== undefined) {
    query.messagettl = '' + options.messageTTL;
  }
  // Construct payload
  var data = '<QueueMessage><MessageText>' + text +
             '</MessageText></QueueMessage>';
  // Send request with retry policy
  return this.request('POST', path, query, {}, data).then(function(res) {
    if (res.statusCode !== 201) {
      throw new Error("putMessage: Unexpected statusCode: " + res.statusCode);
    }
  });
};

/**
 * Peek messages from `queue`, returns up to `options.numberOfMessages`, note,
 * that Azure Queue Storage only allows up to 32 messages at once.
 *
 * Note, Azure may return zero messages giving you an empty array. This is not
 * necessarily proof the that the queue is empty. See REST documentation for
 * consistency levels.
 *
 * @param {string} queue - Name of queue to peek messages from.
 * @param {object} options - `options` on the following form:
 * ```js
 * {
 *   numberOfMessages:       1    // Max number of messages to peek
 * }
 * ```
 * @returns {Promise} A promise for an array of messages on the following form:
 * ```js
 * [
 *   {
 *     messageId:        '...',      // Message id as string
 *     insertionTime:    new Date(), // Insertion time as Date object
 *     expirationTime:   new Date(), // Expiration time as Date object
 *     dequeueCount:     1,          // Message dequeue count
 *     messageText:      '...'       // Message text (however, you encoded it)
 *   },
 *   ...
 * ]
 * ```
 */
Queue.prototype.peekMessages = function peekMessages(queue, options) {
  // Construct path
  var path = '/' + queue + '/messages';

  // Construct query string from options
  var query = {peekonly: 'true'};
  if (options && options.numberOfMessages !== undefined) {
    query.numofmessages = '' + options.numberOfMessages;
  }

  // Send request with retry policy
  return this.request('GET', path, query, {}).then(function(res) {
    // Get results
    var xml   = libxml.parseXml(res.payload);
    var msgs  = xml.get('/QueueMessagesList').childNodes();
    return msgs.map(function(msg) {
      return {
        messageId:        msg.get('MessageId').text(),
        insertionTime:    new Date(msg.get('InsertionTime').text()),
        expirationTime:   new Date(msg.get('ExpirationTime').text()),
        dequeueCount:     parseInt(msg.get('DequeueCount').text()),
        messageText:      msg.get('MessageText').text()
      };
    });
  });
};

/**
 * Get messages from `queue`, returns up to `options.numberOfMessages` of
 * messages, note, that Azure Queue Storage only allows up to 32 messages per
 * request.
 * See, `deleteMessage` for how to delete messages once you have processed them.
 *
 * Note, Azure may return zero messages giving you an empty array. This is not
 * necessarily proof the that the queue is empty. See REST documentation for
 * consistency levels.
 *
 * @param {string} queue - Name of queue to get messages from.
 * @param {object} options - `options` on the following form:
 * ```js
 * {
 *   numberOfMessages:       1,   // Max number of messages to claim (max 32)
 *   visibilityTimeout:      30   // Seconds to messages becomes visible again
 * }
 * ```
 * @returns {Promise} A promise for an array of messages on the following form:
 * ```js
 * [
 *   {
 *     messageId:        '...',      // Message id as string
 *     insertionTime:    new Date(), // Insertion time as Date object
 *     expirationTime:   new Date(), // Expiration time as Date object
 *     dequeueCount:     1,          // Message dequeue count
 *     messageText:      '...',      // Message text (however, you encoded it)
 *     popReceipt:       '...',      // Opaque string for deleting the message
 *     timeNextVisible:  new Date()  // Next time visible as Date object
 *   },
 *   ...
 * ]
 * ```
 */
Queue.prototype.getMessages = function getMessages(queue, options) {
  // Construct path
  var path = '/' + queue + '/messages';

  // Construct query string from options
  var query = {};
  if (options && options.numberOfMessages !== undefined) {
    query.numofmessages = '' + options.numberOfMessages;
  }
  if (options && options.visibilityTimeout !== undefined) {
    query.visibilitytimeout = '' + options.visibilityTimeout;
  }

  // Send request with retry policy
  return this.request('GET', path, query, {}).then(function(res) {
    // Get results
    var xml   = libxml.parseXml(res.payload);
    var msgs  = xml.get('/QueueMessagesList').childNodes();
    return msgs.map(function(msg) {
      return {
        messageId:        msg.get('MessageId').text(),
        insertionTime:    new Date(msg.get('InsertionTime').text()),
        expirationTime:   new Date(msg.get('ExpirationTime').text()),
        dequeueCount:     parseInt(msg.get('DequeueCount').text()),
        messageText:      msg.get('MessageText').text(),
        popReceipt:       msg.get('PopReceipt').text(),
        timeNextVisible:  new Date(msg.get('TimeNextVisible').text())
      };
    });
  });
};

/**
 * Delete a message from `queue` using `messageId` and `popReceipt`
 *
 * @param {string} queue - Name of queue to delete message from
 * @param {string} messageId - Message identifier for message to delete, this
 * identifier is given when you call `getMessages`.
 * @param {string} popReceipt - Opaque token `popReceipt` that was given by
 * `getMessages` when you received the message.
 * @returns {Promise} A promise that the message has been deleted.
 */
Queue.prototype.deleteMessage = function deleteMessage(queue, messageId,
                                                       popReceipt) {
  assert(messageId, "messageId must be given!");

  // Construct path
  var path = '/' + queue + '/messages/' + messageId;

  // Construct query-string
  var query = {popreceipt: popReceipt};

  // Send request with retry policy
  return this.request('DELETE', path, query, {}).then(function(res) {
    if (res.statusCode !== 204) {
      throw new Error("deleteMessage: Unexpected statusCode: " +
                      res.statusCode);
    }
  });
};

/**
 * Clear all messages from `queue`, note this may timeout if there is a lot of
 * messages in the queue, in this case you'll get a error with the code:
 * `OperationTimedOut`, and you should retry until the operation is successful.
 * See Azure Queue Storage REST API documentation for details.
 *
 * @param {string} queue - Name of queue to clear all messages from.
 * @returns {Promise} A promise that messages have been cleared.
 */
Queue.prototype.clearMessages = function clearMessages(queue) {
  // Construct path
  var path = '/' + queue + '/messages';
  return this.request('DELETE', path, {}, {}).then(function(res) {
    if (res.statusCode !== 204) {
      throw new Error("deleteMessage: Unexpected statusCode: " +
                      res.statusCode);
    }
  });
};

/**
 * Update a message from `queue` with XML-safe `text` and visibility-timeout,
 * as given in `options`.
 *
 * Notice that the `text` must be XML-safe, for JSON it's useful to base64
 * encode the message. This is what many other libraries does, so make sense for
 * interoperability. Encoding this way is trivial in node.js:
 * ```js
 * var text = new Buffer(JSON.stringify(jsonMessage)).toString('base64');
 * ```
 *
 * @param {string} queue - Name of queue in which you wish to update a message.
 * @param {string} text - XML-safe UTF-8 text to set on the message.
 * @param {string} messageId - MessageId as received from `getMessages`.
 * @param {string} popReceipt - Opaque token as given by `getMessages`.
 * @param {object} options - Options on the following form:
 * ```js
 * {
 *   visibilityTimeout:    7 * 24 * 60 * 60, // Visibility timeout in seconds
 * }
 * ```
 * @return {Promise} A promise that the message has been updated.
 */
Queue.prototype.updateMessage = function updateMessage(queue, text, messageId,
                                                       popReceipt, options) {
  // Construct path for queue
  var path = '/' + queue + '/messages/' + messageId;
  // Construct query-string
  var query = {popreceipt: popReceipt};
  if (options && options.visibilityTimeout !== undefined) {
    query.visibilitytimeout = '' + options.visibilityTimeout;
  }
  // Construct payload
  var data = '<QueueMessage><MessageText>' + text +
             '</MessageText></QueueMessage>';
  // Send request with retry policy
  return this.request('PUT', path, query, {}, data).then(function(res) {
    if (res.statusCode !== 204) {
      throw new Error("updateMessage: Unexpected statusCode: "
                      + res.statusCode);
    }
  });
};

