/**
 * LAN Monitor
 *
 * Manages a list of Marstek devices on the local network, polls them via the
 * UDP JSON-RPC local API (through lan-transport.js / udp-bridge.js), and
 * renders the results into the LAN tab of the UI.
 *
 * Public surface (called from templates/lan-commands.html):
 *   lanConnectBridge()          Connect to the local proxy
 *   lanDisconnectBridge()       Disconnect
 *   lanDiscoverDevices()        UDP broadcast scan
 *   lanAddDevice()              Add a device by IP
 *   lanRemoveDevice(ip)         Remove a device
 *   lanSelectDevice(ip)         Set the active device for single commands
 *   lanSendCommand(method)      Fire one JSON-RPC method against active device
 *   lanSetMode(mode)            ES.SetMode shortcut
 *   lanToggleAutoPoll(enabled)  Start / stop the poll loop
 */

// -----------------------------------------------------------------------
// State
// -----------------------------------------------------------------------

const LAN_DEFAULT_DEVICE_PORT = 30000;
const LAN_POLL_METHODS = ['ES.GetStatus', 'Bat.GetStatus'];
const LAN_STORAGE_KEY = 'marstek-lan-devices';

const _lanState = {
    devices: [],         // Array of { ip, port, userLabel, autoName, lastSeen, lastData }
    activeIp: null,
    pollTimer: null,
    pollIntervalMs: 5000,
    requestCounter: 0,
};

// -----------------------------------------------------------------------
// Bridge connection
// -----------------------------------------------------------------------

async function lanConnectBridge() {
    const proxyUrl = document.getElementById('lanProxyUrl')?.value?.trim() || 'ws://localhost:3001';

    _lanSetBridgeStatus('connecting', 'Connecting…');
    try {
        await window.lanTransport.connect(proxyUrl);
        _lanSetBridgeStatus('connected', `Connected to ${proxyUrl}`);
        log(`🌐 LAN bridge connected (${proxyUrl})`);

        window.lanTransport.onDisconnect = () => {
            _lanSetBridgeStatus('disconnected', 'Bridge disconnected');
            _lanStopPoll();
            log('🌐 LAN bridge disconnected');
        };
        window.lanTransport.onBridgeError = (msg) => {
            logError(`LAN bridge error: ${msg}`);
        };
    } catch (err) {
        _lanSetBridgeStatus('disconnected', err.message);
        log(`❌ LAN bridge: ${err.message}`);
    }
}

function lanDisconnectBridge() {
    _lanStopPoll();
    window.lanTransport.disconnect();
    _lanSetBridgeStatus('disconnected', 'Disconnected');
    window.uiController?.updateLanStatus(false);
}

// -----------------------------------------------------------------------
// Device management
// -----------------------------------------------------------------------

function lanAddDevice() {
    const nameInput = document.getElementById('lanDeviceName');
    const ipInput   = document.getElementById('lanDeviceIp');
    const portInput = document.getElementById('lanDevicePort');
    const userLabel = nameInput?.value?.trim() || '';
    const ip        = ipInput?.value?.trim();
    const port      = parseInt(portInput?.value || LAN_DEFAULT_DEVICE_PORT);

    if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        log('❌ LAN: Enter a valid IPv4 address');
        return;
    }
    _lanEnsureDevice(ip, port, userLabel);
    if (nameInput) nameInput.value = '';
    if (ipInput)   ipInput.value   = '';
    log(`🌐 Added LAN device ${userLabel ? `"${userLabel}" ` : ''}${ip}:${port}`);
}

function lanRemoveDevice(ip) {
    _lanState.devices = _lanState.devices.filter(d => d.ip !== ip);
    if (_lanState.activeIp === ip) _lanState.activeIp = _lanState.devices[0]?.ip || null;
    _lanSaveDevices();
    _lanRenderDeviceList();
}

function lanSelectDevice(ip) {
    _lanState.activeIp = ip;
    _lanRenderDeviceList(); // also calls _lanSyncGlobalStatus
}

