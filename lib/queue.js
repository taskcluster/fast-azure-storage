'use strict';

var assert      = require('assert');
var debug       = require('debug')('azure:queue');
var querystring = require('querystring');
var crypto      = require('crypto');
var events      = require('events');
var util        = require('util');
var agent       = require('./agent');
var utils       = require('./utils');
var xml         = require('./xml-parser');
var auth        = require('./authorization');

/*
 * Azure storage service version
 * @const
 */
var SERVICE_VERSION = '2015-04-05';

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

/**
 * Queue client class for interacting with Azure Queue Storage.
 *
 * @class Queue
 * @constructor
 * @param {object} options - options on the form:
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
 *   // HTTP Agent to use (defaults to a global azure.Agent instance)
 *   agent:                azure.Agent.globalAgent,
 *
 *   // Max number of request retries
 *   retries:              5,
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
function Queue(options) {
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
    randomizationFactor:  0.25,
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
  this.hostname = this.options.accountId + '.queue.core.windows.net';

  // Compute `timeout` for client-side timeout (in ms), and `timeoutInSeconds`
  // for server-side timeout in seconds.
  this.timeout = this.options.timeout + this.options.clientTimeoutDelay;
  this.timeoutInSeconds = Math.floor(this.options.timeout / 1000);

  // Define `this.authorize`
  if (this.options.accessKey) {
    // If set authorize to use shared key signatures
    this.authorize = auth.authorizeWithSharedKey.call(this, 'queue', QUERY_PARAMS_SUPPORTED);
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
 * @method sas
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
    sv:   SERVICE_VERSION,
    se:   utils.dateToISOWithoutMS(options.expiry),
    sp:   permissions,
    spr:  'https',
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
    '/queue/' + this.options.accountId.toLowerCase() + '/' + queue,
    query.si  || '',
    '', // TODO: Support signed IP addresses
    query.spr,
    query.sv
  ].join('\n');

  // Compute signature
  query.sig = utils.hmacSha256(this._accessKey, stringToSign);;

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
 * @private
 * @method request
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

        var resMSHeaders = {};
        Object.keys(res.headers).forEach(h => {
          if (h.startsWith('x-ms-')) {
            resMSHeaders[h] = res.headers[h];
          }
        });

        // Construct error object
        var err = new Error(data.message);
        err.name = data.code + 'Error';
        err.code = data.code;
        err.statusCode = res.statusCode;
        err.detail = data.detail;
        err.payload = res.payload;
        err.retries = retry;
        err.resMSHeaders = resMSHeaders;

        debug("Error code: %s (%s) for %s %s on retry: %s",
              data.code, res.statusCode, method, path, retry);

        // Throw the constructed error
        throw err;
      });
    }, self.options);
  });
};

/**
 * List queues under the storage account.
 *
 * @method listQueues
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
  return this.request('GET', '/', query, {}).then(xml.queueParseListQueues);
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
 * @method createQueue
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
 * @method deleteQueue
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
 * Warning, this is a `HEAD` request, so if the queue is missing you get an
 * error with `err.statusCode = 404`, but `err.code` property will be
 * `ErrorWithoutCode`. The same goes for all other error codes.
 *
 * @method getMetadata
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

    return {
      messageCount: parseInt(res.headers['x-ms-approximate-messages-count']),
      metadata:     utils.extractMetadataFromHeaders(res)
    };
  });
};

/**
 * Set meta-data for given `queue`, note that this overwrites all existing
 * meta-data key/value pairs.
 *
 * @method setMetadata
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
 * @method putMessage
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
 * @method peekMessages
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
  return this.request('GET', path, query, {}).then(xml.queueParsePeekMessages);
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
 * @method getMessages
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
  return this.request('GET', path, query, {}).then(xml.queueParseGetMessages);
};

/**
 * Delete a message from `queue` using `messageId` and `popReceipt`
 *
 * @method deleteMessage
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
 * @method clearMessages
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
 * @method updateMessage
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
    return {
      popReceipt: res.headers['x-ms-popreceipt']
    };
  });
};
