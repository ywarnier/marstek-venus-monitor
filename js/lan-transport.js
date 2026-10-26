/**
 * LAN Transport
 *
 * Bridges the browser to Marstek devices on the LAN via a local UDP bridge
 * proxy (proxy/udp-bridge.js). Communication path:
 *
 *   Browser ←WebSocket→ udp-bridge.js (Node.js) ←UDP→ Marstek device
 *
 * All public methods return Promises and are safe to await.
 *
 * Message ID counter wraps at 1,000,000 — required by Venus E firmware ≥ v139.
 */

class LanTransport {
    constructor() {
        this._ws = null;
        this._pending = new Map();   // id → { resolve, reject, timeoutId }
        this._broadcastHandlers = []; // { id, handler }
        this._nextId = 1;
        this.onDisconnect = null;
        this.onBridgeError = null;
    }

    // -----------------------------------------------------------------------
    // Connection management
    // -----------------------------------------------------------------------

    /**
     * Connect to the local UDP bridge proxy.
     * @param {string} proxyUrl  e.g. "ws://localhost:3001"
     */
    connect(proxyUrl) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(proxyUrl);

            const onOpenTimeout = setTimeout(() => {
                ws.close();
                reject(new Error(`Connection to bridge timed out (${proxyUrl})`));
            }, 5000);

            ws.onopen = () => {
                clearTimeout(onOpenTimeout);
                this._ws = ws;
                resolve();
            };

            ws.onerror = () => {
                clearTimeout(onOpenTimeout);
                reject(new Error(
                    `Cannot reach UDP bridge at ${proxyUrl}.\n` +
                    `Run:  cd proxy && npm install && node udp-bridge.js`
                ));
            };

            ws.onmessage = (evt) => {
                let msg;
                try { msg = JSON.parse(evt.data); } catch { return; }
                this._dispatch(msg);
            };

            ws.onclose = () => {
                this._ws = null;
                this._rejectAll('Bridge disconnected');
                if (this.onDisconnect) this.onDisconnect();
            };
        });
    }

    disconnect() {
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }
    }

    get connected() {
        return !!(this._ws && this._ws.readyState === WebSocket.OPEN);
    }

    // -----------------------------------------------------------------------
    // Unicast command
    // -----------------------------------------------------------------------

    /**
     * Send a single JSON-RPC request to a specific device and wait for its reply.
     * @param {string} host        Device IP address
     * @param {number} port        UDP port (default 30000)
     * @param {string} method      e.g. "ES.GetStatus"
     * @param {object} params      Merged into { id: 0, ...params }
     * @param {number} timeoutMs
     */
    sendCommand(host, port, method, params = {}, timeoutMs = 15000) {
        if (!this.connected) return Promise.reject(new Error('Not connected to UDP bridge'));

        const id = this._nextId;
        this._nextId = (this._nextId + 1) % 1_000_000 || 1;

        const request = { id, method, params: { id: 0, ...params } };

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error(`Timeout waiting for ${method} reply from ${host}`));
            }, timeoutMs);

            this._pending.set(id, { resolve, reject, timeoutId });
            this._send({ host, port, request });
        });
    }

    // -----------------------------------------------------------------------
    // Broadcast discovery
    // -----------------------------------------------------------------------

    /**
     * Broadcast Marstek.GetDevice and collect responses for `listenMs`.
     * @param {number} port       UDP port to broadcast on (default 30000)
     * @param {number} listenMs   How long to collect replies (default 3000)
     * @returns {Promise<Array>}  Array of result objects (one per device found)
     */
    discoverDevices(port = 30000, listenMs = 3000) {
        if (!this.connected) return Promise.reject(new Error('Not connected to UDP bridge'));

        return new Promise((resolve) => {
            const id = this._nextId;
            this._nextId = (this._nextId + 1) % 1_000_000 || 1;

            const devices = [];

            const handler = (response) => {
                if (response.result) {
                    // Attach the src name so the UI can show it
                    devices.push({ ...response.result, _src: response.src });
                }
            };

            this._broadcastHandlers.push({ id, handler });

            this._send({
                broadcast: true,
                port,
                request: { id, method: 'Marstek.GetDevice', params: { ble_mac: '0' } }
            });

            setTimeout(() => {
                this._broadcastHandlers = this._broadcastHandlers.filter(h => h.id !== id);
                resolve(devices);
            }, listenMs);
        });
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    _send(envelope) {
        this._ws.send(JSON.stringify(envelope));
    }

    _dispatch(msg) {
        // Bridge-level errors
        if (msg._bridge_error) {
            if (msg.id !== undefined) {
                const w = this._pending.get(msg.id);
                if (w) {
                    clearTimeout(w.timeoutId);
                    this._pending.delete(msg.id);
                    w.reject(new Error(msg._bridge_error));
                }
            }
            if (this.onBridgeError) this.onBridgeError(msg._bridge_error);
            return;
        }

        // Broadcast responses — match by id registered in _broadcastHandlers
        if (msg.id !== undefined && !this._pending.has(msg.id)) {
            for (const { id, handler } of this._broadcastHandlers) {
                if (id === msg.id) handler(msg);
            }
            return;
        }

        // Unicast responses
        if (msg.id !== undefined) {
            const w = this._pending.get(msg.id);
            if (!w) return;
            clearTimeout(w.timeoutId);
            this._pending.delete(msg.id);
            if (msg.error) {
                w.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
            } else {
                // Attach src so callers can recover the device's self-reported name
                // (e.g. "VenusE-24215edb178f") without a second round-trip.
                w.resolve(msg.src ? { ...msg.result, _src: msg.src } : msg.result);
            }
        }
    }

    _rejectAll(reason) {
        for (const [, w] of this._pending) {
            clearTimeout(w.timeoutId);
            w.reject(new Error(reason));
        }
        this._pending.clear();
    }
}

window.lanTransport = new LanTransport();
