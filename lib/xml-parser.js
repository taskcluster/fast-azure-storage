const xml2js = require('xml2js');

// xml2js uses a callback calling pattern for a sync operation.  Ok..  happily,
// the `async: false` forces it to call back before returning, so we can just
// wrap it to make it sync.
const parseString = string => {
  let err, rv;
  xml2js.parseString(string, (e, r) => { err = e; rv = r; });
  if (err) {
    throw err;
  }
  return rv;
};

const getValue = function(obj) {
  const args = Array.prototype.slice.call(arguments, 1);
  while (args.length) {
    obj = obj[args[0]];
    if (obj === undefined) {
      return obj;
    }
    args.shift();
  }
  return obj;
};

// ensure a thing is an array, returning an empty array if it's undefined
const array = obj => obj ? obj : [];

/* Parse queue error, return: {message, code, detail} */
exports.parseError = function parseError(res) {
  // Parse payload for error message and code
  const result = {
    message: null,
    code: null,
    detail: undefined
  };
  try {
    const xml = parseString(res.payload);
    result.message = getValue(xml, 'Error', 'Message', 0);
    result.code = getValue(xml, 'Error', 'Code', 0);
    result.detail = getValue(xml, 'Error', 'AuthenticationErrorDetail', 0);
  } catch (e) {
    // Ignore parsing errors
  }

  // Find default message and code
  if (!result.message) {
    result.message = "No error message given, in payload '" + res.payload + "'";
  }
  if (!result.code) {
    if (500 <= res.statusCode && res.statusCode < 600) {
      result.code = 'InternalErrorWithoutCode';
    } else {
      result.code = 'ErrorWithoutCode';
    }
  }

  // Return result
  return result;
};


/* Parse list of queues and return object for listQueues */
exports.queueParseListQueues = function queueParseListQueues(res) {
  // Get results
  const xml = parseString(res.payload);

  const queues = array(getValue(xml, 'EnumerationResults', 'Queues', 0, 'Queue'));

  const result = {
    queues: queues.map(function(queue) {
      const metadata = getValue(queue, 'Metadata', 0);
      if (metadata) {
        for (let k of Object.keys(metadata)) {
          metadata[k] = metadata[k][0];
        }
      }
      return {
        name: getValue(queue, 'Name', 0),
        metadata,
      };
    })
  };

  // Get Marker, Prefix, MaxResults and NextMarker, if present
  result.marker = getValue(xml, 'EnumerationResults', 'Marker', 0);
  result.prefix = getValue(xml, 'EnumerationResults', 'Prefix', 0);
  result.maxResults = parseInt(getValue(xml, 'EnumerationResults', 'MaxResults', 0));
  result.nextMarker = getValue(xml, 'EnumerationResults', 'NextMarker', 0);

  // Return result
  return result;
};

/* Parse list of peeked messages */
exports.queueParsePeekMessages = function queueParsePeekMessages(res) {
  const xml = parseString(res.payload);
  const msgs = array(getValue(xml, 'QueueMessagesList', 'QueueMessage'));
  return msgs.map(function(msg) {
    return {
      messageId:        getValue(msg, 'MessageId', 0),
      insertionTime:    new Date(getValue(msg, 'InsertionTime', 0)),
      expirationTime:   new Date(getValue(msg, 'ExpirationTime', 0)),
      dequeueCount:     parseInt(getValue(msg, 'DequeueCount', 0)),
      messageText:      getValue(msg, 'MessageText', 0),
    };
  });
};

/* Parse list of messages */
exports.queueParseGetMessages = function queueParseGetMessages(res) {
  const xml = parseString(res.payload);
  const msgs = array(getValue(xml, 'QueueMessagesList', 'QueueMessage'));
  return msgs.map(function(msg) {
    return {
      messageId:        getValue(msg, 'MessageId', 0),
      insertionTime:    new Date(getValue(msg, 'InsertionTime', 0)),
      expirationTime:   new Date(getValue(msg, 'ExpirationTime', 0)),
      dequeueCount:     parseInt(getValue(msg, 'DequeueCount', 0)),
      messageText:      getValue(msg, 'MessageText', 0),
      popReceipt:       getValue(msg, 'PopReceipt', 0),
      timeNextVisible:  new Date(getValue(msg, 'TimeNextVisible', 0)),
    };
  });
};

