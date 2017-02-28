var XML = require('pixl-xml');

/* Parse queue error, return: {message, code, detail} */
exports.parseError = function parseError(res) {
  // Parse payload for error message and code
  var result = {
    message: null,
    code: null,
    detail: undefined
  };
  try {
    var xml = XML.parse(res.payload);

    result.message = xml.Message;
    result.code = xml.Code;
    result.detail = xml.AuthenticationErrorDetail;
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
  var xml = XML.parse(res.payload);

  var queues = (xml.Queues || {}).Queue || [];
  if (!(queues instanceof Array)) {
    queues = [queues];
  }

  var result = {
    queues: queues.map(function(queue) {
      var metadata = undefined;
      if (queue.hasOwnProperty('Metadata')) {
        metadata = queue.Metadata || {};
      }
      return {
        name: queue.Name,
        metadata: metadata
      };
    })
  };

  // Get Marker, Prefix, MaxResults and NextMarker, if present
  if (xml.hasOwnProperty('Marker')) {
    result.marker = xml.Marker;
  }
  if (xml.hasOwnProperty('Prefix')) {
    result.prefix = xml.Prefix;
  }
  if (xml.hasOwnProperty('MaxResults')) {
    result.maxResults = parseInt(xml.MaxResults);
  }
  if (xml.hasOwnProperty('NextMarker')) {
    result.nextMarker = xml.NextMarker;
  }

  // Return result
  return result;
};

/* Parse list of peeked messages */
exports.queueParsePeekMessages = function queueParsePeekMessages(res) {
  var xml = XML.parse(res.payload);
  var msgs = xml.QueueMessage || [];
  if (!(msgs instanceof Array)) {
    msgs = [msgs];
  }
  return msgs.map(function(msg) {
    return {
      messageId:        msg.MessageId,
      insertionTime:    new Date(msg.InsertionTime),
      expirationTime:   new Date(msg.ExpirationTime),
      dequeueCount:     parseInt(msg.DequeueCount),
      messageText:      msg.MessageText
    };
  });
};

/* Parse list of messages */
exports.queueParseGetMessages = function queueParseGetMessages(res) {
  var xml = XML.parse(res.payload);
  var msgs = xml.QueueMessage || [];
  if (!(msgs instanceof Array)) {
    msgs = [msgs];
  }
  return msgs.map(function(msg) {
    return {
      messageId:        msg.MessageId,
      insertionTime:    new Date(msg.InsertionTime),
      expirationTime:   new Date(msg.ExpirationTime),
      dequeueCount:     parseInt(msg.DequeueCount),
      messageText:      msg.MessageText,
      popReceipt:       msg.PopReceipt,
      timeNextVisible:  new Date(msg.TimeNextVisible)
    };
  });
};

/* Parse list of containers and return object for listContainers */
exports.blobParseListContainers = function blobParseListContainers(res) {
  // Get results
  var xml = XML.parse(res.payload);
  var containers  = (xml.Containers || {}).Container || [];

  if(!(containers instanceof Array)) {
    containers = [containers];
  }

  // Construct results
  var result = {
    containers: containers.map(function(container) {
      var metadata = undefined;
      if (container.hasOwnProperty('Metadata')) {
        metadata = container.Metadata || {};
      }
      var properties = undefined;
      if (container.hasOwnProperty('Properties')) {
        properties = {};
        properties.eTag = container.Properties.Etag;
        properties.lastModified = container.Properties['Last-Modified'];
        properties.leaseStatus = container.Properties.LeaseStatus;
        properties.leaseState = container.Properties.LeaseState;
        if (container.Properties.hasOwnProperty('LeaseDuration')) {
          properties.leaseDuration = container.Properties.LeaseDuration;
        }
        if (container.Properties.hasOwnProperty('PublicAccess')) {
          properties.publicAccessLevel = container.Properties.PublicAccess;
        }
      }

      return {
        name:       container.Name,
        properties: properties,
        metadata:   metadata
      };
    })
  };

  // Get Marker, Prefix, MaxResults and NextMarker, if present
  if (xml.hasOwnProperty('Marker')) {
    result.marker = xml.Marker;
  }
  if (xml.hasOwnProperty('Prefix')) {
    result.prefix = xml.Prefix;
  }
  if (xml.hasOwnProperty('MaxResults')) {
    result.maxResults = parseInt(xml.MaxResults);
  }
  if (xml.hasOwnProperty('NextMarker')) {
    result.nextMarker = xml.NextMarker;
  }

  // Return result
  return result;
};

/* Parse container ACL and return object to getContainerACL */
exports.blobParseContainerACL = function blobParseContainerACL(response) {
  var xml = XML.parse(response.payload);
  var signedIdentifiers  = xml.SignedIdentifier || [];

  if(!(signedIdentifiers instanceof Array)) {
    signedIdentifiers = [signedIdentifiers];
  }

  var result = [];
  // Construct results
  result = signedIdentifiers.map(function(signedIdentifier) {
    var policy = {};
    policy.id = signedIdentifier.Id;

    if (signedIdentifier.hasOwnProperty('AccessPolicy')){
      var accessPolicy = signedIdentifier.AccessPolicy;

      if (accessPolicy.hasOwnProperty('Start')) {
        policy.start = accessPolicy.Start;
      }
      if (accessPolicy.hasOwnProperty('Expiry')) {
        policy.expiry = accessPolicy.Expiry;
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
      if (accessPolicy.hasOwnProperty('Permission')) {
        var permission = accessPolicy.Permission;
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
  var xml = XML.parse(response.payload);

  var blobs  = (xml.Blobs || {}).Blob || [];

  if(!(blobs instanceof Array)) {
    blobs = [blobs];
  }

  var result = {};
  result.blobs = blobs.map(function(blob) {
    var theBlob = {};

    theBlob.name = blob.Name;
    if (blob.hasOwnProperty('Snapshot')) {
      theBlob.snapshot = blob.Snapshot;
    }

    var properties = blob.Properties;
    if (properties.hasOwnProperty('Last-Modified')){
      theBlob.lastModified = properties['Last-Modified'];
    }
    if (properties.hasOwnProperty('Etag')){
      theBlob.eTag = properties.Etag;
    }
    if (properties.hasOwnProperty('Content-Length')){
      theBlob.contentLength = properties['Content-Length'];
    }
    if (properties.hasOwnProperty('Content-Type')){
      theBlob.contentType = properties['Content-Type'];
    }
    if (properties.hasOwnProperty('Content-Encoding')){
      theBlob.contentEncoding = properties['Content-Encoding'];
    }
    if (properties.hasOwnProperty('Content-Language')){
      theBlob.contentLanguage = properties['Content-Language'];
    }
    if (properties.hasOwnProperty('Content-MD5')){
      theBlob.contentMD5 = properties['Content-MD5'];
    }
    if (properties.hasOwnProperty('Cache-Control')){
      theBlob.cacheControl = properties['Cache-Control'];
    }

    if (properties.hasOwnProperty('x-ms-blob-sequence-number')){
      theBlob.xmsBlobSequenceNumber = properties['x-ms-blob-sequence-number'];
    }
    theBlob.type = properties.BlobType;

    if (properties.hasOwnProperty('LeaseStatus')){
      theBlob.leaseStatus = properties.LeaseStatus;
    }
    if (properties.hasOwnProperty('LeaseState')){
      theBlob.leaseState = properties.LeaseState;
    }
    if (properties.hasOwnProperty('LeaseDuration')){
      theBlob.leaseDuration = properties.LeaseDuration;
    }

    if (properties.hasOwnProperty('CopyId')){
      theBlob.copyId = properties.CopyId;
    }
    if (properties.hasOwnProperty('CopyStatus')){
      theBlob.copyStatus = properties.CopyStatus;
    }
    if (properties.hasOwnProperty('CopySource')){
      theBlob.copySource = properties.CopySource;
    }
    if (properties.hasOwnProperty('CopyProgress')){
      theBlob.copyProgress = properties.CopyProgress;
    }
    if (properties.hasOwnProperty('CopyCompletionTime')){
      theBlob.copyCompletionTime = properties.CopyCompletionTime;
    }
    if (properties.hasOwnProperty('CopyStatusDescription')){
      theBlob.copyStatusDescription = properties.CopyStatusDescription;
    }

    theBlob.serverEncrypted = properties.ServerEncrypted;

    var metadata = undefined;
    if (blob.hasOwnProperty('Metadata')) {
      metadata = blob.Metadata || {};
    }

    if (metadata) {
      theBlob.metadata = metadata;
    }

    return theBlob;
  });

  // Get Marker, Prefix, MaxResults and NextMarker, if present
  if (xml.hasOwnProperty('Marker')) {
    result.marker = xml.Marker;
  }
  if (xml.hasOwnProperty('Prefix')) {
    result.prefix = xml.Prefix;
  }
  if (xml.hasOwnProperty('MaxResults')) {
    result.maxResults = parseInt(xml.MaxResults);
  }
  if (xml.hasOwnProperty('NextMarker')) {
    result.nextMarker = xml.NextMarker;
  }
  if (xml.hasOwnProperty('Delimiter')) {
    result.delimiter = xml.Delimiter;
  }

  // Return result
  return result;
};

/* Parse list of blocks and return object for getBlockList */
exports.blobParseListBlock = function blobParseListBlock(response) {
  var xml = XML.parse(response.payload);

  var result = {};

  var getBlockInfo = function(block){
    return {
      blockId: block.Name,
      size: block.Size
    }
  };

  if (xml.hasOwnProperty('CommittedBlocks')) {
    var blocks  = (xml.CommittedBlocks || {}).Block || [];

    if(!(blocks instanceof Array)) {
      blocks = [blocks];
    }

    result.committedBlocks = blocks.map(getBlockInfo);
  }
  if (xml.hasOwnProperty('UncommittedBlocks')) {
    var blocks  = (xml.UncommittedBlocks || {}).Block || [];

    if(!(blocks instanceof Array)) {
      blocks = [blocks];
    }
    result.uncommittedBlocks = blocks.map(getBlockInfo);
  }

  return result;
};

/* Parse the blob service properties and return object for getServiceProperties */
exports.blobParseServiceProperties = function blobParseServiceProperties(response) {
  var xml = XML.parse(response.payload);

  var result = {};

  if (xml.hasOwnProperty('Logging')) {
    result.logging = {
      version: xml.Logging.Version,
      delete: xml.Logging.Delete,
      read: xml.Logging.Read,
      write: xml.Logging.Write,
      retentionPolicy: {
        enabled: xml.Logging.RetentionPolicy.Enabled
      }
    };
    if (xml.Logging.RetentionPolicy.hasOwnProperty('Days')){
      result.logging.retentionPolicy.days = xml.Logging.RetentionPolicy.Days;
    }
  }

  if (xml.hasOwnProperty('HourMetrics')) {
    result.hourMetrics = {
      version: xml.HourMetrics.Version,
      enabled: xml.HourMetrics.Enabled
    };
    if (xml.HourMetrics.hasOwnProperty('IncludeAPIs')) {
      result.hourMetrics.includeAPIs = xml.HourMetrics.IncludeAPIs;
    }
    result.hourMetrics.retentionPolicy = {
      enabled: xml.HourMetrics.RetentionPolicy.Enabled
    };
    if (xml.HourMetrics.RetentionPolicy.hasOwnProperty('Days')){
      result.hourMetrics.retentionPolicy.days = xml.HourMetrics.RetentionPolicy.Days;
    }
  }
  if (xml.hasOwnProperty('MinuteMetrics')) {
    result.minuteMetrics = {
      version: xml.MinuteMetrics.Version,
      enabled: xml.MinuteMetrics.Enabled
    };
    if (xml.MinuteMetrics.hasOwnProperty('IncludeAPIs')) {
      result.minuteMetrics.includeAPIs = xml.MinuteMetrics.IncludeAPIs;
    }
    result.minuteMetrics.retentionPolicy = {
      enabled: xml.MinuteMetrics.RetentionPolicy.Enabled
    };
    if (xml.MinuteMetrics.RetentionPolicy.hasOwnProperty('Days')){
      result.minuteMetrics.retentionPolicy.days = xml.MinuteMetrics.RetentionPolicy.Days;
    }
  }
  if (xml.hasOwnProperty('Cors')) {
    var rules  = (xml.Cors || {}).CorsRule || [];
    if(!(rules instanceof Array)) {
      rules = [rules];
    }
    result.corsRules = rules.map(function(rule) {
      return {
        allowedOrigins: rule.AllowedOrigins,
        allowedMethods: rule.AllowedMethods,
        maxAgeInSeconds: rule.MaxAgeInSeconds,
        exposedHeaders: rule.ExposedHeaders,
        allowedHeaders: rule.AllowedHeaders
      };
    });
  }

  return result;
};