async function lanDiscoverDevices() {
    if (!window.lanTransport.connected) {
        log('❌ LAN: Connect to the bridge first');
        return;
    }
    const port = parseInt(document.getElementById('lanDevicePort')?.value || LAN_DEFAULT_DEVICE_PORT);
    log(`🔍 LAN: Broadcasting discovery on port ${port}…`);
    _lanSetDiscoverBtn(true);

    try {
        const found = await window.lanTransport.discoverDevices(port, 3000);
        if (found.length === 0) {
            log('🌐 LAN: No devices found. Ensure the Local API is enabled (BLE cmd 0x28).');
        } else {
            for (const d of found) {
                const ip = d.ip || d.sta_ip;
                if (ip) {
                    const dev = _lanEnsureDevice(ip, port);
                    if (d._src) dev.autoName = d._src;
                    log(`🌐 LAN: Found ${d._src || d.device || 'device'} at ${ip} (FW v${d.ver ?? '?'})`);
                    _lanRenderDeviceList();
                }
            }
        }
    } catch (err) {
        log(`❌ LAN discovery: ${err.message}`);
    } finally {
        _lanSetDiscoverBtn(false);
    }
}

// -----------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------

async function lanSendCommand(method, params = {}) {
    const device = _lanActiveDevice();
    if (!device) { log('❌ LAN: No device selected'); return null; }
    if (!window.lanTransport.connected) { log('❌ LAN: Bridge not connected'); return null; }

    log(`📤 LAN → ${device.ip}  ${method}`);
    try {
        const result = await window.lanTransport.sendCommand(device.ip, device.port, method, params);
        device.lastSeen = Date.now();
        _lanMergeData(device, method, result);
        _lanRenderData(device);
        _lanRenderDeviceList();
        log(`📥 LAN ← ${device.ip}  ${method} OK`);
        return result;
    } catch (err) {
        log(`❌ LAN ${method}: ${err.message}`);
        return null;
    }
}

async function lanGetFullStatus() {
    const device = _lanActiveDevice();
    if (!device) { log('❌ LAN: No device selected'); return; }
    if (!window.lanTransport.connected) { log('❌ LAN: Bridge not connected'); return; }

    log(`📤 LAN → ${device.ip}  full status`);
    const methods = ['ES.GetStatus', 'Bat.GetStatus', 'PV.GetStatus', 'Wifi.GetStatus', 'BLE.GetStatus', 'Marstek.GetDevice'];
    const results = await Promise.allSettled(
        methods.map(m => window.lanTransport.sendCommand(device.ip, device.port, m))
    );
    device.lastSeen = Date.now();
    for (let i = 0; i < methods.length; i++) {
        if (results[i].status === 'fulfilled') {
            _lanMergeData(device, methods[i], results[i].value);
        }
    }
    _lanRenderData(device);
    _lanRenderDeviceList();
    log(`📥 LAN ← ${device.ip}  full status OK`);
}

async function lanSetMode(mode) {
    const result = await lanSendCommand('ES.SetMode', { id: 0, config: mode });
    if (result) log(`🌐 LAN: Mode set to ${mode}`);
}

// -----------------------------------------------------------------------
// Auto-poll
// -----------------------------------------------------------------------

function lanToggleAutoPoll(enabled) {
    if (enabled) {
        const secs = parseInt(document.getElementById('lanPollInterval')?.value || 5);
        _lanState.pollIntervalMs = Math.max(1, secs) * 1000;
        _lanStartPoll();
    } else {
        _lanStopPoll();
    }
}

function _lanStartPoll() {
    _lanStopPoll();
    _lanState.pollTimer = setInterval(_lanPollTick, _lanState.pollIntervalMs);
    log(`🌐 LAN auto-poll started (${_lanState.pollIntervalMs / 1000}s interval)`);
}

function _lanStopPoll() {
    if (_lanState.pollTimer) {
        clearInterval(_lanState.pollTimer);
        _lanState.pollTimer = null;
    }
}

async function _lanPollTick() {
    const device = _lanActiveDevice();
    if (!device || !window.lanTransport.connected) return;

    for (const method of LAN_POLL_METHODS) {
        try {
            const result = await window.lanTransport.sendCommand(device.ip, device.port, method);
            device.lastSeen = Date.now();
            _lanMergeData(device, method, result);
        } catch {
            // Errors logged by sendCommand already; keep polling.
        }
    }
    _lanRenderData(device);
    _lanRenderDeviceList();
}

