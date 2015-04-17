'use strict';

var assert      = require('assert');
var _           = require('lodash');
var debug       = require('debug')('azure:table');
var Promise     = require('promise');
var querystring = require('querystring');
var crypto      = require('crypto');
var events      = require('events');
var util        = require('util');
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


/**
 * Authorize the request with shared key
 * Intended to define `Table.prototype.authorize`.
 */
function authorizeWithSharedKey(method, path, query, headers) {
  // Find account id
  var accountId = this.options.accountId;

  // Build list of lines to sign, we'll join with '\n' before signing the list
  var stringToSign = [
    method + '\n' +
    (headers['content-md5']  || '') + '\n' +
    (headers['content-type'] || '') + '\n' +
    headers['x-ms-date']
  ];

  // Added lines from canonicalized resource and query-string parameters
  // supported by this library in lexicographical order as presorted in
  // QUERY_PARAMS_SUPPORTED
  stringToSign += '\n/' + accountId + path;
  if (query.comp !== undefined) {
    stringToSign += '?comp=' + query.comp;
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
};


/**
 * Authorize the request with a shared-access-signature that is refreshed with
 * the a function given as `options.sas`.
 * Intended to define `Table.prototype.authorize`.
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
};


/**
 * Authorize the request with a shared-access-signature that is given with
 * `options.sas` as string.
 * Intended to define `Table.prototype.authorize`.
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
};

/** Table client object
 *
 * Subclasses `EventEmitter` and emits the `error` event on failure to refresh
 * shared-access-signature, if `options.sas` is a function.
 */
function Table(options) {
  // Initialize EventEmitter parent class
  events.EventEmitter.call(this);

  // Set default options
  options = _.defaults({}, options, {
    // Value for the `x-ms-version` header fixing the API version
    version:              '2014-02-14',

    // OData Service version, must work with API version, refer to azure
    // documentation. This just specifies the `DataServiceVersion` header.
    dataServiceVersion:   '3.0',

    // Value for the x-ms-client-request-id header identifying the client
    clientId:             'fast-azure-storage',

    // Server-side request timeout
    timeout:              30,

    // Set meta-data level for responses (use full to get eTag in queryEntities)
    metadata:             'fullmetadata',

    // HTTP Agent to use (defaults to a global azure.Agent instance)
    agent:                agent.globalAgent,

    // Max number of request retries
    retries:              5,

    // Multiplier for computation of retry delay: 2 ^ retry * delayFactor
    delayFactor:          100,

    // Maximum retry delay in ms (defaults to 30 seconds)
    maxDelay:             30 * 1000,

    // Error codes for which we should retry
    transientErrorCodes:  TRANSIENT_ERROR_CODES,

    // Azure storage accountId (required)
    accountId:            undefined,

    // Azure shared accessKey, required unless options.sas is given
    accessKey:            undefined,

    // Function that returns SAS string or promise for SAS string, in which case
    // we will refresh SAS when a request occurs less than minSASAuthExpiry from
    // signature expiry. This property may also be a SAS string.
    sas:                  undefined,

    // Minimum SAS expiry before refreshing SAS credentials, if a function for
    // refreshing SAS credentials is given as options.sas
    minSASAuthExpiry:     15 * 60 * 1000,
  });

  // Validate options
  assert(options.accountId, "`options.accountId` must be given");
  assert(
    options.metadata === 'nometadata' ||
    options.metadata === 'minimalmetadata' ||
    options.metadata === 'fullmetadata',
    "options.metadata must be 'nometadata', 'minimalmetadata' or 'fullmetadata'"
  );

  // Construct hostname
  this._hostname  = options.accountId + '.table.core.windows.net';

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

// Subclass EventEmitter
util.inherits(Table, events.EventEmitter);

// Export Table
module.exports = Table;

/**
 *
 * ```js
 * {
 *   start:           new Date(), // Time from which signature is valid
 *   expiry:          new Date(), // Expiration of signature (required)
 *   permissions: {               // Set of permissions delegated (required)
 *     read:          false,      // Read entities
 *     add:           false,      // Insert new entities
 *     update:        false,      // Update entities
 *     delete:        false       // Delete entities
 *   },
 *   first: {                     // Start of accessible range (optional)
 *     partitionKey:  '...',      // First accessible partition key (required)
 *     rowKey:        '...'       // First accessible row key (required)
 *   },
 *   last: {                      // End of accessible range (optional)
 *     partitionKey:  '...',      // Last accessible partition key (required)
 *     rowKey:        '...'       // Last accessible row key (required)
 *   },
 *   accessPolicy:    '...'       // Reference to stored access policy
 * }
 * ```
*/
Table.prototype.sas = function(table, options) {
  assert(options, "options is required");
  assert(!options.startTime || options.startTime instanceof Date,
         "options.start must be a Date object if specified");
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
  if (options.permissions.read)   permissions += 'r';
  if (options.permissions.add)    permissions += 'a';
  if (options.permissions.update) permissions += 'u';
  if (options.permissions.delete) permissions += 'd';

  // Construct query-string with required parameters
  var query = {
    sv:   '2014-02-14',
    tn:   table,
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
  if (options.first) {
    assert(options.first.partitionKey && options.first.rowKey,
           "if options.first is specified, both partitionKey and rowKey must " +
           "be specified");
    query.spk = options.first.partitionKey;
    query.srk = options.first.rowKey;
  }
  if (options.last) {
    assert(options.last.partitionKey && options.last.rowKey,
           "if options.last is specified, both partitionKey and rowKey must " +
           "be specified");
    query.epk = options.last.partitionKey;
    query.erk = options.last.rowKey;
  }
  if (options.accessPolicy) {
    query.se = options.accessPolicy;
  }

  // Construct string to sign
  var stringToSign = [
    query.sp,
    query.st  || '',
    query.se,
    '/' + this.options.accountId.toLowerCase() + '/' + table.toLowerCase(),
    query.si  || '',
    query.sv,
    query.spk || '',
    query.srk || '',
    query.epk || '',
    query.erk || ''
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
 */
Table.prototype.authorize = null; // Defined at runtime in constructor

/**
 * Make a signed request to `path` using `method` in upper-case and all `query`
 * parameters and `headers` keys in lower-case. The request will carry `json`
 * as payload and will be retried using the configured retry policy,
 */
Table.prototype.request = function request(method, path, query, headers, json) {
  // Set timeout, if not provided
  if (query.timeout === undefined && this.options.timeout !== null) {
    query.timeout = this.options.timeout;
  }

  // Set date, version, dataServiceVersion and client-request-id headers
  headers['x-ms-date']              = new Date().toUTCString();
  headers['x-ms-version']           = this.options.version;
  headers['dataserviceversion']     = this.options.dataServiceVersion;
  headers['x-ms-client-request-id'] = this.options.clientId;

  // Serialize and set content-length/content-type, if json is given
  var data = undefined;
  if (json !== undefined) {
    data = JSON.stringify(json);
    headers['content-length'] = Buffer.byteLength(data, 'utf-8');
    headers['content-type'] = 'application/json';
  }

  // Set meta-data level for responses
  headers['accept'] = 'application/json;odata=' + this.options.metadata;

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

        // Find message and code
        var message = null;
        var code    = 'InternalErrorWithoutCode';
        try {
          var details = JSON.parse(res.payload)['odata.error'];
          code = details.code;
          message = details.message.value || details.message;
        }
        catch (e) {
          // Ignore parse and extraction errors
        }

        // Set fallback message
        if (!message) {
          message = "No error message given, in payload '" + res.payload + "'"
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
 * Query for tables, with `options` as follows:
 * ```js
 * {
 *   nextTableName:      '...'  // nextTableName, if paging
 * }
 * ```
 *
 * Returns a promise for an object on the form:
 * ```js
 * {
 *  tables:         ['<tableName>', ...],
 *  nextTableName:  '...',      // nextTableName if paging is necessary
 * }
 * ```
 */
Table.prototype.queryTables = function queryTables(options) {
  // Construct query
  var query = {};
  if (options && options.nextTableName) {
    query.NextTableName = options.nextTableName;
  }
  // Send request with retry logic
  return this.request('GET', '/Tables', query, {}).then(function(res) {
    if (res.statusCode !== 200) {
      throw new Error("queryTables: Unexpected statusCode: " + res.statusCode);
    }
    var payload = JSON.parse(res.payload);
    return {
      tables:   payload.value.map(function(table) {
        return table.TableName;
      }),
      nextTableName: res.headers['x-ms-continuation-nexttablename'] || null
    };
  });
};

/** Create table with given `name` */
Table.prototype.createTable = function createTable(name) {
  // Construct json payload
  var json = {TableName: name};
  // Construct headers
  var headers = {
    // There is no reason to return content
    'prefer':   'return-no-content'
  };
  // Send request with retry logic
  return this.request('POST', '/Tables', {}, headers, json).then(function(res) {
    if (res.statusCode !== 204) {
      throw new Error("createTable: Unexpected statusCode: " + res.statusCode);
    }
  });
};

/** Delete table with given `name` */
Table.prototype.deleteTable = function deleteTable(name) {
  // Construct path
  var path = '/Tables(\'' + name + '\')';
  // Send request with retry logic
  return this.request('DELETE', path, {}, {}).then(function(res) {
    if (res.statusCode !== 204) {
      throw new Error("deleteTable: Unexpected statusCode: " + res.statusCode);
    }
  });
};

/**
 * Convert nested array structure to filter string.
 * See `Table.Operators` for details and examples.
 */
Table.filter = function filter() {
  return Array.prototype.slice.call(arguments).map(function(entry) {
    if (entry instanceof Array) {
      return '(' + Table.filter.apply(Table, entry) + ')';
    }
    return entry;
  }).join(' ');
};

/**
 * Operators and helpers for constructing $filter strings using `Table.filter`.
 *
 * We have the following comparison operators:
 *  * `Table.Operators.Equal`,
 *  * `Table.Operators.GreaterThan`,
 *  * `Table.Operators.GreaterThanOrEqual`,
 *  * `Table.Operators.LessThan`,
 *  * `Table.Operators.LessThanOrEqual`, and
 *  * `Table.Operators.NotEqual`.
 * They should be used in the middle of a triple as follows:
 * `['key1', op.Equal, op.string('my-string')]`.
 *
 * The boolean operators `And`, `Not` and `Or` should be used to connect
 * triples made with comparison operators. Note, that each set of array brackets
 * translates into a parentheses.
 *
 * We also have formatting helpers, `string`, `number`, `bool`, `date` and
 * `guid` which takes constant values and encodes them correctly for use in
 * filter expression. It's strongly recommended that you employ these, as Azure
 * has some undocumented and semi obscure escaping rules.
 *
 * Complete example:
 * ```js
 * var op = Table.Operators;
 * var filter = Table.filter([
 *  ['key1', op.Equal, op.string('my-string')],
 *   op.And,
 *  ['key2', op.LessThan, op.date(new Date())]
 * ]) // "((key1 eq 'my-string') and (key2 le datetime'...'))"
 * ```
 */
Table.Operators = {
  // Comparison operators
  Equal:              'eq',
  GreaterThan:        'gt',
  GreaterThanOrEqual: 'ge',
  LessThan:           'lt',
  LessThanOrEqual:    'le',
  NotEqual:           'ne',
  // Boolean operators
  And:                'and',
  Not:                'not',
  Or:                 'or',
  // Constant formatters
  string: function(c) { return "'" + c.replace(/'/g, "''") + "'"; },
  number: function(c) { return c.toString();                      },
  bool: function(c)   { return (c ? 'true' : 'false');            },
  date: function(c)   { return "datetime'" + c.JSON() + "'";      },
  guid: function(c)   { return "guid'" + c + "'";                 }
};

/**
 * Auxiliary function to construct the entity path as used in many methods.
 * Fprmat: `/<tabel>(PartitionKey='<partitionKey>',RowKey='<rowKey>')`.
 */
function buildEntityPath(table, partitionKey, rowKey) {
  // Escape partitionKey and rowKey
  var pk = encodeURIComponent(partitionKey.replace(/'/g, "''"));
  var rk = encodeURIComponent(rowKey.replace(/'/g, "''"));
  return '/' + table + '(PartitionKey=\'' + pk + '\',RowKey=\'' + rk + '\')';
}

/**
 * Get entity from `table` with given `partitionKey` and `rowKey`.
 *
 * You may provide following `options`:
 * ```js
 * {
 *   select:  ['key1', ...],  // List of keys to return (defaults to all)
 *   filter:  '...'           // Filter string for conditional load
 * }
 * ```
 *
 * Returns a promise for the entity, form of the object depends on the meta-data
 * level configured and if `select` as employed. See Azure documentation for
 * details.
 */
Table.prototype.getEntity = function getEntity(table, partitionKey, rowKey,
                                               options) {
  // Construct path
  var path = buildEntityPath(table, partitionKey, rowKey);

  // Construct query-string
  var query = {};
  if (options) {
    if (options.select) {
      query.$select = options.select.join(',');
    }
    if (options.filter) {
      query.$filter = options.filter;
    }
  }

  // Send request with retry logic
  return this.request('GET', path, query, {}).then(function(res) {
    if (res.statusCode !== 200) {
      throw new Error("getEntity: Unexpected statusCode: " + res.statusCode);
    }
    return JSON.parse(res.payload);
  });
};


/**
 * Query entities from `table` with `options` as follows:
 * ```js
 * {
 *   // Query options:
 *   select:            ['key1', ...],  // Keys to $select (defaults to all)
 *   filter:            'key1 eq true', // $filter string, see Table.filter
 *   top:               1000,           // Max number of entities to return
 *
 *   // Paging options:
 *   nextPartitionKey:  '...',          // nextPartitionKey from previous result
 *   nextRowKey:        '...'           // nextRowKey from previous result
 * }
 * ```
 *
 * Returns a promise for an object on the form:
 * ```js
 * {
 *   entities: [
 *     {
 *       // Keys selected from entity and meta-data depending on meta-data level
 *     },
 *     ...
 *   ],
 *   nextPartitionKey: '...',  // Opaque token for paging
 *   nextRowKey:       '...'   // Opaque token for paging
 * }
 * ```
 */
Table.prototype.queryEntities = function queryEntities(table, options) {
  // Construct path
  var path = '/' + table + '()';

  // Construct query-string
  var query = {};
  if (options) {
    if (options.select) {
      query.$select = options.select.join(',');
    }
    if (options.filter) {
      query.$filter = options.filter;
    }
    if (options.top) {
     query.$top = '' + options.top;
    }
    if (options.nextPartitionKey) {
      query.NextPartitionKey = options.nextPartitionKey;
    }
    if (options.nextRowKey) {
      query.NextRowKey = options.nextRowKey;
    }
  }

  // Send request with retry logic
  return this.request('GET', path, query, {}).then(function(res) {
    if (res.statusCode !== 200) {
      throw new Error("queryEntities: Unexpected statusCode: " +
                      res.statusCode);
    }

    // Read results from response
    var result            = JSON.parse(res.payload);
    var nextPartitionKey  = res.headers['x-ms-continuation-nextpartitionkey'];
    var nextRowKey        = res.headers['x-ms-continuation-nextrowkey'];

    // Return result in a nice format
    return {
      entities:           result.value || [],
      nextPartitionKey:   nextPartitionKey || null,
      nextRowKey:         nextRowKey || null
    };
  });
};


/**
 * Insert `entity` into `table`, the `entity` object must be on the format
 * accepted by azure table storage. See Azure Table Storage documentation for
 * details. Essentially, data-types will be inferred if `...@odata.type`
 * properties aren't specified. Also note that `PartitionKey` and `RowKey`
 * properties must be specified.
 *
 * Return a promise for the `etag` of the inserted entity.
 */
Table.prototype.insertEntity = function insertEntity(table, entity) {
  // Construct path
  var path = '/' + table;
  // Construct headers
  var headers = {
    'prefer':       'return-no-content' // There is no reason to return content
  };
  // Send request with retry logic
  return this.request('POST', path, {}, headers, entity).then(function(res) {
    if (res.statusCode !== 204) {
      throw new Error("insertEntity: Unexpected statusCode: " + res.statusCode);
    }
    return res.headers['etag'];
  });
};


/**
 * Update entity from `table` identified by `partitionKey` and `rowKey`.
 * Options are **required** for this method and takes form as follows:
 * ```js
 * {
 *   mode:  'replace' || 'merge'  // Replace entity or merge entity
 *   eTag:  '...' || '*' || null  // Update specific entity, any or allow insert
 * }
 * ```
 * If `options.mode` is `'replace'` the remote entity will be completely
 * replaced by the structure given as `entity`. If `options.mode` is `'merge'`
 * properties from `entity` will overwrite existing properties on remote entity.
 *
 * If `options.eTag` is not given (or `null`) the remote entity will be inserted
 * if it does not exist, and otherwise replaced or merged depending on `mode`.
 * If `options.eTag` is the string `'*'` the remote entity will be replaced or
 * merged depending on `mode`, but it will not be inserted if it doesn't exist.
 * If `options.eTag` is a string (other than `'*'`) the remote entity will be
 * replaced or merged depending on `mode`, if the ETag of the remote entity
 * matches the string given in `options.eTag`.
 *
 * Combining `mode` and `eTag` options this method implements the following
 * operations:
 *  * Insert or replace (regardless of existence or ETag),
 *  * Replace if exists (regardless of ETag),
 *  * Replace if exists and has given ETag,
 *  * Insert or merge (regardless of existence or ETag),
 *  * Merge if exists (regardless of ETag), and
 *  * Merge if exists and has given ETag.
 *
 * Returns promise for `eTag` of the modified entity.
 */
Table.prototype.updateEntity = function updateEntity(table, partitionKey,
                                                     rowKey, entity, options) {
  assert(options, "Options is required for updateEntity");

  // Construct path
  var path = buildEntityPath(table, partitionKey, rowKey);

  // Choose method
  var method;
  if (options.mode === 'replace') {
    method = 'PUT';
  } else if (options.mode === 'merge') {
    method = 'MERGE';
  } else {
    throw new Error("`options.mode` must be 'replace' or 'merge'");
  }

  // Construct headers
  var headers = {
    'prefer':       'return-no-content' // There is no reason to return content
  };
  if (options.eTag) {
    headers['if-match'] = options.eTag;  // Must be either '*' or an actual ETag
  }

  // Send request with retry logic
  return this.request(method, path, {}, headers, entity).then(function(res) {
    if (res.statusCode !== 204) {
      throw new Error("insertEntity: Unexpected statusCode: " + res.statusCode);
    }
    return res.headers['etag'];
  });
};


/**
 * Delete entity identified by `partitionKey` and `rowKey` from `table`.
 * Options are **required** for this method and takes form as follows:
 * ```js
 * {
 *   eTag:   '...' || '*'   // ETag to delete, or '*' to ignore ETag
 * }
 * ```
 * Note, `options.eTag` is `'*'` will delete the entity regardless of its ETag.
 */
Table.prototype.deleteEntity = function deleteEntity(table, partitionKey,
                                                     rowKey, options) {
  // Construct path
  var path = buildEntityPath(table, partitionKey, rowKey);

  // Construct header
  assert(options && (options.eTag), "`options.eTag` must be given");
  var headers = {
    'if-match':    options.eTag
  };

  // Send request with retry logic
  return this.request('DELETE', path, {}, headers).then(function(res) {
    if (res.statusCode !== 204) {
      throw new Error("insertEntity: Unexpected statusCode: " + res.statusCode);
    }
  });
};

