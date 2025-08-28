// server.js
// IRD (Ericsson RX8200) monitoring backend
// - SNMP GET poll (Signal, C/N, Link Margin)
// - SNMP Trap receiver (alarms)
// - WebSocket broadcast to frontend
// Node v23+ (ESM)

import fs from 'fs';
import http from 'http';
import path from 'path';
import url from 'url';
import express from 'express';
import dotenv from 'dotenv';
import snmpPkg from 'net-snmp';
import { WebSocketServer } from 'ws';

dotenv.config();

// ESM/CJS compatibility for net-snmp
const snmp = snmpPkg.default ?? snmpPkg;

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Load configuration
const CFG_PATH = path.join(__dirname, 'config', 'devices.json');
if (!fs.existsSync(CFG_PATH)) {
  console.error('Missing config/devices.json – please add your devices. See config/devices.json template.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const CLEAR_TRAP_OIDS = cfg.clearTrapOids || [];
const devices = cfg.devices || [];
if (devices.length === 0) {
  console.warn('No devices configured – add items to config/devices.json > devices[]');
}

// Env
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '10', 10) * 1000;
const TRAP_PORT = parseInt(process.env.TRAP_PORT || '162', 10);
const DEFAULT_COMMUNITY = process.env.READ_COMMUNITY || 'public';
const USE_FAKE = (process.env.USE_FAKE || 'false').toLowerCase() === 'true';

// ===== Helpers for value formatting =====
function vbToText(vb) {
  if (!vb || snmp.isVarbindError(vb)) return null;
  const val = vb.value;
  if (val == null) return null;
  if (Buffer.isBuffer(val)) return val.toString('utf8'); // e.g., "12.70 dB"
  return String(val);
}
function extractNumber(x) {
  const m = String(x ?? '').match(/([+-]?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}
function fmtCn(x) {
  // "12.70 dB" => "12.7 dB"; 12.7 => "12.7 dB"; preserves if cannot parse
  const n = typeof x === 'number' ? x : extractNumber(x);
  if (!Number.isFinite(n)) return x == null ? null : String(x);
  return `${n.toFixed(1)} dB`;
}
function fmtMargin(x) {
  // " +07.5 dB" => "+7.5 dB"; 7.5 => "+7.5 dB"
  const n = typeof x === 'number' ? x : extractNumber(x);
  if (!Number.isFinite(n)) return x == null ? null : String(x);
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)} dB`;
}

// State per device
const state = new Map();
for (const d of devices) {
  state.set(d.id, {
    id: d.id,
    host: d.host,
    webGui: d.webGui,
    signal: null,
    cn: null,
    margin: null,
    updatedAt: null,
    alarm: false,
    lastTrap: null
  });
}

// Express + static
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API helpers
app.get('/api/state', (_req, res) => res.json(Array.from(state.values())));
app.post('/api/simulateTrap/:id', (req, res) => {
  const id = req.params.id;
  const dev = state.get(id);
  if (!dev) return res.status(404).json({ error: 'Unknown device' });
  const on = (req.query.state || 'on') === 'on';
  dev.alarm = on;
  dev.lastTrap = { when: Date.now(), trapOid: 'simulated', varbinds: [] };
  broadcast({ type: 'alarm', id, alarm: dev.alarm, lastTrap: dev.lastTrap });
  res.json({ ok: true, id, alarm: dev.alarm });
});

const server = http.createServer(app);

// WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });
function send(ws, data) { try { ws.send(JSON.stringify(data)); } catch {} }
function broadcast(data) {
  const s = JSON.stringify(data);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}
wss.on('connection', (ws) => send(ws, { type: 'snapshot', devices: Array.from(state.values()) }));

// SNMP sessions
const snmpSessions = new Map();
function makeSession(host, community, port = 161) {
  const options = { port, version: snmp.Version2c, timeout: 2000, retries: 1 };
  return snmp.createSession(host, community, options);
}
function closeAllSessions() {
  for (const s of snmpSessions.values()) { try { s.close(); } catch {} }
  snmpSessions.clear();
}
process.on('SIGINT', () => { closeAllSessions(); process.exit(0); });
process.on('SIGTERM', () => { closeAllSessions(); process.exit(0); });

// Poll loop (or fake)
async function pollOnce() {
  if (USE_FAKE) {
    for (const d of devices) {
      const s = state.get(d.id);
      const now = Date.now();
      // Keep "signal" raw (unknown units); format C/N and Margin with dB
      const cnNum = Math.random() * 5 + 10;     // 10.0..15.0
      const mgNum = Math.random() * 3 + 2;      // 2.0..5.0
      s.signal = (Math.random() * 20 + 60).toFixed(1); // e.g., "73.4"
      s.cn     = fmtCn(cnNum);                  // "12.7 dB"
      s.margin = fmtMargin(mgNum);              // "+3.4 dB"
      s.updatedAt = now;
      broadcast({ type: 'update', id: d.id, signal: s.signal, cn: s.cn, margin: s.margin, updatedAt: now });
    }
    return;
  }

  await Promise.all(devices.map(d => new Promise((resolve) => {
    const s = state.get(d.id);
    const oids = [d.oids.signal, d.oids.cn, d.oids.margin].map(String);
    const allNumeric = oids.every(oid => /^\d+(?:\.\d+)*$/.test(oid));
    if (!allNumeric) {
      console.error(`[${d.id}] One or more OIDs are not numeric. Replace placeholders with real RX8200 OIDs, or set USE_FAKE=true.`);
      return resolve();
    }

    let session = snmpSessions.get(d.id);
    if (!session) {
      session = makeSession(d.host, d.community || DEFAULT_COMMUNITY, d.port || 161);
      snmpSessions.set(d.id, session);
    }

    session.get(oids, (err, varbinds) => {
      const now = Date.now();
      if (err) {
        console.error(`[${d.id}] SNMP GET error:`, err.toString());
      } else {
        // Get raw text (preserve units like "12.70 dB" / " +07.5 dB"), then pretty-format
        const rawSignal = vbToText(varbinds[0]); // leave as-is (unknown unit)
        const rawCn     = vbToText(varbinds[1]);
        const rawMargin = vbToText(varbinds[2]);

        if (rawSignal != null) s.signal = rawSignal;
        if (rawCn     != null) s.cn     = fmtCn(rawCn);
        if (rawMargin != null) s.margin = fmtMargin(rawMargin);

        s.updatedAt = now;
        broadcast({ type: 'update', id: d.id, signal: s.signal, cn: s.cn, margin: s.margin, updatedAt: now });
      }
      resolve();
    });
  })));
}
setInterval(pollOnce, POLL_INTERVAL);
pollOnce();

// ===== SNMP Trap receiver =====
let trap = null;

function handleIncomingTrap(msg, rinfo) {
  try {
    const src = rinfo && (rinfo.address || rinfo.rinfo?.address);
    const dev = devices.find(d => d.host === src);

    // snmpTrapOID.0
    let trapOid = null;
    const varbinds =
      (msg && msg.pdu && msg.pdu.varbinds) ? msg.pdu.varbinds :
      (msg && msg.varbinds) ? msg.varbinds : [];

    for (const vb of varbinds || []) {
      if (vb.oid === '1.3.6.1.6.3.1.1.4.1.0') {
        trapOid = (typeof vb.value === 'string') ? vb.value : String(vb.value);
      }
    }
    const isClear = trapOid ? CLEAR_TRAP_OIDS.includes(trapOid) : false;

    if (dev) {
      const entry = state.get(dev.id);
      entry.alarm = !isClear;
      entry.lastTrap = {
        when: Date.now(),
        trapOid,
        from: src,
        varbinds: (varbinds || []).map(vb => ({ oid: vb.oid, value: vb.value }))
      };
      broadcast({ type: 'alarm', id: dev.id, alarm: entry.alarm, lastTrap: entry.lastTrap });
      console.log(`[${dev.id}] Trap from ${src} ${trapOid ? `(OID ${trapOid})` : ''} -> alarm=${entry.alarm}`);
    } else {
      console.log(`Trap from unknown source ${src} ${trapOid ? `(OID ${trapOid})` : ''}`);
    }
  } catch (e) {
    console.error('Trap handler error:', e);
  }
}

function startTrapListener() {
  try {
    // 1) Preferred: classic API with explicit listen()
    if (typeof snmp.createTrapListener === 'function') {
      const t = snmp.createTrapListener();
      if (t && typeof t.on === 'function') {
        trap = t;
        trap.on('trap', (msg, rinfo) => handleIncomingTrap(msg, rinfo));
        trap.on('message', (msg, rinfo) => handleIncomingTrap(msg, rinfo));
        trap.on('error', (e) => console.error('Trap socket error:', e));
        try { trap.listen(TRAP_PORT, '0.0.0.0'); }
        catch { trap.listen({ family: 'udp4', port: TRAP_PORT }); }
        console.log(`Trap listener (createTrapListener) on udp/${TRAP_PORT}`);
        return;
      }
    }

    // 2) Alternative API: createReceiver(options, callback)
    if (typeof snmp.createReceiver === 'function') {
      const receiver = snmp.createReceiver(
        { port: TRAP_PORT, transport: 'udp4' },
        (error, msg, rinfo) => {
          if (error) { console.error('Trap error:', error); return; }
          handleIncomingTrap(msg, rinfo);
        }
      );
      if (receiver && typeof receiver.on === 'function') {
        receiver.on('error', (e) => console.error('Trap socket error:', e));
      }
      trap = receiver;
      console.log(`Trap receiver (createReceiver) active on udp/${TRAP_PORT}`);
      return;
    }

    console.warn('No trap API available in this net-snmp build; traps disabled.');
  } catch (e) {
    console.error('Failed to start trap listener (non-fatal):', e);
  }
}

startTrapListener();

// Start server
server.listen(PORT, HOST, () => {
  console.log(`IRD Monitor backend running on http://${HOST}:${PORT}`);
  console.log(`WebSocket path: ws://<host>:${PORT}/ws`);
  console.log(`Trap port: udp/${TRAP_PORT} (${USE_FAKE ? 'FAKE mode' : 'SNMP mode'})`);
});