// -----------------------------------------------------------------------
// Data helpers
// -----------------------------------------------------------------------

function _lanEnsureDevice(ip, port = LAN_DEFAULT_DEVICE_PORT, userLabel = '') {
    const existing = _lanState.devices.find(d => d.ip === ip);
    if (existing) {
        if (userLabel) { existing.userLabel = userLabel; _lanSaveDevices(); }
        return existing;
    }
    const device = { ip, port, userLabel, autoName: '', lastSeen: null, lastData: {} };
    _lanState.devices.push(device);
    if (!_lanState.activeIp) _lanState.activeIp = ip;
    _lanSaveDevices();
    _lanRenderDeviceList();
    return device;
}

function _lanDisplayName(device) {
    return device.userLabel || device.autoName || device.ip;
}

function _lanSaveDevices() {
    try {
        const saved = _lanState.devices.map(d => ({ ip: d.ip, port: d.port, userLabel: d.userLabel || '' }));
        localStorage.setItem(LAN_STORAGE_KEY, JSON.stringify(saved));
    } catch {}
}

function _lanLoadDevices() {
    try {
        const saved = JSON.parse(localStorage.getItem(LAN_STORAGE_KEY) || '[]');
        for (const d of saved) {
            if (d.ip) _lanEnsureDevice(d.ip, d.port || LAN_DEFAULT_DEVICE_PORT, d.userLabel || '');
        }
    } catch {}
}

function _lanActiveDevice() {
    return _lanState.devices.find(d => d.ip === _lanState.activeIp) || _lanState.devices[0] || null;
}

function _lanMergeData(device, method, result) {
    if (!result) return;
    device.lastData[method] = result;
    // Keep the device's self-reported name (e.g. "VenusE-24215edb178f") as autoName.
    // Never overwrite a userLabel the user explicitly set.
    if (result._src) device.autoName = result._src;
}

// -----------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------

function _lanSyncGlobalStatus() {
    if (!window.uiController?.updateLanStatus) return;
    const active = _lanActiveDevice();
    if (active) {
        window.uiController.updateLanStatus(true, _lanDisplayName(active));
    } else {
        window.uiController.updateLanStatus(false);
    }
}

function _lanSetBridgeStatus(state, text) {
    const el = document.getElementById('lanBridgeStatus');
    if (!el) return;
    el.className = `lan-bridge-status lan-status-${state}`;
    el.textContent = text;
}

function _lanSetDiscoverBtn(busy) {
    const btn = document.getElementById('lanDiscoverBtn');
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? '🔍 Scanning…' : '🔍 Discover';
}

function _lanRenderDeviceList() {
    _lanSyncGlobalStatus();
    const container = document.getElementById('lanDeviceList');
    if (!container) return;

    if (_lanState.devices.length === 0) {
        container.innerHTML = '<p class="lan-hint">No devices yet. Add an IP or use Discover.</p>';
        return;
    }

    container.innerHTML = _lanState.devices.map(d => {
        const active = d.ip === _lanState.activeIp;
        const age = d.lastSeen ? Math.round((Date.now() - d.lastSeen) / 1000) : null;
        const ageText = age === null ? 'never polled' : `${age}s ago`;
        const soc = d.lastData['ES.GetStatus']?.bat_soc ?? d.lastData['Bat.GetStatus']?.soc ?? '—';
        const power = d.lastData['ES.GetStatus']?.bat_power;
        const powerText = power !== undefined ? ` · ${power > 0 ? '+' : ''}${power} W` : '';
        const displayName = _lanDisplayName(d);
        const subName = d.userLabel && d.autoName ? `<span class="lan-device-autoname">${d.autoName}</span>` : '';
        return `
<div class="lan-device-card ${active ? 'lan-device-active' : ''}" onclick="lanSelectDevice('${d.ip}')">
  <div class="lan-device-header">
    <span class="lan-device-name">${displayName}${subName}</span>
    <button class="lan-remove-btn" onclick="event.stopPropagation(); lanRemoveDevice('${d.ip}')" title="Remove">✕</button>
  </div>
  <div class="lan-device-detail">${d.ip}:${d.port} · SOC: <strong>${soc}%</strong>${powerText} · ${ageText}</div>
</div>`;
    }).join('');
}

