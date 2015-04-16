suite("Queue", function() {
  var azure   = require('../');
  var assert  = require('assert');

  // Create azure queue client
  var queue = new azure.Queue({
    credentials: {
      accountId:  process.env.AZURE_STORAGE_ACCOUNT,
      accessKey:  process.env.AZURE_STORAGE_ACCESS_KEY
    }
  });

  test("createQueue", function() {
    return queue.createQueue('fast-azure-test-queue');
  });

  test("createQueue/deleteQueue", function() {
    return queue.createQueue('fast-azure-test-tmp-queue').then(function() {
      return queue.deleteQueue('fast-azure-test-tmp-queue');
    }).catch(function(err) {
      // Ignore QueueBeingDeleted errors
      if (err.code !== 'QueueBeingDeleted') {
        throw err;
      }
    });
  });

  test("listQueues w. meta-data", function() {
    return queue.listQueues({metadata: true}).then(function(result) {
      assert(result.queues.length > 0);
    });
  });

  test("listQueues w. prefix", function() {
    return queue.listQueues({
      prefix:   'fast-azure-test-'
    }).then(function(result) {
      assert(result.queues.length > 0);
    });
  });

  test("putMessage", function() {
    return queue.putMessage('fast-azure-test-queue', 'my-message');
  });

  test("putMessage w. TTL and visibilityTimeout", function() {
    return queue.putMessage('fast-azure-test-queue', 'my-message2', {
      visibilityTimeout:    60,
      TTL:                  120
    });
  });

  test("clearMessages", function() {
    return queue.clearMessages('fast-azure-test-queue');
  });

  test("clear, put, get, peek", function() {
    return queue.clearMessages('fast-azure-test-queue').then(function() {
      return queue.putMessage('fast-azure-test-queue', 'my-message3', {
        visibilityTimeout:    0,
        messageTTL:           120
      });
    }).then(function() {
      return queue.peekMessages('fast-azure-test-queue');
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
    return queue.clearMessages('fast-azure-test-queue').then(function() {
      return queue.putMessage('fast-azure-test-queue', 'my-message4', {
        visibilityTimeout:    0,
        messageTTL:           120
      });
    }).then(function() {
      return queue.getMessages('fast-azure-test-queue', {
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
        'fast-azure-test-queue',
        msg.messageId,
        msg.popReceipt
      );
    });
  });


  test("clear, put, get, update, get messages", function() {
    return queue.clearMessages('fast-azure-test-queue').then(function() {
      return queue.putMessage('fast-azure-test-queue', 'my-message5', {
        visibilityTimeout:    0,
        messageTTL:           120
      });
    }).then(function() {
      return queue.getMessages('fast-azure-test-queue', {
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
        'fast-azure-test-queue', 'my-message6',
        msg.messageId, msg.popReceipt, {
        visibilityTimeout: 0
      });
    }).then(function() {
      return queue.getMessages('fast-azure-test-queue', {
        visibilityTimeout:    120
      });
    }).then(function(messages) {
      assert(messages.length > 0);
      var msg = messages.pop();
      assert(msg.messageText === 'my-message6');
    });
  });
});