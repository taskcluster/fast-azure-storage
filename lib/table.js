'use strict';

var assert      = require('assert');
var debug       = require('debug')('azure:table');
var Promise     = require('promise');
var querystring = require('querystring');
var crypto      = require('crypto');
var events      = require('events');
var util        = require('util');
var agent       = require('./agent');
var utils       = require('./utils');
var auth        = require('./authorization');

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
 * Authorize the request with shared key
 * Intended to define `Table.prototype.authorize`.
 */
var authorizeWithSharedKey = function (method, path, query, headers) {
  // Find account id
  var accountId = this.options.accountId;

  // Build list of lines to sign, we'll join with '\n' before signing the list
  var stringToSign = (
    method + '\n' +
    (headers['content-md5']  || '') + '\n' +
    (headers['content-type'] || '') + '\n' +
    headers['x-ms-date']
  );

  // Added lines from canonicalized resource and query-string parameters
  // supported by this library in lexicographical order as presorted in
  // QUERY_PARAMS_SUPPORTED
  stringToSign += '\n/' + accountId + path;
  if (query.comp !== undefined) {
    stringToSign += '?comp=' + query.comp;
  }

  // Compute signature
  var signature = utils.hmacSha256(this._accessKey, stringToSign);

  // Set authorization header
  headers.authorization = 'SharedKey ' + accountId + ':' + signature;

  // Encode query string
  var qs = querystring.stringify(query);

  // Construct request options
  return Promise.resolve({
    host:       this.hostname,
    method:     method,
    path:       (qs.length > 0 ? path + '?' + qs : path),
    headers:    headers,
    agent:      this.options.agent,
  });
}

/**
 * Table client class for interacting with Azure Table Storage.
 *
 * Subclasses `EventEmitter` and emits the `error` event on failure to refresh
 * shared-access-signature, if `options.sas` is a function.
 *
 * @class Table
 * @constructor
 * @param {object} options - Options on the following form:
 * ```js
 * {
 *   // Value for the `x-ms-version` header fixing the API version
 *   version:              '2014-02-14',
 *
 *   // OData Service version, must work with API version, refer to azure
 *   // documentation. This just specifies the `DataServiceVersion` header.
 *   dataServiceVersion:   '3.0',
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
 *   // Set meta-data level for responses (use full to get eTag in queryEntities)
 *   metadata:             'fullmetadata',
 *
 *   // HTTP Agent to use (defaults to a global azure.Agent instance)
 *   agent:                agent.globalAgent,
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
function Table(options) {
  // Initialize EventEmitter parent class
  events.EventEmitter.call(this);

  // Set default options
  this.options = {
    version:              '2014-02-14',
    dataServiceVersion:   '3.0',
    clientId:             'fast-azure-storage',
    timeout:              30 * 1000,
    clientTimeoutDelay:   500,
    metadata:             'fullmetadata',
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
  assert(
    this.options.metadata === 'nometadata' ||
    this.options.metadata === 'minimalmetadata' ||
    this.options.metadata === 'fullmetadata',
    "options.metadata must be 'nometadata', 'minimalmetadata' or 'fullmetadata'"
  );

  // Construct hostname
  this.hostname = this.options.accountId + '.table.core.windows.net';

  // Compute `timeout` for client-side timeout (in ms), and `timeoutInSeconds`
  // for server-side timeout in seconds.
  this.timeout = this.options.timeout + this.options.clientTimeoutDelay;
  this.timeoutInSeconds = Math.floor(this.options.timeout / 1000);

  // Define `this.authorize`
  if (this.options.accessKey) {
    // If set authorize to use shared key signatures
    this.authorize = auth.authorizeWithSharedKey.call(this, 'table');
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

// Subclass EventEmitter
util.inherits(Table, events.EventEmitter);

// Export Table
module.exports = Table;

/**
 * Generate a SAS string on the form `'key1=val1&key2=val2&...'`.
 *
 * @method sas
 * @param {string} table - Name of table that this SAS string applies to.
 * @param {object} options - Options for the following form:
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
 * @returns {string} Shared-Access-Signature on string form.
 */
