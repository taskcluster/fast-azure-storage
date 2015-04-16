'use strict';

// Lazy load all sub-modules, so don't load anything we don't strictly need.
var _ = require('lodash');
_.forIn({
  Queue:        './queue',
  Table:        './table',
  Agent:        './agent'
}, function(path, name) {
  var module = undefined;
  Object.defineProperty(exports, name, {
    enumerable: true,
    get:        function() {
      if (!module) {
        module = require(path);
      }
      return module;
    }
  });
});