/* Parse list of containers and return object for listContainers */
exports.blobParseListContainers = function blobParseListContainers(res) {
  // Get results
  const xml = parseString(res.payload);
  const containers  = array(getValue(xml, 'EnumerationResults', 'Containers', 0, 'Container'));

  // Construct results
  const result = {
    containers: containers.map(function(container) {
      let metadata = getValue(container, 'Metadata', 0);
      if (metadata) {
        for (let k of Object.keys(metadata)) {
          metadata[k] = metadata[k][0];
        }
      }
      const props = getValue(container, 'Properties', 0);
      const properties = {
        eTag: undefined,
        lastModified: undefined,
        leaseStatus: undefined,
        leaseState: undefined,
      };

      if (props) {
        properties.eTag = getValue(props, 'Etag', 0);
        properties.lastModified = getValue(props, 'Last-Modified', 0);
        properties.leaseStatus = getValue(props, 'LeaseStatus', 0);
        properties.leaseState = getValue(props, 'LeaseState', 0);
        leaseDuration = getValue(props, 'LeaseDuration', 0);
        if (leaseDuration) {
          properties.leaseDuration = leaseDuration;
        }
        publicAccessLevel = getValue(props, 'PublicAccess', 0);
        if (publicAccessLevel) {
          properties.publicAccessLevel = publicAccessLevel;
        }
      }

      return {
        name:       getValue(container, 'Name', 0),
        properties: properties,
        metadata:   metadata,
      };
    })
  };

  // Get Marker, Prefix, MaxResults and NextMarker, if present
  const marker = getValue(xml, 'EnumerationResults', 'Marker', 0);
  if (marker !== undefined) {
    result.marker = marker;
  }
  const prefix = getValue(xml, 'EnumerationResults', 'Prefix', 0);
  if (prefix !== undefined) {
    result.prefix = prefix;
  }
  const maxResults = getValue(xml, 'EnumerationResults', 'MaxResults', 0);
  if (maxResults !== undefined) {
    result.maxResults = parseInt(maxResults);
  }
  const nextMarker = getValue(xml, 'EnumerationResults', 'NextMarker', 0);
  if (nextMarker !== undefined) {
    result.nextMarker = nextMarker;
  }

  // Return result
  return result;
};

/* Parse container ACL and return object to getContainerACL */
exports.blobParseContainerACL = function blobParseContainerACL(response) {
  const xml = parseString(response.payload);
  const signedIdentifiers  = array(getValue(xml, 'SignedIdentifiers', 'SignedIdentifier'));

  // Construct results
  const result = signedIdentifiers.map(function(signedIdentifier) {
    const policy = {};
    policy.id = getValue(signedIdentifier, 'Id', 0);

    const accessPolicy = getValue(signedIdentifier, 'AccessPolicy', 0);
    if (accessPolicy) {
      const start = getValue(accessPolicy, 'Start', 0);
      if (start) {
        policy.start = start;
      }
      const expiry = getValue(accessPolicy, 'Expiry', 0);
      if (expiry) {
        policy.expiry = expiry;
      }

      // Default values for permission
      policy.permission = {
        read: false,
        add: false,
        create: false,
        write: false,
        delete: false,
        list: false
      }
      const permission = getValue(accessPolicy, 'Permission', 0);
      if (permission) {
        policy.permission.read = permission.indexOf('r') !== -1;
        policy.permission.add = permission.indexOf('a') !== -1;
        policy.permission.create = permission.indexOf('c') !== -1;
        policy.permission.write = permission.indexOf('w') !== -1;
        policy.permission.delete = permission.indexOf('d') !== -1;
        policy.permission.list = permission.indexOf('l') !== -1;
      }
    }
    return policy;
  });
  return result;
};

/* Parse list of blobs and return object for listBlobs */
exports.blobParseListBlobs = function blobParseListBlobs(response) {
  const xml = parseString(response.payload);
  const blobs  = array(getValue(xml, 'EnumerationResults', 'Blobs', 0, 'Blob'));

  const result = {blobs: []};
  if (blobs) {
    result.blobs = blobs.map(function(blob) {
      const theBlob = {};

      const b = (name, prop) => {
        const val = getValue(blob, name, 0);
        if (val !== undefined) {
          theBlob[prop] = val;
        }
      };

      const p = (name, prop) => {
        const val = getValue(blob, 'Properties', 0, name, 0);
        if (val !== undefined) {
          theBlob[prop] = val;
        }
      };

      b('Name', 'name');
      b('Snapshot', 'snapshot');
      p('Last-Modified', 'lastModified');
      p('Etag', 'eTag');
      p('Content-Length', 'contentLength');
      p('Content-Type', 'contentType');
      p('Content-Encoding', 'contentEncoding');
      p('Content-Language', 'contentLanguage');
      p('Content-MD5', 'contentMD5');
      p('Cache-Control', 'cacheControl');
      p('x-ms-blob-sequence-number', 'xmsBlobSequenceNumber');
      p('BlobType', 'type');
      p('LeaseStatus', 'leaseStatus');
      p('LeaseState', 'leaseState');
      p('LeaseDuration', 'leaseDuration');
      p('CopyId', 'copyId');
      p('CopyStatus', 'copyStatus');
      p('CopySource', 'copySource');
      p('CopyProgress', 'copyProgress');
      p('CopyCompletionTime', 'copyCompletionTime');
      p('CopyStatusDescription', 'copyStatusDescription');
      p('ServerEncrypted', 'serverEncrypted');

      let metadata = undefined;
      if (Object.hasOwnProperty.bind(blob)('Metadata')) {
        metadata = {};
        for (let k of Object.keys(blob.Metadata[0])) {
          metadata[k] = blob.Metadata[0][k][0];
        }
        theBlob.metadata = metadata;
      }

      return theBlob;
    });
  }

  // Get Marker, Prefix, MaxResults and NextMarker, if present
  const marker = getValue(xml, 'EnumerationResults', 'Marker', 0);
  if (marker !== undefined) {
    result.marker = marker;
  }
  const prefix = getValue(xml, 'EnumerationResults', 'Prefix', 0);
  if (prefix !== undefined) {
    result.prefix = prefix;
  }
  const maxResults = getValue(xml, 'EnumerationResults', 'MaxResults', 0);
  if (maxResults !== undefined) {
    result.maxResults = parseInt(maxResults);
  }
  const nextMarker = getValue(xml, 'EnumerationResults', 'NextMarker', 0);
  if (nextMarker !== undefined) {
    result.nextMarker = nextMarker;
  }
  const delimiter = getValue(xml, 'EnumerationResults', 'Delimiter', 0);
  if (delimiter !== undefined) {
    result.delimiter = delimiter;
  }

  // Return result
  return result;
};

