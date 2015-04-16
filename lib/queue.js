'use strict';

var assert      = require('assert');
var _           = require('lodash');
var debug       = require('debug')('azure:queue');
var Promise     = require('promise');
var querystring = require('querystring');
var crypto      = require('crypto');
var libxml      = require('libxmljs');
var agent       = require('./agent');
var utils       = require('./utils');

/** Transient error codes (we'll retry request when encountering these codes */
var TRANSIENT_ERROR_CODES = [
  // Error code for when we encounter a 5xx error, but the XML document doesn't
  // have a code property, or we fail to parse the XML payload. This is unlikely
  // to happen unless you have an HTTP proxy that returns 5xx for some reason.
  'InternalErrorWithoutCode',

  // Azure error codes we should retry on according to azure docs
  'InternalError',
  'ServerBusy'
].concat(utils.TRANSIENT_HTTP_ERROR_CODES);


/** Queue client object */
function Queue(options) {
  // Set default options
  options = _.defaults({}, options, {
    // Value for the x-ms-version header fixing the API version
    version:              '2014-02-14',

    // Value for the x-ms-client-request-id header identifying the client
    clientId:             'fast-azure-storage',

    // Server-side request timeout
    timeout:              30,

    // HTTP Agent to use (defaults to a global azure.Agent instance)
    agent:                agent.globalAgent,

    // Max number of request retries
    retries:              5,

    // Multiplier for computation of retry delay: 2 ^ retry * delayFactor
    delayFactor:          100,

    // Maximum retry delay in ms (defaults to 30 seconds)
    maxDelay:             30 * 1000,

    // Error codes for which we should retry
    transientErrorCodes:  TRANSIENT_ERROR_CODES
  });

  // Validate options
  assert(options.credentials, "`options.credentials` must be given");

  // Construct hostname
  this._hostname  = options.credentials.accountId + '.queue.core.windows.net';
  // Decode accessKey
  this._accessKey = new Buffer(options.credentials.accessKey, 'base64');

  // Save options
  this.options = options;
};

// Export Queue
module.exports = Queue;

/**
 * List of x-ms-* headers supported in lexicographical order, used for
 * construction of the canonicalized headers.
 */
var X_MS_HEADERS_SUPPORTED = [
  'x-ms-client-request-id',
  'x-ms-date',
  'x-ms-version'
].sort();

/**
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
 * Make a signed request to `path` using `method` in upper-case and all `query`
 * parameters and `headers` keys in lower-case. The request will carry `data`
 * as payload and will be retried using the configured retry policy,
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

  // Find account id
  var accountId = this.options.credentials.accountId;

  // Build list of lines to sign, we'll join with '\n' before signing the list
  var linesToSign = [
    method,
    headers['content-encoding']     || '',
    headers['content-language']     || '',
    headers['content-length']       || '',
    headers['content-md5']          || '',
    headers['content-type']         || '',
    '',   // we always include x-ms-date, so we never specify date header
    headers['if-modified-since']    || '',
    headers['if-match']             || '',
    headers['if-none-match']        || '',
    headers['if-unmodified-since']  || '',
    headers['range']                || ''
  ];

  // Add lines form canonicalized headers supported by this library in
  // lexicographical order as presorted in X_MS_HEADERS_SUPPORTED
  var N = X_MS_HEADERS_SUPPORTED.length;
  for(var i = 0; i < N; i++) {
    var name  = X_MS_HEADERS_SUPPORTED[i];
    var value = headers[name];
    if (value) {
      linesToSign.push(name + ':' + value);
    }
  }

  // Added lines from canonicalized resource and query-string parameters
  // supported by this library in lexicographical order as presorted in
  // QUERY_PARAMS_SUPPORTED
  linesToSign.push('/' + accountId + path);
  var M = QUERY_PARAMS_SUPPORTED.length;
  for(var j = 0; j < M; j++) {
    var param = QUERY_PARAMS_SUPPORTED[j];
    var value = query[param];
    if (value) {
      linesToSign.push(param + ':' + value);
    }
  }

  // Compute signature
  var signature = crypto
                    .createHmac('sha256', this._accessKey)
                    .update(linesToSign.join('\n'))
                    .digest('base64');

  // Set authorization header
  headers.authorization = 'SharedKey ' + accountId + ':' + signature;

  // Encode query string
  var qs = querystring.stringify(query);

  // Construct request options
  var options = {
    host:       this._hostname,
    method:     method,
    path:       (qs.length > 0 ? path + '?' + qs : path),
    headers:    headers,
    agent:      this.options.agent,
  };

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
  }, this.options);
};

/**
 * List queues with `options` as follows:
 * ```js
 * {
 *   prefix:          '',     // Prefix of queues to list
 *   marker:          '',     // Marker to list queues from
 *   maxResults:      5000,   // Max number of results
 *   metadata:        false   // Whether or not to include metadata
 * }
 * ```
 *
 * Returna promise for an object on the form:
 * ```js
 * {
 *   "queues": [
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

// TODO: Implement someday when we need it (serviceProperties is get/set)
// Queue.prototype.serviceProperties = function serviceProperties() {};
// Queue.prototype.serviceStats = function serviceStats() {};

/**
 * Create queue with given `name`, returns promise that resolves to `true`, if
 * the queue didn't already exist. Do not rely on this behavior unless you
 * disable the retry logic. Note, if queue exists with different
 * meta-data an error will be thrown.
 */
