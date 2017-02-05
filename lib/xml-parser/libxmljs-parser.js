var libxml = require('libxmljs');

/* Parse queue error, return: {message, code, detail} */
exports.parseError = function parseError(res) {
  // Parse payload for error message and code
  var result = {
    message: null,
    code: null,
    detail: undefined
  };
  try {
    var xml = libxml.parseXml(res.payload);

    // Find error message
    var message = xml.get('/Error/Message');
    if (message) {
      result.message = message.text();
    }

    // Find error code
    var code = xml.get('/Error/Code');
    if (code) {
      result.code = code.text();
    }

    var detail = xml.get('/Error/AuthenticationErrorDetail');
    if (detail) {
      // pixl-xml parser strips whitespaces from beginning and end of a node value
      result.detail = detail.text().trim();
    }
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
};

/* Parse list of peeked messages */
exports.queueParsePeekMessages = function queueParsePeekMessages(res) {
  var xml = libxml.parseXml(res.payload);
  var msgs = xml.get('/QueueMessagesList').childNodes();
  return msgs.map(function(msg) {
    return {
      messageId:        msg.get('MessageId').text(),
      insertionTime:    new Date(msg.get('InsertionTime').text()),
      expirationTime:   new Date(msg.get('ExpirationTime').text()),
      dequeueCount:     parseInt(msg.get('DequeueCount').text()),
      messageText:      msg.get('MessageText').text()
    };
  });
};

/* Parse list of messages */
exports.queueParseGetMessages = function queueParseGetMessages(res) {
  var xml = libxml.parseXml(res.payload);
  var msgs = xml.get('/QueueMessagesList').childNodes();
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
};

/* Parse list of containers and return object for listContainers */
exports.blobParseListContainers = function blobParseListContainers(res) {
  // Get results
  var xml = libxml.parseXml(res.payload);
  var containers  = xml.get('/EnumerationResults/Containers').childNodes();

  // Construct results
  var result = {
    containers: containers.map(function(container) {
      var metadata = undefined;
      var metaNode = container.get('Metadata');
      if (metaNode) {
        metadata = {};
        metaNode.childNodes().forEach(function(node) {
          metadata[node.name()] = node.text();
        });
      }

      var properties = undefined;
      var propsNode = container.get('Properties');
      if (propsNode) {
        properties = {};
        properties.eTag = propsNode.get('Etag').text();
        properties.lastModified = propsNode.get('Last-Modified').text();
        properties.leaseStatus = propsNode.get('LeaseStatus').text();
        properties.leaseState = propsNode.get('LeaseState').text();
        if (propsNode.get('LeaseDuration')) {
          properties.leaseDuration = propsNode.get('LeaseDuration').text();
        }
        if (propsNode.get('PublicAccess')) {
          properties.publicAccessLevel = propsNode.get('PublicAccess').text();
        }
      }

      return {
        name:       container.get('Name').text(),
        properties: properties,
        metadata:   metadata
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
};

/* Parse container ACL and return object to getContainerACL */
exports.blobParseContainerACL = function blobParseContainerACL(response) {
  var xml = libxml.parseXml(response.payload);
  var signedIdentifiers  = xml.get('/SignedIdentifiers').childNodes();

  // Construct results
  var result = [];
  result = signedIdentifiers.map(function(signedIdentifier) {
    var policy = {};
    var id = signedIdentifier.get('Id');
    if (id) {
      policy.id = id.text();
    }
    var accessPolicy = signedIdentifier.get('AccessPolicy');
    if (accessPolicy) {
      var start = accessPolicy.get('Start');
      if (start) {
        policy.start = start.text();
      }
      var expiry = accessPolicy.get('Expiry');
      if (expiry) {
        policy.expiry = expiry.text();
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
      var permission = accessPolicy.get('Permission');
      if (permission) {
        permission = permission.text();
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
  // return the result
  return result;
};

/* Parse list of blobs and return object for listBlobs */
exports.blobParseListBlobs = function blobParseListBlobs(response) {
  var xml = libxml.parseXml(response.payload);

  var result = {
    blobs: []
  };

  if (xml.get('Blobs')){
    var blobs  = xml.get('Blobs').childNodes();
    result.blobs = blobs.map(function(blob){
      var theBlob = {};

      theBlob.name = blob.get('Name').text();
      var snapshot = blob.get('Snapshot');
      if (snapshot){
        theBlob.snapshot = snapshot.text();
      }

      var properties = blob.get('Properties');
      var lastModified = properties.get('Last-Modified');
      if (lastModified){
        theBlob.lastModified = lastModified.text();
      }
      var eTag = properties.get('Etag');
      if (eTag){
        theBlob.eTag = eTag.text();
      }
      var contentLength = properties.get('Content-Length');
      if (contentLength) {
        theBlob.contentLength = contentLength.text();
      }
      var contentType = properties.get('Content-Type');
      if (contentType) {
        theBlob.contentType = contentType.text();
      }
      var contentEncoding = properties.get('Content-Encoding');
      if (contentEncoding) {
        theBlob.contentEncoding = contentEncoding.text();
      }
      var contentLanguage = properties.get('Content-Language');
      if (contentLanguage) {
        theBlob.contentLanguage = contentLanguage.text();
      }
      var contentMD5 = properties.get('Content-MD5');
      if (contentMD5) {
        theBlob.contentMD5 = contentMD5.text();
      }
      var cacheControl = properties.get('Cache-Control');
      if (cacheControl) {
        theBlob.cacheControl = cacheControl.text();
      }

      var xmsBlobSequenceNumber = properties.get('x-ms-blob-sequence-number');
      if (xmsBlobSequenceNumber) {
        theBlob.xmsBlobSequenceNumber = xmsBlobSequenceNumber.text();
      }
      theBlob.blobType = properties.get('BlobType').text();

      var leaseStatus = properties.get('LeaseStatus');
      if (leaseStatus) {
        theBlob.leaseStatus = leaseStatus.text();
      }
      var leaseState = properties.get('LeaseState');
      if (leaseState) {
        theBlob.leaseState = leaseState.text();
      }
      var leaseDuration = properties.get('LeaseDuration');
      if (leaseDuration) {
        theBlob.leaseDuration = leaseDuration.text();
      }

      var copyId = properties.get('CopyId');
      if(copyId) {
        theBlob.copyId = copyId.text();
      }
      var copyStatus = properties.get('CopyStatus');
      if(copyStatus) {
        theBlob.copyStatus = copyStatus.text();
      }
      var copySource = properties.get('CopySource');
      if(copySource) {
        theBlob.copySource = copySource.text();
      }
      var copyProgress = properties.get('CopyProgress');
      if(copyProgress) {
        theBlob.copyProgress = copyProgress.text();
      }
      var copyCompletionTime = properties.get('CopyCompletionTime');
      if(copyCompletionTime) {
        theBlob.copyCompletionTime = copyCompletionTime.text();
      }
      var copyStatusDescription = properties.get('CopyStatusDescription');
      if(copyStatusDescription) {
        theBlob.copyStatusDescription = copyStatusDescription.text();
      }
      theBlob.serverEncrypted = properties.get('ServerEncrypted').text();

      var metadata = undefined;
      var metaNode = blob.get('Metadata');
      if (metaNode) {
        metadata = {};
        metaNode.childNodes().forEach(function(node) {
          metadata[node.name()] = node.text();
        });
      }

      if (metadata) {
        theBlob.metadata = metadata;
      }

      return theBlob;
    });
  }

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
  if (nextMarker) {
    result.nextMarker = nextMarker.text();
  }
  var delimiter = xml.get('/EnumerationResults/Delimiter');
  if (delimiter) {
    result.nextMarker = delimiter.text();
  }

  return result;
}

/* Parse list of blocks and return object for getBlockList */
exports.blobParseListBlock = function blobParseListBlock(response) {
  var xml = libxml.parseXml(response.payload);

  var result = {};

  var blockList = xml.get('/BlockList');
  var getBlockInfo = function(block) {
    return {
      blockId: block.get('Name').text(),
      size: block.get('Size').text()
    }
  };

  if (blockList.get('CommittedBlocks')) {
    var committedBlocksNodes = blockList.get('CommittedBlocks').childNodes();
    result.committedBlocks = committedBlocksNodes.map(getBlockInfo);
  }
  if (blockList.get('UncommittedBlocks')) {
    var uncommittedBlocks = blockList.get('UncommittedBlocks').childNodes();
    result.uncommittedBlocks = uncommittedBlocks.map(getBlockInfo);
  }

  return result;
}

exports.blobParseServiceProperties = function blobParseServiceProperties(response) {
  var xml = libxml.parseXml(response.payload);
  var result = {};

  var properties = xml.get('/StorageServiceProperties');
  if (properties.get('Logging')){
    var logging = properties.get('Logging');
    result.logging = {};
    result.logging.version = logging.get('Version').text();
    result.logging.delete = logging.get('Delete').text();
    result.logging.read = logging.get('Read').text();
    result.logging.write = logging.get('Write').text();
    result.logging.retentionPolicy = {};
    result.logging.retentionPolicy.enabled = logging.get('RetentionPolicy/Enabled').text();
    if(logging.get('RetentionPolicy/Days')) result.logging.retentionPolicy.days = logging.get('RetentionPolicy/Days').text();
  }
  if (properties.get('HourMetrics')){
    var hourMetrics = properties.get('HourMetrics');
    result.hourMetrics = {};
    result.hourMetrics.version = hourMetrics.get('Version').text();
    result.hourMetrics.enabled = hourMetrics.get('Enabled').text();
    if (hourMetrics.get('IncludeAPIs')) result.hourMetrics.includeAPIs = hourMetrics.get('IncludeAPIs').text();
    result.hourMetrics.retentionPolicy = {};
    result.hourMetrics.retentionPolicy.enabled = hourMetrics.get('RetentionPolicy/Enabled').text();
    if(hourMetrics.get('RetentionPolicy/Days')) result.hourMetrics.retentionPolicy.days = hourMetrics.get('RetentionPolicy/Days').text();
  }
  if (properties.get('MinuteMetrics')){
    var minuteMetrics = properties.get('MinuteMetrics');
    result.minuteMetrics = {};
    result.minuteMetrics.version = minuteMetrics.get('Version').text();
    result.minuteMetrics.enabled = minuteMetrics.get('Enabled').text();
    if (minuteMetrics.get('IncludeAPIs')) result.minuteMetrics.includeAPIs = minuteMetrics.get('IncludeAPIs').text();
    result.minuteMetrics.retentionPolicy = {};
    result.minuteMetrics.retentionPolicy.enabled = minuteMetrics.get('RetentionPolicy/Enabled').text();
    if(minuteMetrics.get('RetentionPolicy/Days')) result.minuteMetrics.retentionPolicy.days = minuteMetrics.get('RetentionPolicy/Days').text();
  }
  if (properties.get('Cors')){
    result.corsRules = [];
    var rules  = properties.get('Cors').childNodes();
    result.corsRules = rules.map(function(rule) {
      return {
        allowedOrigins: rule.get('AllowedOrigins').text(),
        allowedMethods: rule.get('AllowedMethods').text(),
        maxAgeInSeconds: rule.get('MaxAgeInSeconds').text(),
        exposedHeaders: rule.get('ExposedHeaders').text(),
        allowedHeaders: rule.get('AllowedHeaders').text()
      };
    });
  }
  return result;
}