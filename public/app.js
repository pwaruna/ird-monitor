// app.js
const grid = document.getElementById('grid');
const cards = new Map(); // id -> HTMLElement

function normalizeDbLike(val, showPlus = false) {
  if (val == null) return '-';
  if (typeof val === 'number') {
    const n = val;
    return (showPlus && n >= 0 ? '+' : '') + n.toFixed(1) + ' dB';
  }
  const s = String(val);
  // If units already present, show as-is (clean up "  dB" spacing)
  if (/dB/i.test(s)) return s.replace(/\s+dB/i, ' dB');
  // Otherwise try to parse a number and append unit
  const m = s.match(/([+-]?\d+(?:\.\d+)?)/);
  if (m) {
    const n = parseFloat(m[1]);
    return (showPlus && n >= 0 ? '+' : '') + n.toFixed(1) + ' dB';
  }
  return s;
}

function cardTemplate(d) {
  return `
    <div class="card" data-id="${d.id}">
      <div class="title">
        <h2>${d.id} <span style="font-weight:400;color:#9ca3af;font-size:12px">(${d.host})</span></h2>
        <a class="alarm ${d.alarm ? 'bad' : 'ok'}" href="${d.webGui || '#'}" target="_blank" rel="noopener">
          <span class="dot"></span> ${d.alarm ? 'ALARM' : 'OK'}${d.lastTrap?.trapOid ? ' · '+d.lastTrap.trapOid : ''}
        </a>
      </div>
      <div class="kv">
        <div class="box">
          <div class="label">Signal</div>
          <div class="val" data-k="signal">${d.signal ?? '-'}</div>
        </div>
        <div class="box">
          <div class="label">C/N</div>
          <div class="val" data-k="cn">${normalizeDbLike(d.cn)}</div>
        </div>
        <div class="box">
          <div class="label">Link Margin</div>
          <div class="val" data-k="margin">${normalizeDbLike(d.margin, true)}</div>
        </div>
      </div>
    </div>
  `;
}

function upsertCard(d) {
  let el = cards.get(d.id);
  if (!el) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = cardTemplate(d);
    el = wrapper.firstElementChild;
    cards.set(d.id, el);
    grid.appendChild(el);
    sortGrid();
  }

  // Update values
  if (d.signal !== undefined)
    el.querySelector('[data-k="signal"]').textContent = d.signal;

  if (d.cn !== undefined)
    el.querySelector('[data-k="cn"]').textContent = normalizeDbLike(d.cn);

  if (d.margin !== undefined)
    el.querySelector('[data-k="margin"]').textContent = normalizeDbLike(d.margin, true);

  // Update alarm chip
  const a = el.querySelector('.alarm');
  if (d.alarm !== undefined) {
    a.classList.toggle('bad', d.alarm);
    a.classList.toggle('ok', !d.alarm);
    a.firstElementChild.style.color = '';
    a.childNodes[1].textContent = d.alarm ? 'ALARM' : 'OK';
  }
  // Update href and OID summary
  if (d.webGui) a.href = d.webGui;
  if (d.lastTrap && d.lastTrap.trapOid) {
    a.innerHTML = `<span class="dot"></span> ${d.alarm ? 'ALARM' : 'OK'} · ${d.lastTrap.trapOid}`;
    a.classList.toggle('bad', d.alarm);
    a.classList.toggle('ok', !d.alarm);
  }
}

function sortGrid() {
  const nodes = Array.from(grid.children);
  nodes.sort((a,b) => {
    const A = a.getAttribute('data-id');
    const B = b.getAttribute('data-id');
    return A.localeCompare(B, undefined, { numeric: true });
  });
  nodes.forEach(n => grid.appendChild(n));
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener('open', () => console.log('WebSocket connected'));
  ws.addEventListener('close', () => {
    console.log('WebSocket closed; retrying in 2s...');
    setTimeout(connectWS, 2000);
  });
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') {
        grid.innerHTML = '';
        cards.clear();
        (msg.devices || []).forEach(upsertCard);
      } else if (msg.type === 'update') {
        upsertCard(msg);
      } else if (msg.type === 'alarm') {
        upsertCard(msg);
      }
    } catch (e) {
      console.error('WS message err:', e);
    }
  });
}
connectWS();