/* Parse list of blocks and return object for getBlockList */
exports.blobParseListBlock = function blobParseListBlock(response) {
  const xml = parseString(response.payload);
  const result = {committedBlocks: [], uncommittedBlocks: []};

  const getBlockInfo = function(block){
    return {
      blockId: getValue(block, 'Name', 0),
      size: getValue(block, 'Size', 0),
    }
  };

  const committedBlocks = array(getValue(xml, 'BlockList', 'CommittedBlocks', 0, 'Block'));
  if (committedBlocks) {
    result.committedBlocks = committedBlocks.map(getBlockInfo);
  }

  const uncommittedBlocks = array(getValue(xml, 'BlockList', 'UncommittedBlocks', 0, 'Block'));
  if (uncommittedBlocks) {
    result.uncommittedBlocks = uncommittedBlocks.map(getBlockInfo);
  }

  return result;
};

/* Parse the blob service properties and return object for getServiceProperties */
exports.blobParseServiceProperties = function blobParseServiceProperties(response) {
  const xml = parseString(response.payload);
  const result = {};

  const logging = getValue(xml, 'StorageServiceProperties', 'Logging', 0);
  if (logging) {
    const retentionPolicy = getValue(logging, 'RetentionPolicy', 0);
    result.logging = {
      version: getValue(logging, 'Version', 0),
      delete: getValue(logging, 'Delete', 0),
      read: getValue(logging, 'Read', 0),
      write: getValue(logging, 'Write', 0),
      retentionPolicy: {
        enabled: getValue(retentionPolicy, 'Enabled', 0),
      },
    };
    const days = getValue(retentionPolicy, 'Days', 0);
    if (days) {
      result.logging.retentionPolicy.days = days;
    }
  }

  const hourMetrics = getValue(xml, 'StorageServiceProperties', 'HourMetrics', 0);
  if (hourMetrics) {
    result.hourMetrics = {
      version: getValue(hourMetrics, 'Version', 0),
      enabled: getValue(hourMetrics, 'Enabled', 0),
    };

    const includeAPIs = getValue(hourMetrics, 'IncludeAPIs', 0);
    if (includeAPIs) {
      result.hourMetrics.includeAPIs = includeAPIs;
    }
    result.hourMetrics.retentionPolicy = {
      enabled: getValue(hourMetrics, 'RetentionPolicy', 0, 'Enabled', 0),
    };

    const days = getValue(hourMetrics, 'RetentionPolicy', 0, 'Days', 0);
    if (days) {
      result.hourMetrics.retentionPolicy.days = days;
    }
  }

  const minuteMetrics = getValue(xml, 'StorageServiceProperties', 'MinuteMetrics', 0);
  if (minuteMetrics) {
    result.minuteMetrics = {
      version: getValue(minuteMetrics, 'Version', 0),
      enabled: getValue(minuteMetrics, 'Enabled', 0),
    };

    const includeAPIs = getValue(minuteMetrics, 'IncludeAPIs', 0);
    if (includeAPIs) {
      result.minuteMetrics.includeAPIs = includeAPIs;
    }
    result.minuteMetrics.retentionPolicy = {
      enabled: getValue(minuteMetrics, 'RetentionPolicy', 0, 'Enabled', 0),
    };

    const days = getValue(minuteMetrics, 'RetentionPolicy', 0, 'Days', 0);
    if (days) {
      result.minuteMetrics.retentionPolicy.days = days;
    }
  }

  const corsRules = array(getValue(xml, 'StorageServiceProperties', 'Cors', 0, 'CorsRule'));
  if (corsRules) {
    result.corsRules = corsRules.map(function(rule) {
      return {
        allowedOrigins: getValue(rule, 'AllowedOrigins', 0),
        allowedMethods: getValue(rule, 'AllowedMethods', 0),
        maxAgeInSeconds: getValue(rule, 'MaxAgeInSeconds', 0),
        exposedHeaders: getValue(rule, 'ExposedHeaders', 0),
        allowedHeaders: getValue(rule, 'AllowedHeaders', 0),
      };
    });
  }

  return result;
};
