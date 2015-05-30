/**
 * TCP transport compatible with PyBitmessage. Available only for Node
 * platform.  
 * **NOTE**: `TcpTransport` is exported as a module.
 * @module bitmessage-transports/tcp
 */

"use strict";

var objectAssign = Object.assign || require("object-assign");
var PPromise = typeof Promise === "undefined" ?
               require("es6-promise").Promise :
               Promise;
var inherits = require("inherits");
var net = require("chrome-net");
// dns is disabled
var bitmessage = require("bitmessage");
var assert = require("./util").assert;
var BaseTransport = require("./base");

var structs = bitmessage.structs;
var messages = bitmessage.messages;
var getmsg = BaseTransport._getmsg;
var unmap = BaseTransport._unmap;

/**
 * TCP transport class. Implements [base transport interface]{@link
 * module:bitmessage-transports/base.BaseTransport}.
 * @param {Object=} opts - Transport options
 * @param {Array} opts.seeds - Bootstrap nodes (none by default)
 * @param {Array} opts.dnsSeeds - Bootstrap DNS nodes (none by default)
 * @param {Object} opts.services - Service features provided by this
 * node (`NODE_NETWORK` by default)
 * @param {(Array|string|Buffer)} opts.userAgent - User agent of this
 * node (user agent of bitmessage library by default)
 * @param {number[]} opts.streams - Streams accepted by this node ([1]
 * by default)
 * @param {number} opts.port - Incoming port of this node (8444 by
 * default)
 * @constructor
 * @static
 */
function TcpTransport(opts) {
  TcpTransport.super_.call(this);
  objectAssign(this, opts);
  this.seeds = this.seeds || [];
  this.dnsSeeds = this.dnsSeeds || [];
  this.streams = this.streams || [1];
  this._clients = {};
}

inherits(TcpTransport, BaseTransport);

TcpTransport.prototype.toString = function() {
  if (this._client && this._client.remoteAddress) {
    return (
      "tcp:" +
      unmap(this._client.remoteAddress) + ":" +
      this._client.remotePort
    );
  } else {
    return "tcp:not-connected";
  }
};

TcpTransport.prototype._sendVersion = function() {
  return this.send(messages.version.encode({
    services: this.services,
    userAgent: this.userAgent,
    streams: this.streams,
    port: this.port,
    remoteHost: this._client.remoteAddress,
    remotePort: this._client.remotePort,
  }));
};

TcpTransport.prototype._setupClient = function(client, incoming) {
  var self = this;
  self._client = client;
  var cache = Buffer(0);
  var decoded;
  var verackSent = false;
  var verackReceived = false;
  var established = false;

  // Set default transport timeout per spec.
  // TODO(Kagami): We may also want to close connection if it wasn't
  // established within minute.
  client.setTimeout(20000);

  client.on("connect", function() {
    // NOTE(Kagami): This handler shouldn't be called at all for
    // incoming connections but let's be sure.
    if (!incoming) {
      self.emit("open");
      self._sendVersion();
    }
  });

  client.on("data", function(data) {
    // TODO(Kagami): We may want to preallocate 1.6M buffer for each
    // client instead (max size of the message) to not constantly
    // allocate new buffers. Though this may lead to another issues: too
    // many memory per client.
    cache = Buffer.concat([cache, data]);
    while (true) {
      decoded = structs.message.tryDecode(cache);
      if (!decoded) {
        break;
      }
      cache = decoded.rest;
      if (decoded.message) {
        self.emit("message", decoded.message.command, decoded.message.payload);
      } else if (decoded.error) {
        // TODO(Kagami): Wrap it in custom error class?
        // TODO(Kagami): Send `error` message and ban node for some time
        // if there were too many errors?
        self.emit("warning", new Error(
          "Message decoding error: " + decoded.error.message
        ));
      }
    }
  });

  // High-level message processing.
  self.on("message", function(command, payload) {
    var version;
    if (!established) {
      if (command === "version") {
        if (verackSent) {
          return;
        }
        try {
          version = self._decodeVersion(payload, {network: true});
        } catch(err) {
          self.emit("error", err);
          return client.end();
        }
        self.send("verack");
        verackSent = true;
        if (incoming) {
          self._sendVersion();
        } else if (verackReceived) {
          self.emit("established", version);
        }
      } else if (command === "verack") {
        verackReceived = true;
        if (verackSent) {
          self.emit("established", version);
        }
      }
    }
  });

  self.on("established", function() {
    established = true;
    // Raise timeout up to 10 minutes per spec.
    // TODO(Kagami): Send pong messages every 5 minutes as PyBitmessage.
    client.setTimeout(600000);
  });

  client.on("timeout", function() {
    client.end();
  });

  client.on("error", function(err) {
    self.emit("error", err);
  });

  client.on("close", function() {
    self.emit("close");
    delete self._client;
  });
};

