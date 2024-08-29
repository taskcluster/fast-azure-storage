import https from "https";
import debugModule from "debug";
import util from "util";

const debug = debugModule("azure:agent");

/*
 * Idle socket timeout, set to 55 seconds because the Azure load balancer will
 * silently drop connections after 60 s of idle time. And we won't detect the
 * drop until we try to send keep-alive packages, so to avoid making requests
 * on invalid connections we close connections after 55 s of idle time.
 */
var FREE_SOCKET_IDLE_TIMEOUT = 55 * 1000;

/*
 * Error handler that ignores errors which occurs while the socket is owned by
 * Agent. We don't want these errors to crash our application.
 */
function freeSocketErrorHandler(err) {
  debug("Error from idle socket owned by azure.Agent: %s", err.stack);
}

/*
 * Socket timeout handler for azure.Azure sockets, which destroys sockets that
 * haven't been destroyed. Used to close sockets after being idle for 55 s.
 */
function freeSocketTimeoutHandler() {
  if (!this.destroyed) {
    debug("Destroying free socket after idle timeout");
    this.destroy();
  }
}

/**
 * A https.Agent subclass for use with a Azure Storage Services. This agent
 * is a specialization of the https.Agent class with extra features:
 *  - catches socket errors from free sockets,
 *  - closes sockets after being idle for 55 seconds, and
 *  - disables TCP Nagle for all sockets (socket.setNoDelay).
 *
 * For details on Azure issues with ECONNRESET see:
 * [blog.gluwer.com](http://bit.ly/1HBuJK1).
 *
 * @class Agent
 * @extends https.Agent
 * @constructor
 * @param {object} options - `options` compatible with `http.Agent`.
 */
var Agent = function (options) {
  https.Agent.call(this, options);

  // Listen for free sockets
  this.on('free', function (socket) {
    // Ignore errors from free sockets
    socket.on('error', freeSocketErrorHandler);
    // Set idle timeout to avoid connection drops from azure
    socket.setTimeout(FREE_SOCKET_IDLE_TIMEOUT, freeSocketTimeoutHandler);
  });
};

// Subclass https.Agent
util.inherits(Agent, https.Agent);

/**
 * Overwrites the `addRequest` method so we can remove error handler and timeout
 * handler from sockets when they are given to a request.
 *
 * @private
 * @method addRequest
 */
Agent.prototype.addRequest = function addRequest(req, options) {
  req.once('socket', function(socket) {
    // Disable TCP Nagle for socket about to be used by the request
    socket.setNoDelay(true);
    socket.removeListener('error', freeSocketErrorHandler);
    socket.setTimeout(0, freeSocketTimeoutHandler);
  });
  return https.Agent.prototype.addRequest.call(this, req, options);
};

/**
 * Overwrites the `removeSocket` method so we can remove error handler and
 * timeout handler from sockets when they are removed the agent.
 *
 * @private
 * @method removeSocket
 */
Agent.prototype.removeSocket = function removeSocket(socket, options) {
  socket.removeListener('error', freeSocketErrorHandler);
  socket.setTimeout(0, freeSocketTimeoutHandler);
  return https.Agent.prototype.removeSocket.call(this, socket, options);
};

// Some relatively sane defaults, 100 is a bit high depending on hardware
Agent.globalAgent = new Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 100,
});

export default Agent;
export { Agent };