suite("Queue", function() {
  var assert  = require('assert');
  var Promise = require('promise');
  var azure   = require('../');

  // Create azure queue client
  var queue = new azure.Queue({
    accountId:  process.env.AZURE_STORAGE_ACCOUNT,
    accessKey:  process.env.AZURE_STORAGE_ACCESS_KEY
  });

  // Queue to play with
  var queueName     = 'fast-azure-test-queue';
  var tempQueueName = 'fast-azure-test-tmp-queue';

  test("createQueue", function() {
    return queue.createQueue(queueName);
  });

  test("createQueue/deleteQueue", function() {
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
    return queue.listQueues({metadata: true}).then(function(result) {
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

  test("putMessage", function() {
    return queue.putMessage(queueName, 'my-message');
  });

  test("putMessage w. TTL and visibilityTimeout", function() {
    return queue.putMessage(queueName, 'my-message2', {
      visibilityTimeout:    60,
      TTL:                  120
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
      return azure.utils.sleep(200);
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
      return azure.utils.sleep(200);
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
      return azure.utils.sleep(100).then(function() {
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
      return azure.utils.sleep(200);
    }).then(function() {
      return Promise.all([
        queue2.putMessage(queueName, 'my-message-1'),
        queue2.putMessage(queueName, 'my-message-2')
      ]);
    }).then(function() {
      assert(refreshCount === 2);
    });
  });
});