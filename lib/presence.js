
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs");
const ESCAPE_REGEXP = require("escape-regexp-component");
const WAITFOR = require("waitfor");
const DEEPMERGE = require("deepmerge");
const CONNECT = require("connect");
const ENGINE_IO = require("engine.io");
const EVENTS = require("events");


var PING_TIMEOUT = 3 * 1000;  // 3 seconds
var PING_INTERVAL = 15 * 1000;  // 15 seconds
// Switch from `away` to `disconnect` after this many milliseconds.
var RECONNECT_TIMEOUT = 35 * 1000;  // 30 seconds
var REPORT_INTERVAL = 60 * 15 * 1000;  // 15 minutes


exports.hook = function(app, config, options, callback) {
    var presence = new RolodexPresence(config, options);
    return presence.registerRoutes(app, function(err) {
    	if (err) return callback(err);
    	return callback(null, presence);
    });
}


function RolodexPresence(config, options) {
	var self = this;

	self.options = null;
	self.logger = null;

	self.config = null;
	self.routes = {};

	self.hookServer = null;

	self.sessions = {};
	self.contacts = {};

	if (options.dev) {
		PING_TIMEOUT = 2 * 1000;
		PING_INTERVAL = 8 * 1000;
		RECONNECT_TIMEOUT = 11 * 1000;
		REPORT_INTERVAL = 2.5 * 1000;
	}

	setInterval(function() {
        options.logger.info("[rolodex-presence] Session Count:", Object.keys(self.sessions).length, " Contacts count:", Object.keys(self.contacts).length);
	}, REPORT_INTERVAL);

	try {

		ASSERT.equal(typeof options, "object");

		self.options = options;

		ASSERT.equal(typeof options.rolodex, "object");
		ASSERT.equal(typeof options.hostname, "string");

		options.debug = options.debug || false;

		if (!options.logger) {
			options.logger = {
				debug: function() {
					if (!options.debug) return;
					return console.log.apply(null, arguments);
				},
				info: console.info.bind(null),
				warn: console.warn.bind(null),
				error: console.error.bind(null)
			}
		}
		self.logger = options.logger;

		if (typeof config === "string") {
			try {
				var path = config;
				config = JSON.parse(FS.readFileSync(path));
			} catch(err) {
				throw new Error("Error '" + err.message + "' while loading config JSON from file '" + path + "'");
			}
		}
		ASSERT.equal(typeof config, "object");
		config.routes = DEEPMERGE({
            client: "/.openpeer-rolodex-presence/client",
            server: "/.openpeer-rolodex-presence/server"
		}, config.routes || {});

		self.config = config;

		for (var routeName in config.routes) {
			var route = "^" + ESCAPE_REGEXP(config.routes[routeName]);
			if (routeName === "client" || routeName === "server") {
				route += "\\/(.*)";
			}
			self.routes[routeName] = new RegExp(route + "$");
		}
	} catch(err) {
		self.logger.error("config", config);
		throw err;
	}

	self.options.rolodex.on("service.updated", function(serviceId, servicesSession) {
		if (self.sessions[servicesSession.sessionID]) {
	        self.options.logger.debug("[rolodex-presence] Reacting to service update for", "serviceId", serviceId, "sid", servicesSession.sessionID);
			self.sessions[servicesSession.sessionID].syncFromServices(servicesSession.getServices(), true, function(err) {
				if (err) self.options.logger.error("[rolodex-presence] Got error while reacting to service update:", err.stack);
			});
		}
	});
}

