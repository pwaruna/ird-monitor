# IRD Monitor (Ericsson RX8200)

Realtime dashboard for 10x IRDs with:
- SNMP GET polling of **Signal Level**, **C/N**, **Link Margin** every 10 seconds
- SNMP Trap receiver to flip the **ALARM** badge (red) and push events to clients
- WebSocket updates to a lightweight HTML dashboard (no reloads)

## Quick start
```bash
cd ird-monitor
cp .env.example .env
# Edit .env as you like
npm install
# Fill in config/devices.json with your 10 IRDs and the correct OIDs
node server.js
# open http://localhost:8080
```

> Development without equipment: set `USE_FAKE=true` in `.env` to simulate values.

## SNMP OIDs
This repo ships with placeholder OIDs. Replace the three numeric OIDs per device with the **Ericsson RX8200** MIB objects for:
- Signal Level
- C/N (Carrier-to-Noise)
- Link Margin

**Use numeric OIDs** with `net-snmp`. If you have the MIB, you can resolve names with external tools first (`snmpget -v2c -c public 192.168.x.x <MIB::object.0> -m +ER...MIB`).

Example (NOT RX8200, for illustration only):
```json
"oids": {
  "signal": "1.3.6.1.4.1.XXXX.YYYY.1.0",
  "cn":     "1.3.6.1.4.1.XXXX.YYYY.2.0",
  "margin": "1.3.6.1.4.1.XXXX.YYYY.3.0"
}
```

## SNMP Traps
The backend listens on UDP `TRAP_PORT` (default **162**). Running on a low port requires extra permission:

```bash
# Allow Node to bind to privileged port 162 (one-time):
sudo setcap 'cap_net_bind_service=+ep' $(which node)
# Verify:
getcap $(which node)
```

Then configure your RX8200s to send traps to the server's IP.
To automatically clear the red **ALARM** badge on a vendor-specific "clear" trap,
add its `snmpTrapOID.0` value to `config/devices.json > clearTrapOids`.

You can also test the UI without a real trap:
```bash
curl -XPOST 'http://localhost:8080/api/simulateTrap/IRD-1?state=on'   # turn alarm on (red)
curl -XPOST 'http://localhost:8080/api/simulateTrap/IRD-1?state=off'  # clear alarm
```

## Structure
```
ird-monitor/
  public/
    index.html   # Dashboard UI
    app.js       # WebSocket client / DOM updates
  config/
    devices.json # Devices + OIDs + optional clearTrap OIDs
  server.js      # Express + WebSocket + SNMP poll + trap
  .env.example
  package.json
```

## Scaling notes
- The backend keeps **one SNMP session per device** and polls them in parallel.
- WebSocket clients receive a **snapshot** on connect, then **update**/**alarm** diffs.
- For more IRDs, raise OS file descriptor limits and consider staggered polling.

## Security
- Place behind a reverse proxy if exposing outside your LAN.
- Prefer a separate low-privilege user to run the service.
- Use SNMPv3 if supported (this sample is v2c for simplicity).
