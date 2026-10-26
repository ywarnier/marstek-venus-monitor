#!/usr/bin/env node
/**
 * Marstek UDP Bridge
 *
 * Browsers cannot send raw UDP packets, so this Node.js proxy bridges
 * WebSocket connections from the browser to UDP communication with
 * Marstek devices on the local network.
 *
 * Usage:  node udp-bridge.js [ws-port]
 * Default WebSocket port: 3001
 *
 * Install once:  cd proxy && npm install
 * Then run:      node udp-bridge.js
 */

const WebSocket = require('ws');
const dgram = require('dgram');
const os = require('os');

const WS_PORT = parseInt(process.argv[2]) || 3001;

// -----------------------------------------------------------------------
// Network helpers
// -----------------------------------------------------------------------

function getBroadcastAddresses() {
    const addrs = new Set(['255.255.255.255']);
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces) {
            if (iface.family !== 'IPv4' || iface.internal) continue;
            const ip = iface.address.split('.').map(Number);
            const mask = iface.netmask.split('.').map(Number);
            const bcast = ip.map((b, i) => (b | (~mask[i] & 0xFF))).join('.');
            addrs.add(bcast);
        }
    }
    return [...addrs];
}

// -----------------------------------------------------------------------
// WebSocket server
// -----------------------------------------------------------------------

const wss = new WebSocket.Server({ port: WS_PORT }, () => {
    console.log(`Marstek UDP Bridge  ws://localhost:${WS_PORT}`);
    console.log('Waiting for browser connections...');
});

wss.on('error', (err) => {
    console.error('Bridge error:', err.message);
    process.exit(1);
});

wss.on('connection', (ws, req) => {
    const peer = req.socket.remoteAddress;
    console.log(`[+] Browser connected from ${peer}`);

    // One UDP socket per WebSocket connection.
    // bind(0) lets the OS pick a free ephemeral port.
    const udp = dgram.createSocket('udp4');
    udp.bind(0, () => {
        udp.setBroadcast(true);
    });

    // Pending unicast request IDs so we can clean up on close.
    const pending = new Set();

    // ---- UDP → WebSocket ----
    udp.on('message', (buf, rinfo) => {
        let parsed;
        try {
            parsed = JSON.parse(buf.toString('utf8'));
        } catch {
            // Drop malformed datagrams silently.
            return;
        }
        if (parsed.id !== undefined) pending.delete(parsed.id);
        try {
            ws.send(JSON.stringify(parsed));
        } catch {
            // WebSocket may have closed between the UDP reply and this callback.
        }
    });

    udp.on('error', (err) => {
        try { ws.send(JSON.stringify({ _bridge_error: err.message })); } catch {}
    });

    // ---- WebSocket → UDP ----
    ws.on('message', (raw) => {
        let envelope;
        try {
            envelope = JSON.parse(raw.toString());
        } catch {
            try { ws.send(JSON.stringify({ _bridge_error: 'Invalid JSON from browser' })); } catch {}
            return;
        }

        const { host, port = 30000, broadcast = false, request } = envelope;
        if (!request) return;

        const buf = Buffer.from(JSON.stringify(request));

        if (broadcast) {
            for (const addr of getBroadcastAddresses()) {
                udp.send(buf, port, addr, (err) => {
                    if (err) console.warn(`Broadcast to ${addr}:${port} failed:`, err.message);
                });
            }
        } else {
            if (!host) return;
            pending.add(request.id);
            udp.send(buf, port, host, (err) => {
                if (err) {
                    pending.delete(request.id);
                    try { ws.send(JSON.stringify({ id: request.id, _bridge_error: err.message })); } catch {}
                }
            });
        }
    });

    // ---- Cleanup ----
    ws.on('close', () => {
        console.log(`[-] Browser disconnected from ${peer}`);
        pending.clear();
        try { udp.close(); } catch {}
    });

    ws.on('error', () => {
        try { udp.close(); } catch {}
    });
});
