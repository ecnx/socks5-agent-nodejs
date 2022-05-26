/* Socks Proxy Http2 Agent */

/* jshint esversion: 6 */
/* jshint node: true */
"use strict";

const tls = require('tls'),
    http2 = require('http2'),
    socks_proxy = require('./socks-proxy');

module.exports = SocksHttp2Agent;

/* --- Http2 Agent Creation --- */

function SocksHttp2Agent(options, selectProxyEndpoint) {
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
}

/* --- Http2 Agent Clients Managment --- */

SocksHttp2Agent.prototype.findClient = function(options, callback) {
    if (!options.endpoint) {
        callback(new Error('Endpoint option is required'));
        return;
    }
    if (typeof options.endpoint.host !== 'string' ||
        !Number.isInteger(options.endpoint.port)) {
        callback(new Error('Endpoint option is invalid'));
        return;
    }
    if (typeof options.scheme !== 'string') {
        callback(new Error('Http2 :scheme must be a string'));
        return;
    }
    if (typeof options.authority !== 'string') {
        callback(new Error('Http2 :authority must be a string'));
        return;
    }
    if (this.proxy === null) {
        this.selectProxyEndpoint((err, proxy) => {
            if (err) {
                callback(err);
            } else {
                this.proxy = proxy;
                this.findClientInternal(options, callback);
            }
        });
    } else {
        this.findClientInternal(options, callback);
    }
};

SocksHttp2Agent.prototype.findClientInternal = function(options, callback) {
    for (let i = 0; i < this.pool.length; i++) {
        const client = this.pool[i];
        if (client.ready &&
            client.scheme === options.scheme &&
            client.authority === options.authority) {
            callback(null, client.session);
            return;
        }
    }
    const client = {
        done: false,
        ready: false,
        scheme: options.scheme,
        authority: options.authority,
        session: null,
        tlssocket: null,
        netsocket: null
    };
    this.createNewClient(client, options, (err, session) => {
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

/* --- Http2 Agent Clients Creation --- */

SocksHttp2Agent.prototype.createNewClient = function(client, options, callback) {
    socks_proxy.connect({
        proxy: this.proxy,
        endpoint: options.endpoint,
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
            client.netsocket.setTimeout(this.socketTimeout);
            if (options.scheme === 'https') {
                client.tlssocket = tls.connect({
                    servername: options.authority,
                    socket: client.netsocket,
                    rejectUnauthorized: this.rejectUnauthorized,
                    ALPNProtocols: ['h2'],
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
                        this.setupHttp2Session(client, options, callback);
                    } else {
                        callback(new Error('TLS Socket unauthorized'));
                    }
                });
            } else {
                client.socket = client.netsocket;
                this.setupHttp2Session(client, options, callback);
            }
        }
    });
};

SocksHttp2Agent.prototype.setupHttp2Session = function(client, options, callback) {
    if (!client.done) {
        client.session = http2.connect(options.scheme + '://' + options.authority, {
            createConnection: () => {
                return client.socket;
            }
        });
        client.session.on('error', (err) => {
            callback(err);
        }).on('close', (err) => {
            callback(new Error('Http2 Session closed'));
        }).on('timeout', (err) => {
            callback(new Error('Http2 Session timed out'));
        }).once('connect', () => {
            if (!client.done) {
                client.ready = true;
                this.pool.push(client);
                callback(null, client.session);
            }
        });
    }
};

/* --- Http2 Agent Cleanup --- */

SocksHttp2Agent.prototype.destroyClient = function(client) {
    client.ready = false;
    if (client.session) {
        try {
            client.session.destroy();
        } catch (unused) {}
    }
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

SocksHttp2Agent.prototype.destroy = function() {
    for (let i = 0; i < this.pool.length; i++) {
        const client = this.pool[i];
        if (client.ready) {
            this.destroyClient(client);
        }
    }
};
