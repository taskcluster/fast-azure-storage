var XML = require('pixl-xml');

/* Parse queue error, return: {message, code, detail} */
exports.queueParseError = function queueParseError(res) {
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