Queue.prototype.createQueue = function createQueue(name) {
  // TODO: Add support meta-data dictionary, requires that we modify the
  //       signature algorithm... So let's leave it for now.
  return this.request('PUT', '/' + name, {}, {}).then(function(res) {
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
 */
Queue.prototype.deleteQueue = function deleteQueue(name) {
  return this.request('DELETE', '/' + name, {}, {}).then(function(res) {
    if (res.statusCode !== 204) {
      throw new Error("deleteQueue: Unexpected statusCode: " + res.statusCode);
    }
  });
};

// TODO: Implement as get/set someday when we need it
// Queue.prototype.metadata = function getMetadata() {};
// Queue.prototype.queueACL = function queueACL() {};

/**
 * Put a message with XML-safe `text` into `queue` with TTL and visibility-
 * timeout, as given in `options`, example:
 * ```js
 * {
 *   visibilityTimeout:    7 * 24 * 60 * 60, // Visibility timeout in seconds
 *   messageTTL:           7 * 24 * 60 * 60  // Message Time-To-Live in seconds
 * }
 * ```
 *
 * Notice that the `text` must be XML-safe, for JSON it's useful to base64
 * encode the message. This is what many other libraries does, so make sense for
 * interoperability. Encoding this way is trivial in node.js:
 * ```js
 * var text = new Buffer(JSON.stringify(jsonMessage)).toString('base64');
 * ```.
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
 * Peek messages from `queue` returns `options.numberOfMessages`, note, that
 * Azure Queue Storage only allows up to 32 messages at once. Can be called
 * with `options` on the form:
 * ```js
 * {
 *   numberOfMessages:       1    // Max number of messages to peek
 * }
 * ```
 *
 * Returns a promise for an array on the form:
 * ```js
 * [
 *   {
 *     messageId:        '...',      // Message id as string
 *     insertionTime:    new Date(), // Insertion time as Date object
 *     expirationTime:   new Date(), // Expiration time as Date object
 *     dequeueCount:     1,          // Message dequeue count
 *     messageText:      '...'       // Message text (however, you encoded it)
 *   }
 * ]
 * ```
 *
 * Note, Azure may return zero messages giving you an empty array. This is not
 * necessarily proof the that the queue is empty. See REST documentation for
 * consistency levels.
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
 * Get messages from `queue` returns up to `options.numberOfMessages` of
 * messages, note, that Azure Queue Storage only allows up to 32 messages per
 * request. Can be called with `options` on the form:
 * ```js
 * {
 *   numberOfMessages:       1,   // Max number of messages to claim (max 32)
 *   visibilityTimeout:      30   // Seconds to messages becomes visible again
 * }
 * ```
 *
 * Returns a promise for an array on the form:
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
 *   }
 * ]
 * ```
 * See, `deleteMessage` for how to delete messages once you have processed them.
 *
 * Note, Azure may return zero messages giving you an empty array. This is not
 * necessarily proof the that the queue is empty. See REST documentation for
 * consistency levels.
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

/** Delete a message from `queue` using `messageId` and `popReceipt` */
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
 * Update a message from `queue` with XML-safe `text` with visibility-timeout,
 * as given in `options`, example:
 * ```js
 * {
 *   visibilityTimeout:    7 * 24 * 60 * 60, // Visibility timeout in seconds
 * }
 * ```
 *
 * Notice that the `text` must be XML-safe, for JSON it's useful to base64
 * encode the message. This is what many other libraries does, so make sense for
 * interoperability. Encoding this way is trivial in node.js:
 * ```js
 * var text = new Buffer(JSON.stringify(jsonMessage)).toString('base64');
 * ```
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

