/* Socks Proxy Connect Library */

/* jshint esversion: 6 */
/* jshint node: true */
"use strict";

const net = require('net'),
    connect_timeout = require('./connect-timeout');

module.exports = {
    connect: connect
};

/* --- Proxy Socket Functions --- */

function to_timeout_or_null(input) {
    return Number.isInteger(input) && input > 0 ? input : null;
}

function connect_socket(context, endpoint, onerror, onsuccess) {
    const timeout = to_timeout_or_null(context.options.timeout);

    connect_timeout.connect({
        endpoint: endpoint,
        timeout: timeout
    }, (err, socket, timedout) => {
        if (err) {
            onerror(err, socket, timedout);
        } else {
            if (!context.done) {
                context.socket = socket;
                if (timeout !== null) {
                    context.socket.setTimeout(timeout);
                }
                context.socket.on('error', (err) => {
                    destroy_socket(context);
                    onerror(err);
                }).on('close', () => {
                    destroy_socket(context);
                    onerror(new Error('Socket closed'));
                }).on('timeout', () => {
                    destroy_socket(context);
                    onerror(new Error('Proxy connect timed out'), null, true);
                });
                onsuccess();
            }
        }
    });
}

function recv_buffer(context, callback) {
    context.socket.once('data', (chunk) => {
        const data = Buffer.from(chunk, 'binary');
        callback(data);
    });
}

function destroy_socket(context) {
    try {
        context.socket.destroy();
    } catch (unused) {}
}

/* --- Proxy Finish Stage --- */

function proxy_finish(context, callback) {
    if (!context.done) {
        context.socket.removeAllListeners('error');
        context.socket.removeAllListeners('close');
        context.socket.removeAllListeners('timeout');
        context.socket.setTimeout(0);
        console.log('proxy connect successful.');
        callback(null, context.socket);
    }
}

/* --- Proxy Authentication Stage --- */

function proxy_authenticate(context, credentials, onerror, onsuccess) {
    if (!context.done) {
        console.log('performing proxy auth....');
        const userbuf = Buffer.from(credentials.username, 'utf8');
        if (userbuf.length > 255) {
            onerror(new Error('Proxy username is too long'));
            return;
        }
        const passbuf = Buffer.from(credentials.password, 'utf8');
        if (passbuf.length > 255) {
            onerror(new Error('Proxy password is too long'));
            return;
        }
        recv_buffer(context, (data) => {
            if (data.length == 2 && data[0] == 1 && data[1] == 0) {
                onsuccess();
            } else {
                onerror(new Error('Proxy authentication failed'));
            }
        });
        context.socket.write(Buffer.concat([
            Buffer.from([1, userbuf.length]),
            userbuf,
            Buffer.from([passbuf.length]),
            passbuf
        ]));
    }
}

/* --- Proxy Request Stage --- */

function proxy_request(context, endpoint, onerror, onsuccess) {
    if (!context.done) {
        console.log('performing proxy request...');
        const hostbuf = Buffer.from(endpoint.host, 'utf8');
        if (hostbuf.length > 255) {
            onerror(new Error('Endpoint host is too long'));
            return;
        }
        recv_buffer(context, (data) => {
            if (data.length >= 2 && data[0] == 5 && data[1] == 0) {
                onsuccess();
            } else {
                onerror(new Error('Proxy request failed'));
            }
        });
        context.socket.write(Buffer.concat([
            Buffer.from([5, 1, 0, 3, hostbuf.length]),
            hostbuf,
            Buffer.from([endpoint.port >> 8, endpoint.port & 0xff])
        ]));
    }
}

/* --- Proxy Handshake Stage --- */

function proxy_handshake(context, credentials, onerror, onsuccess) {
    if (!context.done) {
        console.log('performing proxy handshake...');
        const auth_method = credentials ? 2 : 0;
        recv_buffer(context, (data) => {
            if (data.length == 2 && data[0] == 5 && data[1] == auth_method) {
                onsuccess();
            } else {
                onerror(new Error('Proxy handshake failed'));
            }
        });
        context.socket.write(Buffer.from([5, 1, auth_method]));
    }
}

/* --- Connect via Proxy Internal --- */

function connect_next(context, callback) {
    proxy_handshake(context, context.options.credentials, callback, () => {
        if (context.options.credentials) {
            proxy_authenticate(context, context.options.credentials, callback, () => {
                proxy_request(context, context.options.endpoint, callback, () => {
                    proxy_finish(context, callback);
                });
            });
        } else {
            proxy_request(context, context.options.endpoint, callback, () => {
                proxy_finish(context, callback);
            });
        }
    });
}

function connect_internal(context, callback) {
    if (context.options.bridge) {
        console.log('connecting proxy via bridge...');
        connect_socket(context, context.options.bridge, callback, () => {
            proxy_handshake(context, null, callback, () => {
                proxy_request(context, context.options.proxy, callback, () => {
                    connect_next(context, callback);
                });
            });
        });
    } else {
        console.log('connecting proxy directly...');
        connect_socket(context, context.options.proxy, callback, () => {
            connect_next(context, callback);
        });
    }
}

/* --- Options Validation --- */

function isport(value) {
    return Number.isInteger(value) && value >= 0 && value < 65536;
}

function options_validate(options) {
    if (!options.endpoint) {
        return new Error('Endpoint option required');
    }

    if (typeof options.endpoint.host !== 'string' ||
        !isport(options.endpoint.port)) {
        return new Error('Endpoint option is invalid');
    }

    if (!options.proxy) {
        return new Error('Proxy option required');
    }

    if (typeof options.proxy.host !== 'string' ||
        !isport(options.proxy.port)) {
        return new Error('Proxy option is invalid');
    }

    if (options.bridge) {
        if (typeof options.proxy.host !== 'string' ||
            !isport(options.proxy.port)) {
            return new Error('Proxy option is invalid');
        }
    }

    if (options.credentials) {
        if (typeof options.credentials.username !== 'string' ||
            typeof options.credentials.password !== 'string') {
            return new Error('Proxy option is invalid');
        }
    }

    return null;
}

/* --- Connect via Proxy Task --- */

function connect(options, callback) {
    const verr = options_validate(options);
    if (verr) {
        callback(verr);
        return;
    }

    const context = {
        done: false,
        options: options
    };

    connect_internal(context, (err, socket, timedout) => {
        const endflag = !context.done;
        context.done = true;
        if (err) {
            destroy_socket(context);
        }
        if (endflag) {
            callback(err, socket, timedout);
        }
    });
}
