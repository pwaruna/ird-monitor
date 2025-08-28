// server.js
// RX8200 / RX8000 IRD Monitor backend
// - Polls SNMP OIDs (Signal, C/N, Link Margin, Lock) and formats values
// - Listens for SNMP traps (v1/v2c) with proper community handling
// - Serves static frontend and broadcasts updates via WebSocket
//
// ENV:
//   PORT=8080                # HTTP port
//   HOST=0.0.0.0
//   POLL_INTERVAL=10         # seconds
//   TRAP_PORT=1162           # use 162 if running as root/cap_net_bind_service
//   READ_COMMUNITY=public
//   USE_FAKE=false
//   TRAP_DISABLE_AUTH=true   # accept any v1/v2c trap community (recommended)
//   TRAP_COMMUNITIES=public  # if TRAP_DISABLE_AUTH=false, allow these (comma-separated)

import fs from "fs";
import http from "http";
import path from "path";
import url from "url";
import express from "express";
import dotenv from "dotenv";
import snmpPkg from "net-snmp";
import { WebSocketServer } from "ws";

dotenv.config();

// net-snmp ESM/CJS interop
const snmp = snmpPkg.default ?? snmpPkg;

// __dirname with ESM
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// ----------------- Config & ENV -----------------
const CFG_PATH = path.resolve(__dirname, "config", "devices.json");
if (!fs.existsSync(CFG_PATH)) {
  console.error(`Missing config file: ${CFG_PATH}`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
const devices = cfg.devices || [];
const CLEAR_TRAP_OIDS = cfg.clearTrapOids || [];

const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL || "10", 10) * 1000;
const TRAP_PORT = parseInt(process.env.TRAP_PORT || "1162", 10);
const DEFAULT_COMMUNITY = process.env.READ_COMMUNITY || "public";
const USE_FAKE = (process.env.USE_FAKE || "false").toLowerCase() === "true";
const TRAP_DISABLE_AUTH = (process.env.TRAP_DISABLE_AUTH || "true").toLowerCase() === "true";
const TRAP_COMMUNITIES = (process.env.TRAP_COMMUNITIES || "public")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ----------------- Helpers -----------------
function vbToText(vb) {
  if (!vb || snmp.isVarbindError(vb)) return null;
  const v = vb.value;
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return String(v);
}

function alarmText(d) {
  const label = d?.lastTrap?.label && String(d.lastTrap.label).trim();
  const oid = d?.lastTrap?.trapOid && String(d.lastTrap.trapOid).trim();
  const right = label || oid || '';
  return `${d.alarm ? 'ALARM' : 'OK'}${right ? ' · ' + right : ''}`;
}


// Extract first number (supports "+07.5 dB", "12.70 dB", etc.)
function extractNumber(x) {
  const m = String(x ?? "").match(/([+-]?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}

// Keep original units but normalize spacing & precision
function fmtCn(x) {
  const n = typeof x === "number" ? x : extractNumber(x);
  if (!Number.isFinite(n)) return x == null ? null : String(x);
  return `${n.toFixed(1)} dB`;
}
function fmtMargin(x) {
  const n = typeof x === "number" ? x : extractNumber(x);
  if (!Number.isFinite(n)) return x == null ? null : String(x);
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)} dB`;
}

// ----------------- State -----------------
/**
 * Per-device state shape:
 * {
 *   id, host, webGui,
 *   signal, cn, margin,
 *   alarm, updatedAt,
 *   lastTrap: { when, trapOid, label, from, community },
 *   activeTraps: Set<string>     // trap OIDs currently active (best-effort)
 * }
 */
const state = new Map();
for (const d of devices) {
  state.set(d.id, {
    id: d.id,
    host: d.host,
    webGui: d.webGui,
    signal: null,
    cn: null,
    margin: null,
    alarm: false,
    updatedAt: null,
    lastTrap: null,
    activeTraps: new Set()
  });
}

// ----------------- HTTP & WS -----------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", (_req, res) => {
  res.json(Array.from(state.values()).map(s => ({
    ...s,
    activeTraps: Array.from(s.activeTraps)
  })));
});

// Manual tester to flip alarm (doesn't affect activeTraps)
app.post("/api/simulateTrap/:id", (req, res) => {
  const id = req.params.id;
  const dev = state.get(id);
  if (!dev) return res.status(404).json({ error: "Unknown device" });
  const on = (req.query.state || "on") === "on";
  dev.alarm = on;
  dev.lastTrap = { when: Date.now(), trapOid: "simulated", from: "local", label: "simulated", community: "-" };
  broadcast({ type: "alarm", id, alarm: dev.alarm, lastTrap: dev.lastTrap });
  res.json({ ok: true, id, alarm: dev.alarm });
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });
function wsSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}
wss.on("connection", (ws) => {
  wsSend(ws, { type: "snapshot", devices: Array.from(state.values()).map(s => ({
    ...s,
    activeTraps: Array.from(s.activeTraps)
  })) });
});

// ----------------- SNMP sessions (poll) -----------------
const snmpSessions = new Map();
function makeSession(host, community, port = 161) {
  const options = { port, version: snmp.Version2c, timeout: 2000, retries: 1 };
  return snmp.createSession(host, community, options);
}
function closeAllSessions() {
  for (const s of snmpSessions.values()) { try { s.close(); } catch {} }
  snmpSessions.clear();
}
process.on("SIGINT", () => { closeAllSessions(); process.exit(0); });
process.on("SIGTERM", () => { closeAllSessions(); process.exit(0); });

async function pollOnce() {
  if (USE_FAKE) {
    for (const d of devices) {
      const s = state.get(d.id);
      const now = Date.now();
      const cn = 10 + Math.random() * 6;       // 10..16
      const mg = 2 + Math.random() * 4;        // 2..6
      s.signal = (60 + Math.random() * 20).toFixed(1);
      s.cn = fmtCn(cn);
      s.margin = fmtMargin(mg);
      // keep alarm sticky if any activeTraps
      const trapOn = s.activeTraps.size > 0;
      s.alarm = trapOn || false;
      s.updatedAt = now;
      broadcast({ type: "update", id: d.id, signal: s.signal, cn: s.cn, margin: s.margin, alarm: s.alarm, updatedAt: now });
    }
    return;
  }

  await Promise.all(devices.map(d => new Promise((resolve) => {
    const s = state.get(d.id);
    const reqOids = [
      d.oids?.signal,
      d.oids?.cn,
      d.oids?.margin,
      d.oids?.lock // scalar: 30=LOCKED OK, else alarm
    ].filter(Boolean);

    if (reqOids.length === 0) return resolve();

    let session = snmpSessions.get(d.id);
    if (!session) {
      session = makeSession(d.host, d.community || DEFAULT_COMMUNITY, d.port || 161);
      snmpSessions.set(d.id, session);
    }

    session.get(reqOids, (err, vbs) => {
      const now = Date.now();
      if (err) {
        console.error(`[${d.id}] SNMP GET error:`, err.toString());
        return resolve();
      }

      // Map varbinds by index (only those requested)
      let vbIdx = 0;
      const rawSignal = d.oids?.signal ? vbToText(vbs[vbIdx++]) : null;
      const rawCn     = d.oids?.cn     ? vbToText(vbs[vbIdx++]) : null;
      const rawMargin = d.oids?.margin ? vbToText(vbs[vbIdx++]) : null;
      const rawLock   = d.oids?.lock   ? vbToText(vbs[vbIdx++]) : null;

      if (rawSignal != null) s.signal = rawSignal;            // leave units as-is if any
      if (rawCn     != null) s.cn     = fmtCn(rawCn);         // "12.7 dB"
      if (rawMargin != null) s.margin = fmtMargin(rawMargin); // "+7.5 dB"

      // Polled alarm from lock code (if present)
      let polledAlarm = null;
      if (rawLock != null) {
        const code = parseInt(String(rawLock).trim(), 10);
        if (!Number.isNaN(code)) polledAlarm = (code !== 30); // 30=LOCKED (OK)
      }

      // Reconcile with traps (activeTraps set)
      const trapAlarm = s.activeTraps.size > 0;
      s.alarm = Boolean(trapAlarm || polledAlarm);

      s.updatedAt = now;
      broadcast({
        type: "update",
        id: d.id,
        signal: s.signal,
        cn: s.cn,
        margin: s.margin,
        alarm: s.alarm,
        updatedAt: now
      });
      resolve();
    });
  })));
}

setInterval(pollOnce, POLL_INTERVAL_MS);
pollOnce();

// ----------------- SNMP Trap receiver -----------------
let trapReceiver = null;

/**
 * Handle a notification from net-snmp createReceiver callback.
 * Shape: { pdu, rinfo, version, community?, user? }
 */
function handleIncomingTrap(notification) {
  try {
    const { pdu, rinfo, community } = notification || {};
    const src = rinfo?.address;
    const vbs = pdu?.varbinds || [];

    // Find device by src IP
    const dev = devices.find(d => d.host === src);
    if (!dev) {
      console.log(`Trap from unknown source ${src || "?"}`);
      return;
    }
    const s = state.get(dev.id);

    // snmpTrapOID.0
    const trapOid = vbToText(vbs.find(v => v.oid === "1.3.6.1.6.3.1.1.4.1.0"));
    // A human label appears in RX8000 traps here (e.g. "No TS Lock") per your tcpdump:
    // 1.3.6.1.4.1.1773.1.1.9.1.8
    const label = vbToText(vbs.find(v => v.oid === "1.3.6.1.4.1.1773.1.1.9.1.8")) || "";

    // Treat trapOid as "raise" unless explicitly configured as a clear OID
    if (trapOid && CLEAR_TRAP_OIDS.includes(trapOid)) {
      // Clear: remove any previous instance of this OID
      s.activeTraps.delete(trapOid);
    } else if (trapOid) {
      s.activeTraps.add(trapOid);
    }

    // Overall alarm = any active trap OR (will be reconciled on next poll)
    s.alarm = s.activeTraps.size > 0 ? true : s.alarm;

    s.lastTrap = {
      when: Date.now(),
      trapOid,
      label,
      from: src,
      community: community || "-"
    };

    broadcast({
      type: "alarm",
      id: dev.id,
      alarm: s.alarm,
      lastTrap: s.lastTrap
    });

    console.log(`[${dev.id}] Trap ${trapOid || ""} ${label ? `"${label}" ` : ""}from ${src}`);
  } catch (e) {
    console.error("Trap handler error:", e);
  }
}

function startTrapListener() {
  try {
    const options = {
      port: TRAP_PORT,
      transport: "udp4",
      includeAuthentication: true,
      disableAuthorization: TRAP_DISABLE_AUTH
    };

    const receiver = snmp.createReceiver(options, (error, notification) => {
      if (error) {
        console.error("Trap error:", error);
        return;
      }
      handleIncomingTrap(notification);
    });

    trapReceiver = receiver;

    // If we keep authorization enabled, allow configured communities
    if (!TRAP_DISABLE_AUTH && typeof receiver.getAuthorizer === "function") {
      const auth = receiver.getAuthorizer();
      for (const c of TRAP_COMMUNITIES) auth.addCommunity(c);
      console.log(`Trap receiver on udp/${TRAP_PORT}; communities allowed: ${TRAP_COMMUNITIES.join(", ")}`);
    } else {
      console.log(`Trap receiver on udp/${TRAP_PORT}; authorization ${TRAP_DISABLE_AUTH ? "disabled" : "enabled"}`);
    }

    if (typeof receiver.on === "function") {
      receiver.on("error", (e) => console.error("Trap socket error:", e));
    }
  } catch (e) {
    console.error("Failed to start trap receiver (non-fatal):", e);
  }
}

startTrapListener();

// ----------------- Start HTTP server -----------------
server.listen(PORT, HOST, () => {
  console.log(`IRD Monitor backend running on http://${HOST}:${PORT}`);
  console.log(`WebSocket path: ws://<host>:${PORT}/ws`);
  console.log(`Trap port: udp/${TRAP_PORT} (${USE_FAKE ? "FAKE mode" : "SNMP mode"})`);
});