function _lanRenderData(device) {
    const container = document.getElementById('lanDataDisplay');
    if (!container) return;
    if (!device) { container.innerHTML = ''; return; }

    const es  = device.lastData['ES.GetStatus'];
    const bat = device.lastData['Bat.GetStatus'];
    const pv  = device.lastData['PV.GetStatus'];
    const wifi = device.lastData['Wifi.GetStatus'];
    const ble  = device.lastData['BLE.GetStatus'];
    const dev  = device.lastData['Marstek.GetDevice'];
    const mode = device.lastData['ES.GetMode'];

    let html = `<h3>📊 ${_lanDisplayName(device)}</h3>`;

    if (es) {
        const batPower = es.bat_power ?? 0;
        const batArrow = batPower > 0 ? '⬆ charging' : batPower < 0 ? '⬇ discharging' : '— idle';
        html += `
<h4>⚡ Energy System</h4>
<div class="data-grid">
  <div><strong>SOC:</strong> ${es.bat_soc ?? '—'} %</div>
  <div><strong>Capacity:</strong> ${es.bat_cap != null ? (es.bat_cap / 1000).toFixed(1) : '—'} kWh</div>
  <div><strong>Battery:</strong> ${batPower} W (${batArrow})</div>
  <div><strong>Grid:</strong> ${es.ongrid_power ?? '—'} W</div>
  <div><strong>Off-grid:</strong> ${es.offgrid_power ?? '—'} W</div>
  <div><strong>Solar:</strong> ${es.pv_power ?? '—'} W</div>
  <div><strong>Total solar:</strong> ${es.total_pv_energy != null ? (es.total_pv_energy / 1000).toFixed(2) : '—'} kWh</div>
  <div><strong>Total grid in:</strong> ${es.total_grid_input_energy != null ? (es.total_grid_input_energy / 1000).toFixed(2) : '—'} kWh</div>
  <div><strong>Total grid out:</strong> ${es.total_grid_output_energy != null ? (es.total_grid_output_energy / 1000).toFixed(2) : '—'} kWh</div>
  <div><strong>Total load:</strong> ${es.total_load_energy != null ? (es.total_load_energy / 1000).toFixed(2) : '—'} kWh</div>
</div>`;
    }

    if (bat) {
        html += `
<h4>🔋 Battery</h4>
<div class="data-grid">
  <div><strong>SOC:</strong> ${bat.soc ?? '—'} %</div>
  <div><strong>Temperature:</strong> ${bat.bat_temp ?? '—'} °C</div>
  <div><strong>Remaining:</strong> ${bat.bat_capacity != null ? (bat.bat_capacity / 1000).toFixed(2) : '—'} kWh</div>
  <div><strong>Rated:</strong> ${bat.rated_capacity != null ? (bat.rated_capacity / 1000).toFixed(2) : '—'} kWh</div>
  <div><strong>Charge allowed:</strong> ${bat.charg_flag === true ? '✅ Yes' : bat.charg_flag === false ? '❌ No' : '—'}</div>
  <div><strong>Discharge allowed:</strong> ${bat.dischrg_flag === true ? '✅ Yes' : bat.dischrg_flag === false ? '❌ No' : '—'}</div>
</div>`;
    }

    if (pv) {
        const pvEntries = [1, 2, 3, 4]
            .map(n => ({ n, p: pv[`pv${n}_power`], v: pv[`pv${n}_voltage`], a: pv[`pv${n}_current`], s: pv[`pv${n}_state`] }))
            .filter(x => x.p !== undefined);
        if (pvEntries.length > 0) {
            html += `<h4>☀️ Photovoltaic</h4><div class="data-grid">`;
            for (const x of pvEntries) {
                html += `<div><strong>PV${x.n}:</strong> ${x.p} W · ${x.v} V · ${x.a} A · ${x.s ? '⚡ Working' : '💤 Standby'}</div>`;
            }
            html += `</div>`;
        }
    }

    if (mode) {
        html += `
<h4>⚙️ Operating Mode</h4>
<div class="data-grid">
  <div><strong>Mode:</strong> ${mode.config ?? JSON.stringify(mode)}</div>
</div>`;
    }

    if (wifi) {
        html += `
<h4>📶 WiFi</h4>
<div class="data-grid">
  <div><strong>SSID:</strong> ${wifi.ssid ?? '—'}</div>
  <div><strong>IP:</strong> ${wifi.sta_ip ?? '—'}</div>
  <div><strong>RSSI:</strong> ${wifi.rssi ?? '—'} dBm</div>
  <div><strong>Gateway:</strong> ${wifi.sta_gate ?? '—'}</div>
  <div><strong>DNS:</strong> ${wifi.sta_dns ?? '—'}</div>
  <div><strong>MAC:</strong> ${wifi.wifi_mac ?? '—'}</div>
</div>`;
    }

    if (ble) {
        html += `
<h4>📡 BLE</h4>
<div class="data-grid">
  <div><strong>State:</strong> ${ble.state ?? '—'}</div>
  <div><strong>MAC:</strong> ${ble.ble_mac ?? '—'}</div>
</div>`;
    }

    if (dev) {
        html += `
<h4>ℹ️ Device</h4>
<div class="data-grid">
  ${device.userLabel ? `<div><strong>Label:</strong> ${device.userLabel}</div>` : ''}
  ${device.autoName  ? `<div><strong>Device name:</strong> ${device.autoName}</div>` : ''}
  <div><strong>Model:</strong> ${dev.device ?? '—'}</div>
  <div><strong>Firmware:</strong> v${dev.ver ?? '?'}</div>
  <div><strong>BLE MAC:</strong> ${dev.ble_mac ?? '—'}</div>
  <div><strong>WiFi MAC:</strong> ${dev.wifi_mac ?? '—'}</div>
  <div><strong>WiFi:</strong> ${dev.wifi_name ?? '—'}</div>
  <div><strong>IP:</strong> ${dev.ip ?? '—'}</div>
</div>`;
    }

    if (!es && !bat && !pv && !wifi && !ble && !dev) {
        html += '<p class="lan-hint">No data yet — run a command above.</p>';
    }

    container.innerHTML = html;
}