RolodexPresence.prototype.registerRoutes = function(app, callback) {
	var self = this;
	var waitfor = WAITFOR.serial(callback);
	for (var routeName in self.routes) {
		if (routeName === "client") {
			mountStaticDir(app, self.routes[routeName], PATH.join(__dirname, "client"));
		} else
		if (routeName === "server") {
			waitfor(routeName, function(routeName, done) {
				return initEngine({
		            path: self.config.routes[routeName],
		            logger: self.options.logger,
		            debug: self.options.debug || false,
			        pingTimeout: PING_TIMEOUT,
			        pingInterval: PING_INTERVAL
				}, function(err, api) {
					if (err) return done(err);

					self.hookServer = api.hook;

	                api.on("connect", function(connection) {

				        self.options.logger.debug("[rolodex-presence] Got 'connect' event for sid", connection.sid, "id", connection.id);

	                	function callback(err) {
	                		if (err) {
						        options.logger.error("[rolodex-presence] Connect:", err.stack);
	                		}
	                	}

	                	try {

		                	return self.options.rolodex.getServicesSessionForSessionID(connection.sid, function(err, servicesSession) {
		                		if (err) return callback(err);

								var session = {
									connection: connection,
									peerContact: null,
									contacts: {},
									syncFromServices: null
								};

								function syncFromServices(services, update, callback) {

									var oldPeerContact = session.peerContact;

									session.peerContact = null;
		                			for (var serviceId in services) {
		                				if (services[serviceId].hCard && services[serviceId].hCard.peerContact) {
		                					session.peerContact = services[serviceId].hCard.peerContact;
			                			}
		                			}

		                			return servicesSession.getContacts(null, function(err, contacts) {
			                			if (err) return callback(err);

			                			if (!update) {
				                			// Logout previously existing connection for this session ID.
											if (session.peerContact) {
												delete self.contacts[session.peerContact];
											}
											if (self.sessions[connection.sid]) {
												self.sessions[connection.sid].connection.send({
													type: "logout"
												});
											}

						                	self.sessions[connection.sid] = session;
						                }

					                	if (session.peerContact) {
					                		session.contacts = {};
											for (var serviceId in contacts) {
												for (var contactId in contacts[serviceId]) {
													if (!contacts[serviceId][contactId].peerContact) {
														// Add contact by uid so when contact gets a peerContact
														// we can update it so that messaging will work
														// without having to reload all contacts.
														session.contacts[serviceId + ":" + contactId] = true;
														continue;
													}

													var peerContact = contacts[serviceId][contactId].peerContact;

													session.contacts[peerContact] = true;

													if (self.contacts[peerContact]) {

														if (services[serviceId].hCard && self.contacts[peerContact].contacts[services[serviceId].hCard.uid]) {
															delete self.contacts[peerContact].contacts[services[serviceId].hCard.uid];
															self.contacts[peerContact].contacts[session.peerContact] = true;

															self.sendMessageTo(peerContact, {
																type: "online",
																from: session.peerContact,
																peerContact: "added"
															});
														} else {
															self.sendMessageTo(peerContact, {
																type: "online",
																from: session.peerContact
															});
														}
														connection.send({
															type: "online",
															from: peerContact
														});
													}
												}
											}

											self.contacts[session.peerContact] = session;
										} else
										if (update) {
											for (var peerContact in session.contacts) {
												if (self.contacts[peerContact]) {
						                			for (var serviceId in services) {
														if (services[serviceId].hCard && self.contacts[peerContact].contacts[oldPeerContact]) {
															self.sendMessageTo(peerContact, {
																type: "offline",
																from: oldPeerContact,
																peerContact: "removed"
															});
															self.contacts[peerContact].contacts[services[serviceId].hCard.uid] = true;
														}
													}
													delete self.contacts[peerContact].contacts[oldPeerContact];
													connection.send({
														type: "offline",
														from: peerContact
													});
												}
											}
											delete self.contacts[oldPeerContact];
										}
										return callback(null);
									});
								}

								session.syncFromServices = syncFromServices;

								return syncFromServices(servicesSession.getServices(), false, function(err) {
									if (err) return callback(err);

									function ensureCurrentConnection() {
				                    	if (
				                    		self.sessions[connection.sid] &&
				                    		self.sessions[connection.sid] === session &&
				                    		self.sessions[connection.sid].connection === connection
				                    	) return true;
								        self.options.logger.debug("[rolodex-presence] Not current connection for sid", connection.sid, "id", connection.id, "current connection", "id", self.sessions[connection.sid].connection.id);
				                    	return false;
									}

				                    connection.once("disconnect", function(reason) {

								        self.options.logger.debug("[rolodex-presence] Got 'disconnect' event for sid", connection.sid, "id", connection.id);

								        if (!ensureCurrentConnection()) return;

										self.sendMessageTo(Object.keys(session.contacts), {
											type: "offline",
											from: session.peerContact
										});
				                    	delete self.sessions[connection.sid];
					                	delete self.contacts[session.peerContact];
				                    });

				                    connection.on("away", function() {

								        self.options.logger.debug("[rolodex-presence] Got 'away' event for sid", connection.sid, "id", connection.id);

								        if (!ensureCurrentConnection()) return;

										self.sendMessageTo(Object.keys(session.contacts), {
											type: "away",
											from: session.peerContact
										});
				                    });

				                    connection.on("back", function() {

								        self.options.logger.debug("[rolodex-presence] Got 'back' event for sid", connection.sid, "id", connection.id);

								        if (!ensureCurrentConnection()) return;

										self.sendMessageTo(Object.keys(session.contacts), {
											type: "back",
											from: session.peerContact
										});
				                    });

				                    connection.on("message", function(message) {

								        self.options.logger.debug("[rolodex-presence] Got 'message' event for sid", connection.sid, "id", connection.id);

								        if (!ensureCurrentConnection()) return;

				                    	if (message.type === "message") {
		                    				// Only send message if sender is following recipient.
				                    		if (session.contacts[message.to]) {
												self.sendMessageTo(message.to, {
													type: "message",
													from: session.peerContact,
													message: message.message
												});
											}
										}
				                    });
	                			});
		                	});
						} catch(err) {
							return callback(err);
						}
	                });

					return done(null);
				});
			});
		}
	}
	return waitfor();
}

