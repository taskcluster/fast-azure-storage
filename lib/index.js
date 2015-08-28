'use strict';

/* Export module from `path` under `property` */
var lazyExportModule = function(property, path) {
  var module = undefined;
  Object.defineProperty(exports, property, {
    enumerable: true,
    get: function() {
      if (module === undefined) {
        module = require(path);
      }
      return module;
    }
  });
};

// Lazy load all sub-modules, so don't load anything we don't strictly need.
lazyExportModule('Queue', './queue');
lazyExportModule('Table', './table');
lazyExportModule('Agent', './agent');
