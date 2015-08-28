'use strict';

var https   = require('https');
var debug   = require('debug')('azure:agent');
var util    = require('util');
var Agent   = require('agentkeepalive').HttpsAgent;

/*
 * Idle socket timeout, set to 55 seconds because the Azure load balancer will
 * silently drop connections after 60 s of idle time. And we won't detect the
 * drop until we try to send keep-alive packages, so to avoid making requests
 * on invalid connections we close connections after 55 s of idle time.
 */
var FREE_SOCKET_IDLE_TIMEOUT = 55 * 1000;

// Create global agent
Agent.globalAgent = new Agent({
  keepAlive:        true,
  keepAliveTimeout: FREE_SOCKET_IDLE_TIMEOUT,
  maxSockets:       100,
  maxFreeSockets:   100
});

// Export Agent
module.exports = Agent;