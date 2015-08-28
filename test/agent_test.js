suite("Agent", function() {
  var assert  = require('assert');
  var Promise = require('promise');
  var azure   = require('../');
  var utils   = require('../lib/utils');

  // Create azure table client
  var table = new azure.Table({
    accountId:  process.env.AZURE_STORAGE_ACCOUNT,
    accessKey:  process.env.AZURE_STORAGE_ACCESS_KEY
  });

  var request, onSocket;
  before(function() {
    request = utils.request;
    onSocket = null;
    utils.request = function(options, data, timeout) {
      return request(options, data, timeout).then(function(res) {
        if (onSocket) {
          onSocket(res.socket);
        }
        return res;
      });
    };
  });
  after(function() {
    utils.request = request;
  });

  test("Catches errors when idle", function() {
    var socket = null;
    onSocket = function(socket_) {
      assert(socket_ !== socket, "Expected a fresh socket");
      socket = socket_;
    };
    return table.queryTables().then(function() {
      setTimeout(function() {
        // Simulate a broken TCP connection
        var err = new Error('ECONNRESET');
        err.code = 'ECONNRESET';
        socket.destroyed = true;
        socket.emit('error', err);
        socket.emit('close', true);
      }, 100);
    }).then(function() {
      return utils.sleep(500);
    }).then(function() {
      return table.queryTables();
    });
  });
});


