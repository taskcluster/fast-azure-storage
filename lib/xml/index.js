var libxml = require('libxmljs');


/** Parse queue error and return a error object */
exports.queueParseError = function queueParseError(res) {
  // Parse payload for error message and code
  var message, code, detail;
  try {
    var xml = libxml.parseXml(res.payload);

    // Find error message
    message = xml.get('/Error/Message');
    if (message) {
      message = message.text();
    }

    // Find error code
    code = xml.get('/Error/Code');
    if (code) {
      code = code.text();
    }

    detail = xml.get('/Error/AuthenticationErrorDetail');
    if (detail) {
      detail = detail.text();
    }
  } catch (e) {
    // Ignore parsing errors
  }

  // Find default message and code
  if (!message) {
    message = "No error message given, in payload '" + res.payload + "'";
  }
  if (!code) {
    if (500 <= res.statusCode && res.statusCode < 600) {
      code = 'InternalErrorWithoutCode';
    } else {
      code = 'ErrorWithoutCode';
    }
  }

  // Construct error object
  var err         = new Error(message);
  err.name        = code + 'Error';
  err.code        = code;
  err.statusCode  = res.statusCode;
  err.detail      = detail;
  err.payload     = res.payload;

  // Return error object
  return err;
};


/** Parse list of queues and return object for listQueues */
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

/** Parse list of peeked messages */
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

/** Parse list of messages */
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