Table.prototype.sas = function(table, options) {
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
    query.si = options.accessPolicy;
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
 * @param {string} path - Path on table resource for storage account.
 * @param {object} query - Query-string parameters.
 * @param {object} header - Mapping from header key in lowercase to value.
 * @returns {Promise} A promise for an options object compatible with
 * `https.request`.
 */
Table.prototype.authorize = function(method, path, query, headers) {
  throw new Error("authorize is not implemented, must be defined!");
};

/**
 * Make a signed request to `path` using `method` in upper-case and all `query`
 * parameters and `headers` keys in lower-case. The request will carry `json`
 * as payload and will be retried using the configured retry policy.
 *
 * @private
 * @method request
 * @param {string} method - HTTP verb in upper case, e.g. `GET`.
 * @param {string} path - Path on table resource for storage account.
 * @param {object} query - Query-string parameters.
 * @param {object} header - Mapping from header key in lowercase to value.
 * @param {object} json - Optional JSON object to send as payload.
 * @returns {Promise} A promise for the HTTP response object with a `payload`
 * property carrying the payload as string.
 */
Table.prototype.request = function request(method, path, query, headers, json) {
  // Set timeout, if not provided
  if (query.timeout === undefined) {
    query.timeout = this.timeoutInSeconds;
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
    const start = process.hrtime();
    return utils.retry(function(retry) {
      debug("Request: %s %s, retry: %s", method, path, retry);

      // Construct a promise chain first handling the request, and then parsing
      // any potential error message
      return utils.request(options, data, self.timeout).then(function(res) {
        let d = process.hrtime(start);
        d = d[0] * 1000 + d[1] / 1000000; // Transform into milliseconds
        if (d > 2000) {
          console.log(`BUG-1481178-FAS-LONG-REQ: ${method} on ${path} with ${JSON.stringify(query)} took ${d} milliseconds.`);
        }

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
        } catch (e) {
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
        err.method      = method;
        err.path        = path;
        err.query       = query;
        err.headers     = headers;
        err.requestBody = json;

        debug("Error code: %s (%s) for %s %s on retry: %s",
              code, res.statusCode, method, path, retry);

        // Throw the constructed error
        throw err;
      });
    }, self.options);
  });
};

/**
 * Query for tables on the storage account.
 *
 * @method queryTables
 * @param {object} options - `options` on the following form:
 * ```js
 * {
 *   nextTableName:      '...'  // nextTableName, if paging
 * }
 * ```
 * @returns {Promise} A promise for an object on the form:
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
    var payload = utils.parseJSON(res.payload);
    return {
      tables:   payload.value.map(function(table) {
        return table.TableName;
      }),
      nextTableName: res.headers['x-ms-continuation-nexttablename'] || null
    };
  });
};

/**
 * Create table with given `name`.
 *
 * @method createTable
 * @param {string} name - Name of table to create.
 * @return {Promise} A promise that the table was created.
 */
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

/**
 * Delete table with given `name`
 *
 * @method deleteTable
 * @param {string} name - Name of table to delete.
 * @return {Promise} A promise that the table was marked for deletion.
 */
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
 *
 * @method filter
 * @param {Array} expression - Array of arrays, keys, operators and formatted
 * constants that forms an expression, where arrays becomes parenthesis:
 * ```js
 * var op = azure.Table.Operators;
 * var filter = azure.Table.filter([
 *  ['key1', op.Equal, op.string('my-string')],
 *   op.And,
 *  ['key2', op.LessThan, op.date(new Date())]
 * ]) // "((key1 eq 'my-string') and (key2 le datetime'...'))"
 * ```
 * @returns {string} A filter string for use with `queryEntities`.
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
 *  - `azure.Table.Operators.Equal`,
 *  - `azure.Table.Operators.GreaterThan`,
 *  - `azure.Table.Operators.GreaterThanOrEqual`,
 *  - `azure.Table.Operators.LessThan`,
 *  - `azure.Table.Operators.LessThanOrEqual`, and
 *  - `azure.Table.Operators.NotEqual`.
 *
 * They should be used in the middle of a triple as follows:
 * `['key1', op.Equal, op.string('my-string')]`.
 *
 * The boolean operators `And`, `Not` and `Or` should be used to connect
 * triples made with comparison operators. Note, that each set of array brackets
 * translates into a parentheses. Boolean operators:
 *  - `azure.Table.Operators.And`,
 *  - `azure.Table.Operators.Not`, and
 *  - `azure.Table.Operators.Or`.
 *
 * We also have formatting helpers, `string`, `number`, `bool`, `date` and
 * `guid` which takes constant values and encodes them correctly for use in
 * filter expression. It's strongly recommended that you employ these, as Azure
 * has some undocumented and semi obscure escaping rules. Constant formatters:
 *  - `azure.Table.Operators.string("...")`,
 *  - `azure.Table.Operators.number(42.2)`,
 *  - `azure.Table.Operators.bool(true)`,
 *  - `azure.Table.Operators.date(new Date())`, and
 *  - `azure.Table.Operators.guid('...')`.
 *
 * Complete example:
 * ```js
 * var op = azure.Table.Operators;
 * var filter = azure.Table.filter([
 *  ['key1', op.Equal, op.string('my-string')],
 *   op.And,
 *  ['key2', op.LessThan, op.date(new Date())]
 * ]) // "((key1 eq 'my-string') and (key2 le datetime'...'))"
 * ```
 *
 * @attribute Operators
 * @static
 * @final
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
  date: function(c)   { return "datetime'" + c.toJSON() + "'";      },
  guid: function(c)   { return "guid'" + c + "'";                 }
};

