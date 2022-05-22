/* Socks-5 Agent Library */

/* jshint esversion: 6 */
/* jshint node: true */
"use strict";

const net = require('net');

module.exports = {
    connect: connect
};

/* --- Socks Connect --- */

function connect_plain(context) {
    context.socket.connect(context.options.proxy.port, context.options.proxy.host, (err) => {
        if (err) {
            complete(context, err);
        } else {
            console.log('socks5 connected.');
            handshake(context, () => {
                context.progress = 'connected';
                complete(context, null);
            });
        }
    });
}

function connect(options, callback) {
    if (!options.hasOwnProperty('endpoint')) {
        throw new Error('Endpoint not found in options');
    }
    if (!options.endpoint.hasOwnProperty('host') ||
        !options.endpoint.hasOwnProperty('port')) {
        throw new Error('Endpoint is invalid');        
    }
    const context = {
        options: options,
        socket: new net.Socket(),
        progress: 'connect',
        callback: callback
    };
    if (options.ontimeout) {
        context.ontimeout = options.ontimeout;
    }
    setup_timeout(context);
    context.socket.on('error', (err) => {
        complete(context, err);
    });
    context.socket.on('close', () => {
        complete(context, new Error('Socks5 socket closed'));
    });
    connect_plain(context);
}

/* --- Socks Session Processing --- */

function request(context, callback) {
    context.progress = 'request';
    const host = context.options.endpoint.host;
    const port = context.options.endpoint.port;
    context.socket.once('data', function(chunk) {
        const data = Buffer.from(chunk, 'binary');
        if (data.length >= 4 && data[0] == 5 && data[1] == 0 && data[3] == 1) {
            console.log('socks5 request success.');
            callback(null);
        } else {
            context.socket.destroy();
            callback(new Error('Socks5 request failed'));
        }
    });
    const array = [5, 1, 0, 3, host.length];
    for (let i = 0; i < host.length; i++) {
        array.push(host.charCodeAt(i));
    }
    array.push((port & 0xff00) >> 8);
    array.push(port & 0xff);
    context.socket.write(Buffer.from(array));
}

function handshake(context, callback) {
    context.progress = 'handshake';
    context.socket.once('data', function(chunk) {
        const data = Buffer.from(chunk, 'binary');
        if (data.length == 2 && data[0] == 5 && data[1] == 0) {
            console.log('socks5 handshake success.');
            request(context, callback);
        } else {
            callback(new Error('Socks5 handshake failed'));
        }
    });
    context.socket.write(Buffer.from([5, 1, 0]));
}

/* --- Socks Finalizing --- */

function complete(context, err) {
    const callback = context.callback;
    context.callback = null;
    if (context.socket !== null) {
        const socket = context.socket;
        context.socket = null;
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        if (err) {
            socket.destroy();
            callback(err);
        } else {
            callback(null, socket);
        }
    } else if (err) {
        callback(err);
    } else {
        callback(new Error('Socks5 socket lost'));
    }
    if (context.watchdog) {
        clearTimeout(context.watchdog);
        context.watchdog = null;
    }
}

/* --- Timeout Managment --- */

function setup_timeout(context) {
    if (context.options.hasOwnProperty('timeout')) {
        context.watchdog = setTimeout(() => {
            if (context.progress !== 'connected') {
                if (context.ontimeout) {
                    context.ontimeout();
                }
                complete(context, new Error('Socks5 connect timeout'));
            }
        }, context.options.timeout);
    }
}
