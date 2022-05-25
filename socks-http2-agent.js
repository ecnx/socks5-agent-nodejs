/* Socks Proxy H2 Agent */

/* jshint esversion: 6 */
/* jshint node: true */
"use strict";

const http = require('http'),
    tls = require('tls'),
    http2 = require('http2'),
    SocksProxy = require('./socks-proxy');

function SocksProxyH2(options, selectProxyEndpoint) {
    this.pool = [];

    if (options.hasOwnProperty('proxy')) {
        if (!options.proxy.hasOwnProperty('host') ||
            options.proxy.hasOwnProperty('port')) {
            throw new Error('Proxy endpoint is invalid');
        }
        this.proxy = options.proxy;
    } else if (selectProxyEndpoint) {
        this.selectProxyEndpoint = selectProxyEndpoint;
        this.proxy = null;
    } else {
        throw new Error('Proxy config is invalid');
    }

    if (options.hasOwnProperty('connectTimeout')) {
        this.connectTimeout = options.connectTimeout;
    } else {
        this.connectTimeout = 5000;
    }

    if (options.hasOwnProperty('socketTimeout')) {
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

SocksProxyH2.prototype.findClient = function(options, callback) {
    if (this.proxy === null) {
        this.selectProxyEndpoint((err, proxy) => {
            if (err) {
                callback(err);
            } else {
                this.proxy = proxy;
                this.processClient(options, callback);
            }
        });
    } else {
        this.processClient(options, callback);
    }
};

SocksProxyH2.prototype.recycleClient = function(options) {
    for (let i = 0; i < this.pool.length; i++) {
        const client = this.pool[i];
        if (client.enabled &&
            client.scheme === options.scheme &&
            client.authority === options.authority) {
            return client;
        }
    }
    return null;
};

function run_locked(lock, callback) {
    if (!lock.locked) {
        lock.locked = true;
        callback();
    }
}

SocksProxyH2.prototype.processClient = function(options, callback) {
    const lock = {};
    const recycled = this.recycleClient(options);
    if (recycled !== null) {
        run_locked(lock, () => {
            callback(null, recycled.session);
        });
        return;
    }
    SocksProxy.connect({
        proxy: this.proxy,
        endpoint: options.endpoint,
        timeout: this.connectTimeout,
        ontimeout: () => {
            this.resetProxy();
        }
    }, (err, socket) => {
        if (err) {
            run_locked(lock, () => {
                callback(err);
            });
            return;
        }
        socket.setTimeout(this.socketTimeout);
        if (options.scheme === 'https') {
            const tlssocket = tls.connect({
                host: options.authority,
                servername: options.authority,
                socket: socket,
                rejectUnauthorized: this.rejectUnauthorized,
                ALPNProtocols: ['h2'],
            });
            tlssocket.on('close', () => {
                run_locked(lock, () => {
                    callback(new Error('TLS Socket closed'));
                });
            });
            tlssocket.once('secureConnect', () => {
                if (tlssocket.authorized || this.rejectUnauthorized === false) {
                    this.setupConnection(options, tlssocket, lock, callback);
                } else {
                    callback(new Error('TLS Socket unauthorized'));
                }
            });
            tlssocket.on('error', (err) => {
                run_locked(lock, () => {
                    callback(err);
                });
            });
        } else {
            this.setupConnection(options, socket, lock, callback);
        }
    });
};

SocksProxyH2.prototype.setupConnection = function(options, socket, lock, callback) {
    const client = {
        enabled: false,
        scheme: options.scheme,
        authority: options.authority,
        session: http2.connect(options.scheme + '://' + options.authority, {
            createConnection: () => {
                return socket;
            }
        })
    };
    client.session.on('error', (err) => {
        client.enabled = false;
        client.session.destroy();
        run_locked(lock, () => {
            callback(err);
        });
    }).on('close', (err) => {
        client.enabled = false;
        client.session.destroy();
        run_locked(lock, () => {
            callback(new Error('Http2 session closed'));
        });
    }).on('timeout', (err) => {
        client.enabled = false;
        client.session.destroy();
        run_locked(lock, () => {
            callback(new Error('Http2 session timed out'));
        });
    }).on('connect', () => {
        run_locked(lock, () => {
            client.enabled = true;
            this.pool.push(client);
            callback(null, client.session);
        });
    });
};

SocksProxyH2.prototype.resetProxy = function() {
    if (this.hasOwnProperty('selectProxyEndpoint')) {
        this.proxy = null;
    }
};

SocksProxyH2.prototype.destroy = function() {
    for (let i = 0; i < this.pool.length; i++) {
        const client = this.pool[i];
        if (client.enabled) {
            client.enabled = false;
            client.session.destroy();
        }
    }
};

module.exports = SocksProxyH2;
