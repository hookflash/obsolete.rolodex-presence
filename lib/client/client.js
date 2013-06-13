/*
 * Original Code:
 *   * Copyright: 2012 ajax.org B.V
 *   * License: MIT
 *   * Author: Christoph Dorn <christoph@christophdorn.com>
 * Modifications:
 *   * Copyright: 2013 SMB Phone Inc.
 *   * License: MIT
 *   * Author: Christoph Dorn <christoph@christophdorn.com>
 */

define([
	"rolodex/eventemitter2",
	"rolodex-presence/engine.io",
], function(EVENTS, ENGINE_IO) {

	// Import globals.
	var WINDOW = window;

	ENGINE_IO = WINDOW.eio;

	var TRANSPORT = {};


	function RolodexPresence(options) {
		var self = this;
		self._options = options || {};
		self._options.baseURL = self._options.baseURL || "";
		if (!self._options.rolodex) {
			throw new Error("`options.rolodex` must be set!");
		}
		self._routes = {
            server: "/.openpeer-rolodex-presence/server"
		};

		var reconnect = true;
		self.connection = null;

		self._onlineContacts = {};

		function ensureConnection() {
			if (!reconnect) return;
			return self._options.rolodex.getServices().then(function(services) {

				var sid = null;
				var loggedin = false;
				for (var serviceId in services) {
					if (!sid) sid = services[serviceId].sid;
					if (services[serviceId].loggedin) {
						loggedin = true;
					}
				}

				// If no services are logged in we don't want a server connection.
				if (!loggedin) {
					if (self.connection) {
						self.connection.destroy();
					}
					return;
				}

				// If at least one service is logged in we want a server connection
				// if we don't already have one.
				if (self.connection !== null) return;

				self.connection = false;
				return TRANSPORT.connect({
					uri: (self._options.baseURL) ? self._options.baseURL.replace(/^http/, "ws") : false,
					path: self._routes.server,
					sid: sid
				}, function(err, connection) {
					if (err) {
						self.connection = null;
						console.error(err.stack);
						return;
					}
					connection.on("connect", function() {
						try {
							self.connection = connection;
							self.emit("online");
						} catch(err) {
							console.error(err.stack);
						}
					});
					connection.on("disconnect", function(reason) {
						try {
							self.emit("offline");
						} catch(err) {
							console.error(err.stack);
						}
					});
					connection.on("destroy", function(reason) {
						try {
							self.connection = null;
							self.emit("offline");
						} catch(err) {
							console.error(err.stack);
						}
					});
					connection.on("message", function(message) {
						try {
							if (message.type === "logout") {
								// Permanently disconnect.
								reconnect = false;
								self.connection.destroy();
								self.emit("logout");
								return;
							}
							if (
								message.type === "online" ||
								message.type === "offline" ||
								message.type === "away" ||
								message.type === "back"
							) {
								if (message.type === "offline") {
									delete self._onlineContacts[message.from];
								} else {
									self._onlineContacts[message.from] = (message.type === "away") ? "away" : "online";
								}
								if (message.peerContact === "added" || message.peerContact === "removed") {
									self._options.rolodex.getContacts("*", null, true).then(function() {
										self.emit("contact." + message.type, message.from);
									});
								} else {
									self.emit("contact." + message.type, message.from);
								}
							} else
							if (message.type === "message") {
								self.emit("contact.message", message.from, message.message);
							}
						} catch(err) {
							console.error(err.stack);
						}
					});
					connection.on("away", function() {
						try {
							self.emit("away");
						} catch(err) {
							console.error(err.stack);
						}
					});
					connection.on("back", function() {
						try {
							self.emit("back");
						} catch(err) {
							console.error(err.stack);
						}
					});
				});
			}).done();
		}

		self._options.rolodex.on("fetched.services", ensureConnection);
		ensureConnection();
	}

	RolodexPresence.prototype = Object.create(EVENTS.prototype);

	RolodexPresence.prototype.getOnlineContacts = function() {
		return this._onlineContacts;
	}

	RolodexPresence.prototype.sendMessage = function(to, message) {
		var self = this;
		if (!self.connection) {
			throw new Error("Cannot send message. Not connected to server.");
		}
		return self.connection.send({
			type: "message",
			to: to,
			message: message
		});
	};


	// `engine.io` wrapper for stable connection.

	((function (exports) {

		var transports = [];
		var debugHandler = null;
		var connectCounter = 0;


		function getLogTimestamp() {
			var date = new Date();
			return "[" + date.toLocaleTimeString() + ":" + date.getMilliseconds() + "]";
		}

		var Transport = function(options) {
			this.options = options;
			if (!this.options.uri) {
				this.options.host = this.options.host || document.location.hostname;
				if (this.options.port === 443) {
					this.options.secure = true;
				}
				this.options.port = this.options.port || document.location.port;
				this.options.uri = "ws" + ((this.options.secure)?"s":"") + "://" + 
				   this.options.host + 
				   ((this.options.port)?":"+this.options.port:"");
			} else {
				var m = this.options.uri.match(/^([^:]*?):\/\/([^:]*):?(\d*)(\/|$)/);
				if (m) {
					this.options.uri = m[1] + "://" + m[2] + ":" + ((m[1] === "https" || m[1] === "wss") ? 443 : (m[3] || 80));
				}
			}
			this.wsUri = this.options.uri;
			delete this.options.uri;
			this.options.path = this.options.path;
			this.options.sid = this.options.sid || false;
			this.id = false;
			this.socket = null;
			this.serverId = false;
			this.connecting = false;
			this.connected = false;
			this.away = false;
			this.buffer = false;
			this.connectIndex = -1;
			this.reconnect = true;
		}

		Transport.prototype = Object.create(EVENTS.prototype);

		Transport.prototype.getUri = function() {
			if (this.options.uri) {
				return this.options.uri + this.options.path;
			}
			return "ws" + ((this.options.secure)?"s":"") + "://" + 
				   this.options.host + 
				   ((this.options.port)?":"+this.options.port:"") +
				   this.options.path;
		}

		Transport.prototype._log = function () {
			if (!self.debug) return;
			var args = Array.prototype.slice.call(arguments);
			var severity = "log";
			args.unshift(getLogTimestamp() + "[rolodex-presence:" + this.connectIndex + ":" + this.getUri() + "]");
	    	if (args.length === 1) {
	    		console[severity](args[0]);
	    	} else
	    	if (args.length === 2) {
	    		console[severity](args[0], args[1]);
	    	} else
	    	if (args.length === 3) {
	    		console[severity](args[0], args[1], args[2]);
	    	} else
	    	if (args.length === 4) {
	    		console[severity](args[0], args[1], args[2], args[3]);
	    	} else
	    	if (args.length === 5) {
	    		console[severity](args[0], args[1], args[2], args[3], args[4]);
	    	} else
	    	if (args.length === 6) {
	    		console[severity](args[0], args[1], args[2], args[3], args[4], args[5]);
	    	} else
	    	if (args.length === 7) {
	    		console[severity](args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
	    	} else
	    	if (args.length === 8) {
	    		console[severity](args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]);
	    	} else {
	    		throw new Error("Too many arguments");
	    	}
		}

		Transport.prototype.connect = function(options, callback) {
			var self = this;
			connectCounter += 1;
			self.connectIndex = connectCounter;

			var log = self._log.bind(self);

			var failed = false;

			try {

				log("Try connect", options, "connectIndex: " + self.connectIndex + " away: " + self.away + " connected: " + self.connected + " connecting:" + self.connecting);

				if (!self.away && self.connected) {
					throw new Error("rolodex-presence '" + self.getUri() + "' is already connected!");
				}
				if (self.connecting) {
					throw new Error("rolodex-presence '" + self.getUri() + "' is already connecting!");
				}

				self.connecting = true;

				function reconnect() {
					log("Trigger re-connect scheduler.");

					if (!self.reconnect) {
						log("Don't reconnect based on `reconnect` property.");
						return;
					}

					if (typeof options.reconnectAttempt === "undefined") {
						options.reconnectAttempt = 0;
					}

					options.reconnectAttempt += 1;

					if (options.reconnectAttempt === 6) {
						self.away = false;
			            self.connected = false;
			            try {
							self.emit("disconnect", "away re-connect attempts exceeded");
						} catch(err) {
							console.error(err.stack);
						}
					}

					var delay = 250;
					if (options.reconnectAttempt > 10) {
						delay = 15 * 1000;
					}
					else if (options.reconnectAttempt > 5) {
						delay = 5 * 1000;
					}
					else if (options.reconnectAttempt > 3) {
						delay = 1 * 1000;
					}

					log("Schedule re-connect in: " + delay);

					setTimeout(function() {

						log("Reconnect", "reconnectAttempt: " + options.reconnectAttempt + " away: " + self.away + " connected: " + self.connected + " connecting:" + self.connecting);

						if (!self.away && self.connected) {
							log("Don't re-connect. Already connected!");
							return;
						}
						if (self.connecting) {
							log("Don't re-connect. Already connecting!");
							return;
						}

						if (!self.reconnect) {
							log("Don't reconnect based on `reconnect` property.");
							return;
						}

						try {
							self.emit("reconnect", options.reconnectAttempt);
						} catch(err) {
							console.error(err.stack);
						}

						self.connect({
							reconnectAttempt: options.reconnectAttempt,
							fireConnect: (options.reconnectAttempt >= 6) ? true : false
						}, function(err) {
							if (err) {
								reconnect();
								return;
							}
						});
					}, delay);
				}

				self.socket = new ENGINE_IO.Socket(self.wsUri, self.options);

				self.socket.on("error", function (err) {
					log("Connect error (failed: " + failed + "): " + err.stack);
					// Only relay first connection error.
					if (!failed) {
						failed = true;

						self.connecting = false;
						try {
							callback(err);
						} catch(err) {
							console.error(err.stack);
						}

						log("Close failed socket (" + self.socket.readyState + ") on error");
						if (self.socket.readyState !== "closed") {
							try {
								self.socket.close();
							} catch(err) {}
						}
					}
				});

				self.socket.on("pong", function (pongPayload) {
					if (failed) {
						log("Close failed socket (" + self.socket.readyState + ") on heartbeat");
						if (self.socket.readyState !== "closed") {
							try {
								self.socket.close();
							} catch(err) {}
						}
						return;
					} else
					if (pongPayload && pongPayload.serverId && pongPayload.serverId !== self.serverId) {
	            		// If `pongPayload.serverId` does not match our cached `self.serverId` we close
	            		// the connection and re-connect as the server instance has changed and we may need to re-init.
						log("Detected server reboot on heartbeat. Close connection.");
						if (self.socket.readyState !== "closed") {
							try {
								self.socket.close();
							} catch(err) {}
						}
						return;
					}
					self.emit("heartbeat");
				});

				self.socket.on("heartbeat", function () {
					if (failed) {
						log("Close failed socket (" + self.socket.readyState + ") on heartbeat");
						if (self.socket.readyState !== "closed") {
							try {
								self.socket.close();
							} catch(err) {}
						}
						return;
					}
				});

				self.socket.on("open", function () {

					if (failed) {
						log("Close failed socket (" + self.socket.readyState + ") on open");
						if (self.socket.readyState !== "closed") {
							try {
								self.socket.close();
							} catch(err) {}
						}
						return;
					}

					if (!self.reconnect) {
						self.connecting = false;
						self.connected = false;
						log("Don't connect based on `reconnect` property.");
						return;
					}

					log("Init new socket (" + self.socket.id + ")");

					self.socket.on("message", function (message) {

						if (!self.reconnect) {
							self.connecting = false;
							self.connected = false;
							log("Don't process message based on `reconnect` property.");
							return;
						}

						try {
							message = JSON.parse(message);
						} catch(err) {
							// TODO: Log error?
							return;
						}

			            if (typeof message === "object" && message.type === "__ASSIGN-ID__") {

        					self.connecting = false;

			            	if (self.serverId !== false && self.serverId !== message.serverId) {
			            		// If `message.serverId` does not match our cached `self.serverId` we issue
			            		// a connect as the server instance has changed and we may need to re-init.
								log("Detected server reboot on handshake. Issue re-connect.");
								options.fireConnect = true;
								if (self.connected === true) {
									self.connected = false;
									try {
										self.emit("disconnect", "server reboot");
									} catch(err) {
										console.error(err.stack);
									}
								}
			            	}
		            		self.serverId = message.serverId;

			            	if (self.id === false) {
				            	self.id = message.id;
				            }
				            self.socket.send(JSON.stringify({
				            	type: "__ANNOUNCE-ID__",
				            	id: self.id,
				            	sid: self.options.sid || false,
				            	serverId: self.serverId
				            }));
				            if (self.away && (Date.now()-self.away) > 30*1000)  {
								log("Long away (hibernate) detected. Issue re-connect.");
								options.fireConnect = true;
								if (self.connected === true) {
									self.connected = false;
									try {
										self.emit("disconnect", "long away (hibernate)");
									} catch(err) {
										console.error(err.stack);
									}									
								}
				            }
				            self.away = false;
				            self.connected = true;
							log("Connected", "connecting: " + self.connecting + " away: " + self.away + " connected: " + self.connected, "options", options);
				            if (options.fireConnect !== false) {
				            	try {
									self.emit("connect", self);
								} catch(err) {
									console.error(err.stack);
								}
							}
							else if (options.reconnectAttempt > 0) {
								try {
									self.emit("back");
								} catch(err) {
									console.error(err.stack);
								}								
							}
							options.reconnectAttempt = 0;
							if (self.buffer) {
								self.buffer.forEach(function(message) {
									self.socket.send(message);
								});
								self.buffer = false;
							}
			            } else {
			            	try {
								self.emit("message", message);
							} catch(err) {
								console.error(err.stack);
							}							
			            }
					});

					self.socket.on("close", ondisconnect);
					self.socket.on("error", ondisconnect);

					var once = false;
					function ondisconnect(reason) {

    					self.connecting = false;

						// Only one try to reconnect
						if (once) return;
						once = true;

						log("Disconnect socket: " + reason);

						if (!self.reconnect) {
							self.connected = false;
							log("Don't continue processing disconnect based on `reconnect` property.");
							return;
						}

						if (self.connected) {
							self.away = Date.now();
							try {
								self.emit("away");
							} catch(err) {
								console.error(err.stack);
							}
						}

						return reconnect();
					};
					return callback(null, self);
				});

			} catch(err) {
				return callback(err);
			}
		}
		Transport.prototype.destroy = function(callback) {
			var self = this;
			self._log("Destroy requested by user");
			self.reconnect = false;
			if (self.socket && self.socket.readyState !== "closed") {
				try {
					self.socket.close();
				} catch(err) {}
			}
			self.emit("destroy");
			if (callback) return callback(null);
		}
		Transport.prototype.send = function(message) {
			if (this.connected === false) {
				var err = new Error("Cannot send rolodex-presence message while disconnected! Sender should respect connect/disconnect states!");
				// We log error here in case sender does not catch.
				console.log(err.stack);
				throw err;
			}
			else if(this.away) {
				if (!this.buffer) {
					this.buffer = [];
				}
				this.buffer.push(JSON.stringify(message));
				return;
			}
			return this.socket.send(JSON.stringify(message));
		}

		exports.connect = function(options, callback) {
			var transport = new Transport(options, callback);
			transports.push(transport);
			if (debugHandler) {
				debugHandler.hookTransport(transport);
			}
			if (transport.debug) {
				console.log(getLogTimestamp() + "[rolodex-presence:" + transport.getUri() + "] New transport", options);
			}
			transport.connect({}, callback);
			return transport;
		}

		exports.setDebug = function(debug, events) {
			if (debugHandler !== null) {
				debugHandler.stop();
				if (WINDOW.localStorage) {
					localStorage.rolodexPresenceDebug = "";
					localStorage.debug = "";
				}
			}
			if (!debug) return;
			events = events || [];
			if (WINDOW.localStorage) {
				localStorage.rolodexPresenceDebug = JSON.stringify([debug, events]);
			}
			debugHandler = {
				transports: [],
				handlers: [],
				start: function() {
					transports.forEach(debugHandler.hookTransport);
				},
				stop: function() {
					transports.forEach(debugHandler.unhookTransport);
					debugHandler = null;
				},
				hookTransport: function(transport) {
					var index = debugHandler.transports.indexOf(transport);
					if (index !== -1) return;

					function log(message) {
						console.log(getLogTimestamp() + "[rolodex-presence:" + transport.connectIndex + ":" + transport.getUri() + "] " + message);
					}

					log("Hook debugger");

					var listeners = {};

					transport.debug = true;

					transport.on("connect", listeners["connect"] = function() {
						log("Connect");
					});
					transport.on("reconnect", listeners["reconnect"] = function(attempt) {
						log("Reconnect: " + attempt);
					});
					transport.on("disconnect", listeners["disconnect"] = function(reason) {
						log("Disconnect: " + reason);
					});
					transport.on("destroy", listeners["destroy"] = function() {
						log("Destroy");
					});
					transport.on("heartbeat", listeners["heartbeat"] = function(message) {
						log("Heartbeat");
					});
					if (events.indexOf("message") !== -1) {
						transport.on("message", listeners["message"] = function(message) {
							log("Message", message);
						});
					}
					transport.on("away", listeners["away"] = function() {
						log("Away");
					});
					transport.on("back", listeners["back"] = function() {
						log("Back");
					});

					if (events.indexOf("engine.io") !== -1) {
						if (WINDOW.localStorage) {
							localStorage.debug = "*";
						}
					}

					debugHandler.transports.push(transport);
					debugHandler.handlers.push({
						unhook: function() {
							log("Unhook debugger");
							transport.debug = false;
							for (var type in listeners) {
								transport.removeListener(type, listeners[type]);
							}
						}
					});
				},
				unhookTransport: function(transport) {
					var index = debugHandler.transports.indexOf(transport);
					if (index === -1) return;
					debugHandler.transports.splice(index, 1);
					debugHandler.handlers[index].unhook();
					debugHandler.handlers.splice(index, 1);
				}
			};
			debugHandler.start();
		}

		if (WINDOW.localStorage && localStorage.rolodexPresenceDebug) {
			exports.setDebug.apply(null, JSON.parse(localStorage.rolodexPresenceDebug));
		}
	})(TRANSPORT));

	RolodexPresence.setDebug = TRANSPORT.setDebug;

	return RolodexPresence;
});
