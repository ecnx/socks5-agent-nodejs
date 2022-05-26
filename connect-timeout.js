/* Network Socket Connect with Timeout */

/* jshint esversion: 6 */
/* jshint node: true */
"use strict";

const net = require('net');

module.exports = {
    connect: connect
};

/* --- Utility Functions --- */

function isport(value) {
    return Number.isInteger(value) && value >= 0 && value < 65536;
}

function destroy_socket(context) {
    try {
        context.socket.destroy();
    } catch (unused) {}
}

/* --- Connect with Timeout --- */

function connect_timeout_next(context, callback) {
    if (context.timeout !== null) {
        context.timer = setTimeout(() => {
            callback(new Error('Connect timed out'), null, true);
        }, context.timeout);
    }
    context.socket.on('error', (err) => {
        destroy_socket(context);
        callback(err);
    }).on('close', () => {
        destroy_socket(context);
        callback(new Error('Socket closed'));
    }).on('timeout', () => {
        destroy_socket(context);
        callback(new Error('Socket timed out'));
    });
    context.socket.connect(context.endpoint.port, context.endpoint.host, (err) => {
        if (err) {
            callback(err);
        } else if (!context.done) {
            context.socket.removeAllListeners('error');
            context.socket.removeAllListeners('close');
            context.socket.removeAllListeners('timeout');
            callback(null, context.socket);
        }
    });
}

/* --- Connect with Timeout Task --- */

function connect(options, callback) {
    if (!options.endpoint) {
        callback(new Error('Endpoint option required'));
        return;
    }

    if (typeof options.endpoint.host !== 'string' ||
        !isport(options.endpoint.port)) {
        callback(new Error('Endpoint option is invalid'));
        return;
    }

    if (options.timeout !== null &&
        (!Number.isInteger(options.timeout) || options.timeout < 0)) {
        callback(new Error('Timeout option is invalid'));
        return;
    }

    const context = {
        done: false,
        endpoint: options.endpoint,
        timeout: options.timeout,
        timer: null,
        socket: new net.Socket()
    };

    connect_timeout_next(context, (err, socket, timedout) => {
        const endflag = !context.done;
        context.done = true;

        if (err) {
            destroy_socket(context);
        }

        if (context.timer) {
            clearTimeout(context.timer);
            context.timer = null;
        }

        if (endflag) {
            callback(err, socket, timedout);
        }
    });
}