RolodexPresence.prototype.sendMessageTo = function(peerContact, message) {
	var self = this;
	if (typeof peerContact === "string") peerContact = [ peerContact ];
	peerContact.forEach(function(peerContact) {
		if (!self.contacts[peerContact]) return;

		// Only send message if recipient is following sender.
		if (!self.contacts[peerContact].contacts[message.from]) return;

        self.options.logger.debug("[rolodex-presence] Send message", message, "from", message.from, "to", peerContact, "sid", self.contacts[peerContact].connection.sid, "id", self.contacts[peerContact].connection.id);

		self.contacts[peerContact].connection.send(message);
	});
}


function mountStaticDir(app, route, path) {
    return app.get(route, function(req, res, next) {
        var originalUrl = req.url;
        req.url = req.params[0];
        return CONNECT.static(path)(req, res, function() {
            req.url = originalUrl;
            return next.apply(null, arguments);
        });
    });
};


function initEngine(options, callback) {

    var gee = new EVENTS.EventEmitter();

    var serverId = "server-id-" + Date.now();
    var connections = {};
    var timeouts = {};
    var buffers = {};

    var originalSendPacket = ENGINE_IO.Socket.prototype.sendPacket;
    ENGINE_IO.Socket.prototype.sendPacket = function (type, data, callback) {
		if (type === "pong") {
			data = {
				serverId: serverId
			};
		}
    	return originalSendPacket.call(this, type, data, callback);
    }

    return callback(null, {
    	hook: function(httpServer) {

		    var server = new ENGINE_IO.attach(httpServer, {
		    	path: options.path,
		        pingTimeout: options.pingTimeout || 3000,
		        pingInterval: options.pingInterval || 15000
		//        transports: ["polling"]
			});

		    server.on("error", function(err) {
		        options.logger.error("[rolodex-presence][engine]", err.stack);
		    });

		    server.on("connection", function (socket) {

		    	// The ID sent to the client that the client should use to identify itself as long as the client lives.
		    	// The client will only set this ID once and use it for all `__ANNOUNCE-ID__` messages even if a server
		    	// sends a new `proposedId`.
		    	var proposedId = false;
		    	// The ID that the client identifies itself as based on the first received `proposedId`.
		        var id = false;

		        socket.on("message", function (message) {

			        options.logger.debug("[rolodex-presence][engine] Received message", message, "for id", id, "socket.id", socket.id);

		        	try {
		        		message = JSON.parse(message);
		        	} catch(err) {
				        options.logger.error("[rolodex-presence][engine] Invalid client message:", message, "socket.id", socket.id);
			        	return;
		        	}

		            if (typeof message === "object" && message.type === "__ANNOUNCE-ID__") {
		                id = message.id;
		                if (timeouts[id]) {
		                    clearTimeout(timeouts[id]);
		                    delete timeouts[id];
		                }
		                if (!connections[id]) {
					        options.logger.debug("[rolodex-presence][engine] Record new connection for", "id", id, "socket.id", socket.id);
		                    connections[id] = {
		                        ee: new EVENTS.EventEmitter(),
		                        socket: socket
		                    };
		                    var sid = message.sid;
		                    gee.emit("connect", {
		                        id: id,
		                        sid: sid,
		                        socket: socket,
		                        on: connections[id].ee.on.bind(connections[id].ee),
		                        once: connections[id].ee.once.bind(connections[id].ee),
		                        send: function(message) {
		                            if (timeouts[id]) {
		                                if (!buffers[id]) {
		                                    buffers[id] = [];
		                                }
								        options.logger.debug("[rolodex-presence][engine] Buffer message", JSON.stringify(message), "for sid", sid, "id", id, "socket.id", socket.id);
		                                buffers[id].push(JSON.stringify(message));
		                            } else if (connections[id]) {
								        options.logger.debug("[rolodex-presence][engine] Send message", JSON.stringify(message), "to sid", sid, "id", id, "socket.id", socket.id);
		                                connections[id].socket.send(JSON.stringify(message));
		                            }
		                        }
		                    });
		                } else {
					        options.logger.debug("[rolodex-presence][engine] Update existing connection for", "id", id, "socket.id", socket.id, "old socket.id", connections[id].socket.id);
		                    connections[id].socket = socket;
		                    if (buffers[id]) {
		                        buffers[id].forEach(function(message) {
							        options.logger.debug("[rolodex-presence][engine] Send buffered message", message, "id", id, "socket.id", socket.id);
		                            connections[id].socket.send(message);
		                        });
		                        delete buffers[id];
		                    }
		                    connections[id].ee.emit("back");
		                }
		            } else if (connections[id]) {
		                connections[id].ee.emit("message", message);
		            }
		        });

		        socket.on("close", function (reason) {

			        options.logger.debug("[rolodex-presence][engine] Connection close for id", id, "socket.id", socket.id);

		            if (id === false || !connections[id]) {
		                // Connection was never announced.
		                return;
		            }
		            if (connections[id].socket !== socket) {
						// Another socket has taken over this connection.
				        options.logger.debug("[rolodex-presence][engine] Skip reconnect timeout trigger as connection has been taken over by new socket", "id", id, "socket.id", socket.id, "new socket.id", connections[id].socket.id);
		                return;
		            }
		            timeouts[id] = setTimeout(function() {
				        options.logger.debug("[rolodex-presence][engine] Reconnect timeout triggered for id", id, "socket.id", socket.id);
		                // the connection might not exist on the server
		                if (connections[id]) {
		                    connections[id].ee.emit("disconnect", reason);
		                    delete connections[id];
		                }
		                id = false;
		            }, RECONNECT_TIMEOUT);
		            connections[id].ee.emit("away");
		        });

		        proposedId = socket.id + "-" + Date.now();

		        options.logger.debug("[rolodex-presence][engine] Send connect handshake for", "proposedId", proposedId, "serverId", serverId, "socket.id", socket.id);

		        socket.send(JSON.stringify({
		            type: "__ASSIGN-ID__",
		            id: proposedId,
		            serverId: serverId
		        }));
		    });
    	},
    	on: gee.on.bind(gee)
    });
};