function resolveDnsSeed(seed) {
  var host = seed[0];
  var port = seed[1];
  var nodes = [];
  // NOTE(Kagami):
  // 1) Node's `getaddrinfo` (`dns.lookup`) returns only one address so
  // we can't use it.
  // 2) Node's `dig host any` (`dns.resolve`) doesn't return type of the
  // record! So we resolve twice for A and AAAA.
  // 3) We ignore any errors here, promise's result is always a list.
  return new PPromise(function(resolve) {
    nodes.push([host, port])
    resolve(nodes);
  });
}

TcpTransport.prototype.bootstrap = function() {
  var hardcodedNodes = this.seeds;
  // FIXME(Kagami): Filter incorrect/private IP range nodes?
  // See also: <https://github.com/Bitmessage/PyBitmessage/issues/768>.
  return this.bootstrapDns().then(function(dnsNodes) {
    // Add hardcoded nodes to the end of list because DNS nodes should
    // be more up-to-date.
    return dnsNodes.concat(hardcodedNodes);
  });
};

/**
 * Do only DNS-specific bootstrap.
 * @return {Promise.<Array>} Discovered seed nodes.
 */
TcpTransport.prototype.bootstrapDns = function() {
  var promises = this.dnsSeeds.map(resolveDnsSeed);
  return PPromise.all(promises).then(function(dnsNodes) {
    // Flatten array of arrays.
    return Array.prototype.concat.apply([], dnsNodes);
  });
};

/**
 * Connect to a TCP node. Connection arguments are the same as for
 * [net.connect](http://nodejs.org/api/net.html#net_net_connect_port_host_connectlistener).
 */
TcpTransport.prototype.connect = function() {
  assert(!this._client, "Already connected");
  assert(!this._server, "Already listening");
  this._setupClient(net.connect.apply(null, arguments));
};

/**
 * Listen for incoming TCP connections. Listen arguments are the same as
 * for
 * [server.listen](http://nodejs.org/api/net.html#net_server_listen_port_host_backlog_callback).
 */
TcpTransport.prototype.listen = function() {
  assert(!this._client, "Already connected");
  assert(!this._server, "Already listening");

  var self = this;
  var server = self._server = net.createServer();
  server.listen.apply(server, arguments);

  var clientIdCounter = 0;

  server.on("connection", function(client) {
    var id = client.id = clientIdCounter++;
    self._clients[id] = client;
    client.on("close", function() {
      delete self._clients[id];
    });
    var opts = objectAssign({}, self);
    delete opts._server;
    var transport = new self.constructor(opts);
    var incoming = true;
    transport._setupClient(client, incoming);
    var addr = client.remoteAddress;
    var port = client.remotePort;
    self.emit("connection", transport, unmap(addr), port);
  });

  server.on("error", function(err) {
    self.emit("error", err);
  });

  server.on("close", function() {
    self.emit("close");
    delete self._server;
  });
};

TcpTransport.prototype.send = function() {
  if (this._client) {
    this._client.write(getmsg(arguments));
  } else {
    throw new Error("Not connected");
  }
};

TcpTransport.prototype.broadcast = function() {
  var data = getmsg(arguments);
  if (this._server) {
    Object.keys(this._clients).forEach(function(id) {
      this._clients[id].write(data);
    }, this);
  } else {
    throw new Error("Not listening");
  }
};

TcpTransport.prototype.close = function() {
  if (this._client) {
    this._client.end();
  } else if (this._server) {
    Object.keys(this._clients).forEach(function(id) {
      this._clients[id].end();
    }, this);
    this._server.close();
  }
};

module.exports = TcpTransport;