/*
 * Auxiliary function to construct the entity path as used in many methods.
 * Format: `/<tabel>(PartitionKey='<partitionKey>',RowKey='<rowKey>')`.
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
 * @method getEntity
 * @param {string} table - Name of table to get entity from.
 * @param {string} partitionKey - Partition key of entity to get.
 * @param {string} rowKey - Row key of entity to get.
 * @param {object} options - Options on the following form:
 * ```js
 * {
 *   select:  ['key1', ...],  // List of keys to return (defaults to all)
 *   filter:  '...'           // Filter string for conditional load
 * }
 * ```
 * @return {Promise}
 * A promise for the entity, form of the object depends on the meta-data
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
    return utils.parseJSON(res.payload);
  });
};


/**
 * Query entities from `table`.
 *
 * @method queryEntitites
 * @param {string} table - Name of table to query entities for.
 * @param {object} options - Options on the following form:
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
 * @return {Promise} A promise for an object on the form:
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
      if (options.top > 1000) {
        throw new Error('queryEntities: Too Large Query: top of ' + options.top + ' > 1000');
      }
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
    var result            = utils.parseJSON(res.payload);
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
 * @method insertEntity
 * @param {string} table - Name of table insert entity into.
 * @param {object} entity - Entity object, see Azure Table Storage
 * documentation for details on how to annotate types.
 * @return {Promise}
 * A promise for the `etag` of the inserted entity.
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
 * Update entity from `table` identified by `entity.partitionKey` and
 * `entity.rowKey`.
 * Options are **required** for this method and takes form as follows:
 * ```js
 * {
 *   mode:  'replace' || 'merge'  // Replace entity or merge entity
 *   eTag:  '...' || '*' || null  // Update specific entity, any or allow insert
 * }
 * ```
 *
 * If `options.mode` is `'replace'` the remote entity will be completely
 * replaced by the structure given as `entity`. If `options.mode` is `'merge'`
 * properties from `entity` will overwrite existing properties on remote entity.
 *
 * If **`options.eTag` is not given** (or `null`) the remote entity will be
 * inserted if it does not exist, and otherwise replaced or merged depending
 * on `mode`.
 *
 * If **`options.eTag` is the string `'*'`** the remote entity will be replaced
 * or merged depending on `mode`, but it will not be inserted if it doesn't
 * exist.
 *
 * If **`options.eTag` is a string** (other than `'*'`) the remote entity will be
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
 * @method updateEntity
 * @param {string} table - Name of table to update entity from.
 * @param {object} options - Options on the following form:
 * ```js
 * {
 *   mode:  'replace' || 'merge'  // Replace entity or merge entity
 *   eTag:  '...' || '*' || null  // Update specific entity, any or allow insert
 * }
 * ```
 * @return {Promise} A promise for `eTag` of the modified entity.
 */
Table.prototype.updateEntity = function updateEntity(table, entity, options) {
  assert(options, "Options is required for updateEntity");

  // Construct path
  var path = buildEntityPath(table, entity.PartitionKey, entity.RowKey);

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
 *
 * Note, `options.eTag` is `'*'` will delete the entity regardless of its ETag.
 *
 * @method deleteEntity
 * @param {string} table - Name of table to delete entity from.
 * @param {string} partitionKey - Partition key of entity to delete.
 * @param {string} rowKey - Row key of entity to delete.
 * @param {object} options - Options on the following form:
 * ```js
 * {
 *   eTag:   '...' || '*'   // ETag to delete, or '*' to ignore ETag
 * }
 * ```
 * @returns {Promise} A promise that the entity was deleted.
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

