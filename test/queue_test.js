suite("Queue", function() {
  var assert  = require('assert');
  var Promise = require('promise');
  var azure   = require('../');
  var utils   = require('../lib/utils');

  // Hack overwriting methods on xml-parser to call both libxmljs and xmljs
  // based parsers so we can compare their result and assert it is the same.
  var libxmljsParser = require('../lib/xml-parser/libxmljs-parser');
  var pixlXmlParser = require('../lib/xml-parser/pixl-xml-parser');
  var xml = require('../lib/xml-parser');
  Object.keys(xml).forEach(function(method) {
    // Store methods here as we are overwriting one of these objects!
    var m1 = libxmljsParser[method];
    var m2 = pixlXmlParser[method];
    xml[method] = function(res) {
      assert.deepEqual(
        m1(res),
        m2(res),
        "Expected libxmljs and pixl-xml based parsers to return the same!"
      );
      return m1(res);
    };
  });

  // Create azure queue client
  var queue = new azure.Queue({
    accountId:  process.env.AZURE_STORAGE_ACCOUNT,
    accessKey:  process.env.AZURE_STORAGE_ACCESS_KEY
  });

  // Queue to play with
  var queueName     = 'fast-azure-test-queue';
  var tempQueueName = 'fast-azure-test-tmp-queue';

  test("createQueue w. meta-data", function() {
    return queue.createQueue(queueName, {
      purpose:         'testing',
      applicationName: 'fast-azure-storage'
    });
  });

  test("createQueue without metadata, deleteQueue", function() {
    return queue.createQueue(tempQueueName).then(function() {
      return queue.deleteQueue(tempQueueName);
    }).catch(function(err) {
      // Ignore QueueBeingDeleted errors
      if (err.code !== 'QueueBeingDeleted') {
        throw err;
      }
    });
  });

  test("listQueues w. meta-data", function() {
    return queue.listQueues({
      metadata: true
    }).then(function(result) {
      assert(result.queues.length > 0);
    });
  });

  test("listQueues w. prefix", function() {
    return queue.listQueues({
      prefix:   queueName.substr(0, queueName.length - 5)
    }).then(function(result) {
      assert(result.queues.length > 0);
    });
  });

  test("listQueues w. prefix, meta-data", function() {
    return queue.listQueues({
      prefix:   queueName.substr(0, queueName.length - 5),
      metadata: true
    }).then(function(result) {
      assert(result.queues.length > 0);
      var myQueue = null;
      result.queues.forEach(function(queue) {
        if (queue.name === queueName) {
          myQueue = queue;
        }
      });
      assert(myQueue, "Expected to find the test queue");
      assert(myQueue.metadata.purpose === 'testing');
    });
  });

  test("getMetadata", function() {
    return queue.getMetadata(queueName).then(function(result) {
      assert(result.metadata.purpose === 'testing');
      assert(result.metadata.applicationName === 'fast-azure-storage');
    });
  });

  test("getMetadata (from non-existent queue)", function() {
    return queue.getMetadata(queueName + '-missing').then(function() {
      assert(false, "Expected an error here");
    }, function(err) {
      // Because this is a HEAD request, we don't get anything but status code
      assert(err.statusCode === 404, "Expected 404");
    });
  });

  test("setMetadata", function() {
    // Don't actually want to change the meta-data as it would affect the
    // createQueue test case...
    return queue.setMetadata(queueName, {
      purpose:  'testing'
    });
  });

  test("putMessage", function() {
    return queue.putMessage(queueName, 'my-message');
  });

  test("putMessage w. TTL and visibilityTimeout", function() {
    return queue.putMessage(queueName, 'my-message2', {
      visibilityTimeout:    60,
      TTL:                  120
    });
  });

  test("getMetadata (messageCount > 0)", function() {
    return queue.getMetadata(queueName).then(function(result) {
      assert(typeof(result.messageCount) === 'number');
      assert(result.messageCount > 0);
    });
  });

  test("clearMessages", function() {
    return queue.clearMessages(queueName);
  });

  test("clear, put, get, peek", function() {
    return queue.clearMessages(queueName).then(function() {
      return queue.putMessage(queueName, 'my-message3', {
        visibilityTimeout:    0,
        messageTTL:           120
      });
    }).then(function() {
      return queue.peekMessages(queueName);
    }).then(function(messages) {
      assert(messages.length > 0);
      var msg = messages.pop();
      assert(msg.messageText === 'my-message3');
      var ttl = msg.expirationTime.getTime() - msg.insertionTime.getTime();
      ttl = ttl / 1000;
      assert(60 < ttl && ttl < 180, "Expected 120 s TTL");
    });
  });

  test("clear, put, get, delete messages", function() {
    return queue.clearMessages(queueName).then(function() {
      return queue.putMessage(queueName, 'my-message4', {
        visibilityTimeout:    0,
        messageTTL:           120
      });
    }).then(function() {
      return queue.getMessages(queueName, {
        visibilityTimeout:    120
      });
    }).then(function(messages) {
      assert(messages.length > 0);
      var msg = messages.pop();
      assert(msg.messageText === 'my-message4');
      var ttl = msg.expirationTime.getTime() - msg.insertionTime.getTime();
      var vst = msg.timeNextVisible.getTime() - new Date().getTime();
      ttl = ttl / 1000;
      vst = vst / 1000;
      assert(60 < ttl && ttl < 180, "Expected 120 s TTL");
      assert(60 < vst && vst < 180, "Expected 120 s visibility timeout");
      return queue.deleteMessage(
        queueName,
        msg.messageId,
        msg.popReceipt
      );
    });
  });


  test("clear, put, get, update, get messages", function() {
    return queue.clearMessages(queueName).then(function() {
      return queue.putMessage(queueName, 'my-message5', {
        visibilityTimeout:    0,
        messageTTL:           120
      });
    }).then(function() {
      return queue.getMessages(queueName, {
        visibilityTimeout:    120
      });
    }).then(function(messages) {
      assert(messages.length > 0);
      var msg = messages.pop();
      assert(msg.messageText === 'my-message5');
      var ttl = msg.expirationTime.getTime() - msg.insertionTime.getTime();
      var vst = msg.timeNextVisible.getTime() - new Date().getTime();
      ttl = ttl / 1000;
      vst = vst / 1000;
      assert(60 < ttl && ttl < 180, "Expected 120 s TTL");
      assert(60 < vst && vst < 180, "Expected 120 s visibility timeout");
      return queue.updateMessage(
        queueName, 'my-message6',
        msg.messageId, msg.popReceipt, {
        visibilityTimeout: 0
      });
    }).then(function() {
      return queue.getMessages(queueName, {
        visibilityTimeout:    120
      });
    }).then(function(messages) {
      assert(messages.length > 0);
      var msg = messages.pop();
      assert(msg.messageText === 'my-message6');
    });
  });

  test("clear, put, get, update, delete messages", function() {
    var savedMessage;
    return queue.clearMessages(queueName).then(function() {
      return queue.putMessage(queueName, 'my-message7');
    }).then(function() {
      return queue.getMessages(queueName, {
        visibilityTimeout:    120
      });
    }).then(function(messages) {
      assert(messages.length > 0);
      var msg = savedMessage = messages.pop();
      assert(msg.messageText === 'my-message7');
      return queue.updateMessage(
        queueName, 'my-message8',
        msg.messageId, msg.popReceipt, {
        visibilityTimeout: 120
      });
    }).then(function(updateResult) {
      return queue.deleteMessage(
        queueName,
        savedMessage.messageId,
        updateResult.popReceipt
      );
    });
  });

  test("Shared-Access-Signature (fixed string, w. start)", function() {
    var sas = queue.sas(queueName, {
      start:    new Date(Date.now() - 15 * 60 * 1000),
      expiry:   new Date(Date.now() + 30 * 60 * 1000),
      permissions: {
        read:     true,
        add:      true,
        update:   true,
        process:  true
      }
    });
    var queue2 = new azure.Queue({
      accountId:    queue.options.accountId,
      sas:          sas
    });
    return queue2.putMessage(queueName, 'my-message');
  });

  test("Shared-Access-Signature (forbid add)", function() {
    var sas = queue.sas(queueName, {
      start:    new Date(Date.now() - 15 * 60 * 1000),
      expiry:   new Date(Date.now() + 30 * 60 * 1000),
      permissions: {
        read:     true,
        add:      false,
        update:   true,
        process:  true
      }
    });
    var queue2 = new azure.Queue({
      accountId:    queue.options.accountId,
      sas:          sas
    });
    return queue2.putMessage(queueName, 'my-message').catch(function(err) {
      // Apparently it's not a 403, don't know why they return ResourceNotFound
      assert(400 <= err.statusCode && err.statusCode < 500);
    });
  });

  test("Shared-Access-Signature (will refresh)", function() {
    var refreshCount = 0;
    var refreshSAS = function() {
      refreshCount += 1;
      return queue.sas(queueName, {
        expiry:   new Date(Date.now() + 15 * 60 * 1000 + 100),
        permissions: {
          read:     true,
          add:      true,
          update:   true,
          process:  true
        }
      });
    };
    var queue2 = new azure.Queue({
      accountId:        queue.options.accountId,
      sas:              refreshSAS,
      minSASAuthExpiry: 15 * 60 * 1000
    });
    return queue2.putMessage(queueName, 'my-message').then(function() {
      assert(refreshCount === 1);
      return utils.sleep(200);
    }).then(function() {
      return queue2.putMessage(queueName, 'my-message')
    }).then(function() {
      assert(refreshCount === 2);
    });
  });

  test("Shared-Access-Signature (won't refresh on every call)", function() {
    var refreshCount = 0;
    var refreshSAS = function() {
      refreshCount += 1;
      return queue.sas(queueName, {
        expiry:   new Date(Date.now() + 20 * 60 * 1000),
        permissions: {
          read:     true,
          add:      true,
          update:   true,
          process:  true
        }
      });
    };
    var queue2 = new azure.Queue({
      accountId:        queue.options.accountId,
      sas:              refreshSAS,
      minSASAuthExpiry: 15 * 60 * 1000
    });
    return queue2.putMessage(queueName, 'my-message').then(function() {
      assert(refreshCount === 1);
      return utils.sleep(200);
    }).then(function() {
      return queue2.putMessage(queueName, 'my-message')
    }).then(function() {
      assert(refreshCount === 1);
    });
  });

  test("Shared-Access-Signature (will refresh)", function() {
    var refreshCount = 0;
    var refreshSAS = function() {
      refreshCount += 1;
      return utils.sleep(100).then(function() {
        return queue.sas(queueName, {
          expiry:   new Date(Date.now() + 15 * 60 * 1000 + 100),
          permissions: {
            read:     true,
            add:      true,
            update:   true,
            process:  true
          }
        });
      });
    };
    var queue2 = new azure.Queue({
      accountId:        queue.options.accountId,
      sas:              refreshSAS,
      minSASAuthExpiry: 15 * 60 * 1000
    });
    return queue2.putMessage(queueName, 'my-message').then(function() {
      assert(refreshCount === 1);
      return utils.sleep(200);
    }).then(function() {
      return Promise.all([
        queue2.putMessage(queueName, 'my-message-1'),
        queue2.putMessage(queueName, 'my-message-2')
      ]);
    }).then(function() {
      assert(refreshCount === 2);
    });
  });

  test("Retries up to 5 times", function() {
    var request = utils.request;
    var requestCount = 0;
    utils.request = function() {
      requestCount += 1;
      return utils.sleep(100).then(function() {
        var err = new Error('ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      });
    };
    return queue.clearMessages(queueName).then(function() {
      utils.request = request;
      assert(false, "Expected an error");
    }, function(err) {
      utils.request = request;
      assert(err.code === 'ECONNRESET');
      assert(requestCount === 6, "Expected 1 request + 5 retries");
    });
  });
});
