/* Socks Proxy Http Agent */

/* jshint esversion: 6 */
/* jshint node: true */
"use strict";

const tls = require('tls'),
    socks_proxy = require('./socks-proxy');

module.exports = SocksHttpAgent;

/* --- Http Agent Creation --- */

function SocksHttpAgent(options, selectProxyEndpoint) {
    this.pool = [];

    if (options.proxy) {
        this.proxy = options.proxy;
    } else if (selectProxyEndpoint) {
        this.selectProxyEndpoint = selectProxyEndpoint;
        this.proxy = null;
    } else {
        throw new Error('Proxy option is required');
    }

    this.bridge = options.bridge ? options.bridge : null;
    this.credentials = options.credentials ? options.credentials : null;

    if (isNaN(options.connectTimeout)) {
        this.connectTimeout = 10000;
    } else {
        this.connectTimeout = options.connectTimeout;
    }

    if (Number.isInteger(options.socketTimeout) && options.socketTimeout >= 0) {
        this.socketTimeout = options.socketTimeout;
    } else {
        this.socketTimeout = 60000;
    }

    if (options.rejectUnauthorized === false) {
        this.rejectUnauthorized = false;
    } else {
        this.rejectUnauthorized = true;
    }

    this.keepAlive = !!options.keepAlive;
}

SocksHttpAgent.prototype.createClient = function(options, callback) {
    if (!options.endpoint) {
        callback(new Error('Endpoint option is required'));
        return;
    }
    if (typeof options.endpoint.host !== 'string' ||
        !Number.isInteger(options.endpoint.port)) {
        callback(new Error('Endpoint option is invalid'));
        return;
    }

    if (this.proxy === null) {
        this.selectProxyEndpoint((err, proxy) => {
            if (err) {
                callback(err);
            } else {
                this.proxy = proxy;
                this.createClientNext(options, callback);
            }
        });
    } else {
        this.createClientNext(options, callback);
    }
};

/* --- Http2 Agent Clients Creation --- */

SocksHttpAgent.prototype.createClientNext = function(options, callback) {
    const client = {
        done: false,
        ready: false,
        inuse: false,
        protocol: options.protocol,
        endpoint: options.endpoint,
        tlssocket: null,
        netsocket: null
    };
    this.setupClient(client, (err, session) => {
        const endflag = !client.done;
        client.done = true;
        if (err) {
            this.destroyClient(client);
        }
        if (endflag) {
            callback(err, session);
        }
    });
};

SocksHttpAgent.prototype.setupClient = function(client, callback) {
    socks_proxy.connect({
        proxy: this.proxy,
        endpoint: client.endpoint,
        timeout: this.connectTimeout,
        bridge: this.bridge,
        credentials: this.credentials
    }, (err, socket, timedout) => {
        if (err) {
            if (timedout && this.selectProxyEndpoint) {
                this.proxy = null;
            }
            callback(err);
        } else {
            client.netsocket = socket;
            client.netsocket.on('error', (err) => {
                callback(err);
            }).on('close', () => {
                callback(new Error('Socket closed'));
            }).on('timeout', () => {
                callback(new Error('Socket timed out'));
            });
            if (client.protocol === 'https') {
                client.tlssocket = tls.connect({
                    servername: client.endpoint.host,
                    socket: client.netsocket
                });
                client.tlssocket.on('error', (err) => {
                    callback(err);
                }).on('close', () => {
                    callback(new Error('TLS Socket closed'));
                }).on('timeout', () => {
                    callback(new Error('TLS Socket timed out'));
                }).once('secureConnect', () => {
                    if (client.tlssocket.authorized || this.rejectUnauthorized === false) {
                        client.socket = client.tlssocket;
                        client.ready = true;
                        callback(null, client);
                    } else {
                        callback(new Error('TLS Socket unauthorized'));
                    }
                });
            } else {
                client.socket = client.netsocket;
                client.ready = true;
                callback(null, client);
            }
        }
    });
};

/* --- Http Requests Handling --- */

SocksHttpAgent.prototype.addRequest = function(request, options) {
    if (typeof options.host !== 'string') {
        request.emit('error', new Error('Host option is required'));
        return;
    }
    if (!Number.isInteger(options.port)) {
        request.emit('error', new Error('Port option is required'));
        return;
    }

    request.shouldKeepAlive = this.keepAlive;

    const newoptions = {
        endpoint: {
            host: options.host,
            port: options.port
        },
        protocol: 'http'
    };

    if (options._defaultAgent) {
        if (options._defaultAgent.protocol === 'https:') {
            newoptions.protocol = 'https';
        }
    }

    for (let i = 0; i < this.pool.length; i++) {
        const client = this.pool[i];
        if (client.ready && !client.inuse &&
            client.protocol === newoptions.protocol &&
            client.endpoint.host === newoptions.endpoint.host &&
            client.endpoint.port === newoptions.endpoint.port) {

            this.performRequest(client, request);
            return;
        }
    }

    this.createClient(newoptions, (err, client) => {
        if (err) {
            request.emit('error', err);
        } else {
            this.pool.push(client);
            this.performRequest(client, request);
        }
    });
};

SocksHttpAgent.prototype.performRequest = function(client, request) {
    client.inuse = true;
    client.socket.setTimeout(this.socketTimeout);
    request.prependListener('response', (response) => {
        response.prependListener('end', () => {
            client.socket.setTimeout(0);
            client.socket.unref();
            client.inuse = false;
        });
        response.on('error', () => {
            this.destroyClient(client);
        });
    });
    request.on('error', () => {
        this.destroyClient(client);
    });
    client.socket.ref();
    request.onSocket(client.socket);
};

/* --- Http Agent Cleanup --- */

SocksHttpAgent.prototype.destroyClient = function(client) {
    client.ready = false;
    if (client.tlssocket) {
        try {
            client.tlssocket.destroy();
        } catch (unused) {}
    }
    if (client.netsocket) {
        try {
            client.netsocket.destroy();
        } catch (unused) {}
    }
};

SocksHttpAgent.prototype.destroy = function() {
    for (let i = 0; i < this.pool.length; i++) {
        const client = this.pool[i];
        if (client.ready) {
            this.destroyClient(client);
        }
    }
};
