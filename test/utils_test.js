suite("Utils", function() {
  var assert  = require('assert');
  var Promise = require('promise');
  var utils   = require('../lib/utils');

  test("sleep", function() {
    var start = Date.now();
    return utils.sleep(500).then(function() {
      var duration = Date.now() - start;
      assert(duration > 300, "Expected duration of 500ms w. 200ms margin");
      assert(duration < 700, "Expected duration of 500ms w. 200ms margin");
    });
  });

  test("retry (will retry transient errors)", function() {
    var count = 0;
    return utils.retry(function(retry) {
      assert(retry === count, "Expected retry == count");
      count += 1;
      var err = new Error("Some error message");
      err.code = 'MyTransientError';
      throw err;
    }, {
      retries:              3,
      delayFactor:          20,
      maxDelay:             30 * 1000,
      transientErrorCodes:  ['MyTransientError']
    }).then(function() {
      assert(false, "Expected an error!");
    }, function(err) {
      assert(err.code === 'MyTransientError', "Expected transient error");
      assert(count === 4, "Expected that we tried 4 times 1 + 3 retries");
    });
  });

  test("retry (non-transient error)", function() {
    var count = 0;
    return utils.retry(function(retry) {
      assert(retry === count, "Expected retry == count");
      count += 1;
      var err = new Error("Some error message");
      err.code = 'MyNonTransientError';
      throw err;
    }, {
      retries:              3,
      delayFactor:          20,
      maxDelay:             30 * 1000,
      transientErrorCodes:  ['MyTransientError']
    }).then(function() {
      assert(false, "Expected an error!");
    }, function(err) {
      assert(err.code === 'MyNonTransientError',
             "Expected non-transient error");
      assert(count === 1, "Shouldn't have been retried!");
    });
  });

  test("retry (Can recovered w. retries)", function() {
    var count = 0;
    return utils.retry(function(retry) {
      assert(retry === count, "Expected retry == count");
      count += 1;
      if (count < 4) {
        var err = new Error("Some error message");
        err.code = 'MyTransientError';
        throw err;
      }
    }, {
      retries:              3,
      delayFactor:          20,
      maxDelay:             30 * 1000,
      transientErrorCodes:  ['MyTransientError']
    }).then(function() {
      assert(count === 4, "Expected that only the last time worked");
    });
  });

  test("retry (Can recover w. retries - async function)", function() {
    var count = 0;
    return utils.retry(function(retry) {
      return utils.sleep(10).then(function() {
        assert(retry === count, "Expected retry == count");
        count += 1;
        if (count < 4) {
          var err = new Error("Some error message");
          err.code = 'MyTransientError';
          throw err;
        }
      });
    }, {
      retries:              3,
      delayFactor:          20,
      maxDelay:             30 * 1000,
      transientErrorCodes:  ['MyTransientError']
    }).then(function() {
      assert(count === 4, "Expected that only the last time worked");
    });
  });

  test("dateToISOWithoutMS", function() {
    var date = new Date('2015-07-23T20:53:51.161Z');
    assert(utils.dateToISOWithoutMS(date) === '2015-07-23T20:53:51Z',
           "Expected '2015-07-23T20:53:51Z' but got something else");
  });
});