// Restore persisted devices on load, then re-render whenever the LAN tab opens.
_lanLoadDevices();

function lanInitTab() {
    _lanRenderDeviceList(); // also calls _lanSyncGlobalStatus
    const active = _lanActiveDevice();
    if (active && Object.keys(active.lastData).length) _lanRenderData(active);
}

// -----------------------------------------------------------------------
// BLE command → LAN fallback
//
// When a BLE command is triggered but BLE is not connected, these handlers
// attempt to answer it via the LAN Open API instead.  The result is rendered
// into #dataDisplay (the same element used by BLE responses) so the rest of
// the UI does not need to know which transport was used.
//
// Priority rule enforced by ble-protocol.js: BLE is always tried first; this
// path is only reached when server?.connected is false.
// -----------------------------------------------------------------------

function _lanHtml(title, rows) {
    const cells = rows
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `<div><strong>${k}:</strong> ${v}</div>`)
        .join('');
    return `<h3>${title} <small style="font-weight:400;font-size:12px;color:#888">(via LAN API)</small></h3><div class="data-grid">${cells}</div>`;
}

const _lanFallbackMap = {
    // Runtime Info  ↔  ES.GetStatus
    0x03: async (dev) => {
        const es = await window.lanTransport.sendCommand(dev.ip, dev.port, 'ES.GetStatus');
        _lanMergeData(dev, 'ES.GetStatus', es);
        const bat = es.bat_power ?? 0;
        return _lanHtml('⚡ Energy System Status', [
            ['Battery SOC',       `${es.bat_soc ?? '—'} %`],
            ['Battery capacity',  es.bat_cap != null ? `${(es.bat_cap/1000).toFixed(1)} kWh` : undefined],
            ['Battery power',     `${bat} W (${bat > 0 ? 'charging' : bat < 0 ? 'discharging' : 'idle'})`],
            ['Grid power',        `${es.ongrid_power ?? '—'} W`],
            ['Off-grid power',    `${es.offgrid_power ?? '—'} W`],
            ['Solar power',       `${es.pv_power ?? '—'} W`],
            ['Total solar',       es.total_pv_energy != null ? `${(es.total_pv_energy/1000).toFixed(2)} kWh` : undefined],
            ['Total grid in',     es.total_grid_input_energy != null ? `${(es.total_grid_input_energy/1000).toFixed(2)} kWh` : undefined],
            ['Total grid out',    es.total_grid_output_energy != null ? `${(es.total_grid_output_energy/1000).toFixed(2)} kWh` : undefined],
            ['Total load',        es.total_load_energy != null ? `${(es.total_load_energy/1000).toFixed(2)} kWh` : undefined],
        ]);
    },

    // Device Info  ↔  Marstek.GetDevice
    0x04: async (dev) => {
        const d = await window.lanTransport.sendCommand(dev.ip, dev.port, 'Marstek.GetDevice', { ble_mac: '0' });
        _lanMergeData(dev, 'Marstek.GetDevice', d);
        return _lanHtml('📱 Device Info', [
            ['Device name',    d._src ?? '—'],
            ['Model',          d.device ?? '—'],
            ['Firmware',       d.ver != null ? `v${d.ver}` : undefined],
            ['BLE MAC',        d.ble_mac ?? '—'],
            ['WiFi MAC',       d.wifi_mac ?? '—'],
            ['WiFi network',   d.wifi_name ?? '—'],
            ['IP address',     d.ip ?? '—'],
        ]);
    },

    // WiFi Info  ↔  Wifi.GetStatus
    0x08: async (dev) => {
        const w = await window.lanTransport.sendCommand(dev.ip, dev.port, 'Wifi.GetStatus');
        _lanMergeData(dev, 'Wifi.GetStatus', w);
        return _lanHtml('📶 WiFi Info', [
            ['SSID',       w.ssid ?? '—'],
            ['IP',         w.sta_ip ?? '—'],
            ['Gateway',    w.sta_gate ?? '—'],
            ['Subnet',     w.sta_mask ?? '—'],
            ['DNS',        w.sta_dns ?? '—'],
            ['RSSI',       w.rssi != null ? `${w.rssi} dBm` : undefined],
            ['WiFi MAC',   w.wifi_mac ?? '—'],
        ]);
    },

    // Settings Info  ↔  ES.GetStatus + ES.GetMode
    0x0A: async (dev) => {
        const [esR, modeR] = await Promise.allSettled([
            window.lanTransport.sendCommand(dev.ip, dev.port, 'ES.GetStatus'),
            window.lanTransport.sendCommand(dev.ip, dev.port, 'ES.GetMode'),
        ]);
        const es   = esR.status   === 'fulfilled' ? esR.value   : null;
        const mode = modeR.status === 'fulfilled' ? modeR.value : null;
        if (es)   _lanMergeData(dev, 'ES.GetStatus', es);
        if (mode) _lanMergeData(dev, 'ES.GetMode',   mode);
        return _lanHtml('⚙️ Settings Info', [
            ['Operating mode',   mode?.config ?? '—'],
            ['Battery SOC',      es?.bat_soc != null ? `${es.bat_soc} %` : undefined],
            ['Battery capacity', es?.bat_cap != null ? `${(es.bat_cap/1000).toFixed(1)} kWh` : undefined],
            ['Solar power',      es?.pv_power != null ? `${es.pv_power} W` : undefined],
            ['Grid power',       es?.ongrid_power != null ? `${es.ongrid_power} W` : undefined],
        ]);
    },

    // BMS Data  ↔  Bat.GetStatus
    0x14: async (dev) => {
        const b = await window.lanTransport.sendCommand(dev.ip, dev.port, 'Bat.GetStatus');
        _lanMergeData(dev, 'Bat.GetStatus', b);
        return _lanHtml('🔋 Battery Status', [
            ['SOC',               `${b.soc ?? '—'} %`],
            ['Temperature',       b.bat_temp != null ? `${b.bat_temp} °C` : undefined],
            ['Remaining',         b.bat_capacity != null ? `${(b.bat_capacity/1000).toFixed(2)} kWh` : undefined],
            ['Rated capacity',    b.rated_capacity != null ? `${(b.rated_capacity/1000).toFixed(2)} kWh` : undefined],
            ['Charge allowed',    b.charg_flag === true ? '✅ Yes' : b.charg_flag === false ? '❌ No' : '—'],
            ['Discharge allowed', b.dischrg_flag === true ? '✅ Yes' : b.dischrg_flag === false ? '❌ No' : '—'],
        ]);
    },

    // Network Info  ↔  Wifi.GetStatus  (same handler as WiFi Info)
    0x24: async (dev) => {
        const w = await window.lanTransport.sendCommand(dev.ip, dev.port, 'Wifi.GetStatus');
        _lanMergeData(dev, 'Wifi.GetStatus', w);
        return _lanHtml('🔗 Network Info', [
            ['IP',        w.sta_ip ?? '—'],
            ['Gateway',   w.sta_gate ?? '—'],
            ['Subnet',    w.sta_mask ?? '—'],
            ['DNS',       w.sta_dns ?? '—'],
            ['SSID',      w.ssid ?? '—'],
            ['RSSI',      w.rssi != null ? `${w.rssi} dBm` : undefined],
        ]);
    },
};

