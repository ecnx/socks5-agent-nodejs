# socks5-agent-nodejs
Socks-5 Proxy Agent for NodeJS Apps

Example:
```
const SocksHttpAgent = require('../lib/socks-http-agent'),
    SocksHttp2Agent = require('../lib/socks-http2-agent');

const agents = {
    http: new SocksHttpAgent({
        proxy: {
            host: 'localhost',
            port: 1234
        },
        connectTimeout: 5000,
        socketTimeout: 60000
    })
    http2: new SocksHttp2Agent({
        proxy: {
            host: 'localhost',
            port: 5678
        },
        connectTimeout: 5000,
        socketTimeout: 60000
    })
};

require('http').request({ agent: agents.http ...
require('http2').request({ agent: agents.http2 ...
```
