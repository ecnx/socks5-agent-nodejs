/* Socks-5 Proxy Agent Library */

/* jshint esversion: 6 */
/* jshint node: true */
"use strict";

const tls = require('tls'),
    socks = require('./socks-proxy');

module.exports = SocksProxyAgent;

function SocksProxyAgent(options, selectProxyEndpoint) {
    this.sockets = [];

    /* Setup keep alive options */
    this.keepAlive = !!options.keepAlive;

    /* Reset request count */
    this.reqcount = 0;

    /* Check proxy endpoint */
    if (options.hasOwnProperty('proxy') && selectProxyEndpoint) {
        throw new Error('Dynamic and static endpoint selections are exclusive');
    }

    /* Setup proxy endpoint */
    if (options.hasOwnProperty('proxy')) {
        if (!this.checkProxy(options.proxy)) {
            throw new Error('Proxy endpoint is invalid');
        }
        this.proxy = options.proxy;
    } else if (selectProxyEndpoint) {
        this.selectProxyEndpoint = selectProxyEndpoint;
        this.proxy = null;
    } else {
        throw new Error('Proxy config is invalid');
    }

    /* Setup proxy bridge */
    if (options.hasOwnProperty('bridge')) {
        if (!this.checkProxy(options.bridge)) {
            throw new Error('Proxy bridge is invalid');
        }
        this.bridge = options.bridge;
    }

    /* Setup connect timeout */
    if (options.hasOwnProperty('connectTimeout')) {
        if (!this.checkPositiveInteger(options.connectTimeout)) {
            throw new Error('Connect timeout must be a positive integer');
        }
        this.connectTimeout = options.connectTimeout;
    } else {
        this.connectTimeout = 5000;
    }

    /* Setup socket timeout */
    if (options.hasOwnProperty('socketTimeout')) {
        if (!this.checkPositiveInteger(options.socketTimeout)) {
            throw new Error('Socket timeout must be a positive integer');
        }
        this.socketTimeout = options.socketTimeout;
    } else {
        this.socketTimeout = 30000;
    }

    /* Setup request limit */
    if (options.hasOwnProperty('reqlimit')) {
        if (!selectProxyEndpoint) {
            throw new Error('Request limit needs dynamic endpoint selection');
        }
        if (!this.checkPositiveInteger(options.reqlimit)) {
            throw new Error('Request limit be a positive integer');
        }
        this.reqlimit = options.reqlimit;
    }
}

SocksProxyAgent.prototype.checkPositiveInteger = function(value) {
    return !isNaN(value) && value > 0 && Math.floor(value) === value;
};

SocksProxyAgent.prototype.checkPort = function(port) {
    return this.checkPositiveInteger(port) && port <= 65535;
};

SocksProxyAgent.prototype.checkProxy = function(proxy) {
    return proxy.hasOwnProperty('host') && this.checkPort(proxy.port);
};

SocksProxyAgent.prototype.setupSocket = function(socket, endpoint) {
    socket.locked = false;
    socket.revoked = false;
    socket.endpoint = endpoint;
    socket.on('close', () => {
        this.revokeSocket(socket);
    });
    socket.on('error', () => {
        this.revokeSocket(socket);
    });
};

SocksProxyAgent.prototype.setupConnection = function(options, socket, callback) {
    if (options.hasOwnProperty('_defaultAgent') && options._defaultAgent.protocol === 'https:') {
        const tlssocket = tls.connect({
            servername: options.host,
            socket: socket
        }, () => {
            callback(null, tlssocket);
        }).on('error', (e) => {
            callback(e);
        });
    } else {
        callback(null, socket);
    }
};

SocksProxyAgent.prototype.createConnection = function(options, callback) {
    if (this.proxy === null) {
        this.selectProxyEndpoint((err, proxy) => {
            if (err) {
                callback(err);
            } else {
                this.proxy = proxy;
                this.openConnection(options, callback);
            }
        });
    } else {
        this.openConnection(options, callback);
    }
};

SocksProxyAgent.prototype.openConnection = function(options, callback) {
    const socksopt = {
        endpoint: {
            host: options.host,
            port: options.port
        },
        proxy: this.proxy,
        ontimeout: () => {
            this.resetProxy();
        }
    };
    if (this.hasOwnProperty('connectTimeout')) {
        socksopt.timeout = this.connectTimeout;
    }
    if (this.hasOwnProperty('bridge')) {
        socksopt.bridge = this.bridge;
    }
    socks.connect(socksopt, (err, socket) => {
        if (err) {
            callback(err);
        } else {
            this.finalizeConnection(socket, options, callback);
        }
    });
};

SocksProxyAgent.prototype.finalizeConnection = function(socket, options, callback) {
    this.setupConnection(options, socket, (err, socket) => {
        if (err) {
            callback(err);
        } else {
            this.setupSocket(socket, {
                host: options.host,
                port: options.port
            });
            this.sockets.push(socket);
            callback(null, socket);
        }
    });
};

SocksProxyAgent.prototype.reuseSocket = function(socket, request) {
    socket.locked = true;
};

SocksProxyAgent.prototype.findFreeSocket = function(endpoint) {
    for (let i = 0; i < this.sockets.length; i++) {
        const socket = this.sockets[i];
        if (socket.revoked === false &&
            socket.locked === false &&
            socket.endpoint.host === endpoint.host &&
            socket.endpoint.port === endpoint.port) {
            return socket;
        }
    }
    return null;
};

SocksProxyAgent.prototype.runRequest = function(socket, request) {
    socket.request = request;
    socket.setTimeout(this.socketTimeout);
    request.prependListener('response', (response) => {
        response.prependListener('end', () => {
            socket.setTimeout(0);
            socket.request = null;
            socket.locked = false;
            socket.unref();
        });
        response.on('error', () => {
            this.revokeSocket(socket);
        });
    });
    request.on('error', () => {
        this.revokeSocket(socket);
    });
    socket.ref();
    request.onSocket(socket);
};

SocksProxyAgent.prototype.addRequest = function(request, options) {
    if (this.hasOwnProperty('reqlimit')) {
        console.log('request limit: ' + this.reqcount + ' / ' + this.reqlimit);
        if (this.reqcount >= this.reqlimit) {
            this.destroy();
        }
    }
    request.shouldKeepAlive = this.keepAlive;
    const socket = this.findFreeSocket({
        host: options.host,
        port: options.port
    });
    if (socket === null) {
        this.createConnection(options, (err, newsocket) => {
            if (err) {
                request.emit('error', err);
            } else {
                newsocket.locked = true;
                this.runRequest(newsocket, request);
            }
        });
    } else {
        this.reuseSocket(socket, request);
        this.runRequest(socket, request);
    }
};

SocksProxyAgent.prototype.resetProxy = function() {
    if (this.hasOwnProperty('selectProxyEndpoint')) {
        this.reqcount = 0;
        this.proxy = null;
    }
};

SocksProxyAgent.prototype.destroy = function(request, options) {
    this.reqcount = 0;
    this.resetProxy();
    for (let i = 0; i < this.sockets.length; i++) {
        this.revokeSocket(this.sockets[i]);
    }
    this.sockets = [];
};

SocksProxyAgent.prototype.revokeSocket = function(socket) {
    if (socket.revoked !== true) {
        socket.revoked = true;
        if (socket.request !== null) {
            socket.request.emit('error', new Error('socket closed'));
        }
        socket.destroy();
    }
};