/**
 * Try to answer a BLE command via LAN when BLE is unavailable.
 * Returns true if the command was handled (success or error), false if no
 * LAN equivalent exists for this command byte.
 * Called from ble-protocol.js when server?.connected is false.
 */
async function lanFallbackCommand(bleCommandByte) {
    if (!window.lanTransport?.connected) return false;
    const dev = _lanActiveDevice();
    if (!dev) return false;
    const handler = _lanFallbackMap[bleCommandByte];
    if (!handler) return false;

    const hex = `0x${bleCommandByte.toString(16).padStart(2, '0')}`;
    log(`🌐 LAN fallback: routing BLE cmd ${hex} → ${dev.ip}`);
    try {
        const html = await handler(dev);
        window.uiController?.displayData(html);
        _lanRenderDeviceList();
    } catch (err) {
        log(`❌ LAN fallback for ${hex} failed: ${err.message}`);
    }
    return true; // handled (even on error — don't fall through to BLE warning)
}

/**
 * LAN fallback for readDeviceIdentifiers() — returns Marstek.GetDevice info
 * since VID/GID/XID are only available over BLE.
 */
async function lanFallbackDeviceIds() {
    if (!window.lanTransport?.connected) return false;
    const dev = _lanActiveDevice();
    if (!dev) return false;

    log(`🌐 LAN fallback: Device IDs → Marstek.GetDevice on ${dev.ip}`);
    try {
        const d = await window.lanTransport.sendCommand(dev.ip, dev.port, 'Marstek.GetDevice', { ble_mac: '0' });
        _lanMergeData(dev, 'Marstek.GetDevice', d);
        const html = _lanHtml('🏷️ Device Identifiers', [
            ['Device name',  d._src ?? '—'],
            ['Model',        d.device ?? '—'],
            ['Firmware',     d.ver != null ? `v${d.ver}` : undefined],
            ['BLE MAC',      d.ble_mac ?? '—'],
            ['WiFi MAC',     d.wifi_mac ?? '—'],
            ['Note',         'VID / GID / XID are only available over BLE'],
        ]);
        window.uiController?.displayData(html);
        _lanRenderDeviceList();
    } catch (err) {
        log(`❌ LAN fallback for Device IDs failed: ${err.message}`);
    }
    return true;
}

// Expose all public functions globally
Object.assign(window, {
    lanInitTab,
    lanFallbackCommand,
    lanFallbackDeviceIds,
    lanConnectBridge,
    lanDisconnectBridge,
    lanDiscoverDevices,
    lanAddDevice,
    lanRemoveDevice,
    lanSelectDevice,
    lanSendCommand,
    lanGetFullStatus,
    lanSetMode,
    lanToggleAutoPoll,
});
