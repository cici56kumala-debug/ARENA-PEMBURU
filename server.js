// Server Arena Pemburu: ruang per kode game, guru memegang kendali mulai/berhenti.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const PIN = process.env.PIN_GURU || 'guru123';
const server = http.createServer((q, s) => {
  if (q.url === '/health') { s.writeHead(200); return s.end('ok'); }
  s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  s.end(html);
});
const wss = new WebSocketServer({ server, maxPayload: 300000 });
const rooms = new Map(); let nextId = 0, tick = 0;
const NEAR = 1000, MAX_CLIENTS = 300, MAX_ROOMS = 20;
// Pemeriksaan data dari HP siswa: batasi lonjakan jawaban, poin, nyawa, dan teleportasi.
function vet(c, p, now) {
  const q = c.presence;
  if (typeof p.lv === 'number') p.lv = Math.max(0, Math.min(5, p.lv | 0));
  if (typeof p.hp === 'number') p.hp = Math.max(0, Math.min(100, p.hp));
  if (!q || q.r !== p.r) { c.qpA = 0; c.lvA = 0; c.qaTok = 2; c.qaT = now; c.pt = now; return; }
  const bad = () => { c.viol = (c.viol || 0) + 1; };
  c.qaTok = Math.min(2, (c.qaTok == null ? 2 : c.qaTok) + (now - (c.qaT || now)) / 2500); c.qaT = now;
  const dqa = (p.qa | 0) - (q.qa | 0);
  if (dqa > 0) {
    const ok = Math.min(dqa, Math.floor(c.qaTok)); if (ok < dqa) bad();
    c.qaTok -= ok; p.qa = (q.qa | 0) + ok;
    c.qpA = Math.min(120, (c.qpA || 0) + 60 * ok); c.lvA = Math.min(2, (c.lvA || 0) + ok);
  } else if (dqa < 0) { p.qa = q.qa | 0; bad(); }
  const dqp = (p.qp | 0) - (q.qp | 0);
  if (dqp > 0) { if (dqp > (c.qpA || 0)) { p.qp = (q.qp | 0) + (c.qpA || 0); c.qpA = 0; bad(); } else c.qpA -= dqp; }
  else if (dqp < 0) { p.qp = q.qp | 0; bad(); }
  const dlv = p.lv - (q.lv | 0);
  if (dlv > 0) { if (dlv > (c.lvA || 0)) { p.lv = (q.lv | 0) + (c.lvA || 0); c.lvA = 0; bad(); } else c.lvA -= dlv; }
  if (typeof p.x === 'number' && typeof p.y === 'number' && typeof q.x === 'number' && typeof q.y === 'number') {
    const dt = Math.max(0.04, (now - (c.pt || now)) / 1000), lim = 950 * dt + 30, d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d > lim && q.al && now >= (c.freeUntil || 0)) { const k = lim / d; p.x = Math.round(q.x + (p.x - q.x) * k); p.y = Math.round(q.y + (p.y - q.y) * k); bad(); }
  }
  c.pt = now;
}
function cleanQs(a) {
  if (!Array.isArray(a)) return [];
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  return a.slice(0, 200).map(x => {
    if (!x || !Array.isArray(x.o)) return null;
    const o = x.o.slice(0, 5).map(t => str(t, 200)).filter(Boolean), q = str(x.q, 400), a2 = x.a | 0;
    return (q && o.length >= 2 && a2 >= 0 && a2 < o.length) ? { q, o, a: a2, e: str(x.e, 600) } : null;
  }).filter(Boolean);
}
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const stMsg = rm => { const u = rm.status === 'wait' ? rm.cfg : rm.run; return { t: 'st', r: rm.r, status: rm.status, startAt: rm.startAt, pausedAt: rm.pausedAt || 0, play: u.play, goal: u.goal, now: Date.now() }; };
function mkCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (;;) { let c = ''; for (let i = 0; i < 5; i++) c += A[Math.floor(Math.random() * A.length)]; if (!rooms.has(c)) return c; }
}
function leave(c) {
  if (!c.room) return;
  c.room.peers.delete(c.id); c.room.gone.push(c.id);
  if (!c.room.peers.size) c.room.emptySince = Date.now();
  c.room = null; c.presence = null; c.teacher = false; c.seen = {};
}
function join(c, m) {
  let code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5), rm;
  const teacher = m.role === 'g';
  if (teacher) {
    if (m.pin !== PIN) return send(c.ws, { t: 'err', m: 'PIN guru salah.' });
    rm = code && rooms.get(code);
    if (!rm) {
      if (rooms.size >= MAX_ROOMS) return send(c.ws, { t: 'err', m: 'Server penuh, coba lagi nanti.' });
      code = code || mkCode();
      rm = { peers: new Map(), gone: [], r: 0, status: 'wait', startAt: 0, pausedAt: 0, emptySince: 0, stu: new Map(), qs: new Map(), qbank: null, cfg: { play: 60, goal: 50 }, run: { play: 60, goal: 50 }, fresh: true, createdAt: Date.now() }; rooms.set(code, rm);
    }
  } else {
    rm = rooms.get(code);
    if (!rm) return send(c.ws, { t: 'err', m: 'Kode game tidak ditemukan. Minta kode ke guru.' });
    if (rm.fresh && Date.now() - rm.createdAt < 2500) return send(c.ws, { t: 'err', m: 'Server sedang bersiap, coba lagi sebentar.' });
  }
  leave(c);
  c.room = rm; c.teacher = teacher; c.seen = {}; rm.peers.set(c.id, c); rm.emptySince = 0;
  send(c.ws, { t: 'ok', code, teacher, fresh: rm.fresh }); send(c.ws, stMsg(rm)); if (rm.qbank) send(c.ws, { t: 'qs', qs: rm.qbank });
}
wss.on('connection', ws => {
  if (wss.clients.size > MAX_CLIENTS) return ws.close();
  const c = { ws, id: 'p' + (++nextId), room: null, teacher: false, presence: null, ver: 0, seen: {}, last: 0 };
  send(ws, { t: 'hi', id: c.id, now: Date.now() });
  ws.on('message', d => {
    if (d.length > 8192 && !c.teacher) return;
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'join') return join(c, m);
    if (m.t === 'ping') return send(ws, c.room ? stMsg(c.room) : { t: 'hi', id: c.id, now: Date.now() });
    if (!c.room) return;
    if (m.t === 'pr') {
      const now = Date.now(); if (now - c.last < 40) return; c.last = now;
      if (m.p && typeof m.p === 'object' && JSON.stringify(m.p).length < 4000) { vet(c, m.p, now); c.presence = m.p; c.ver++; }
    } else if (m.t === 'ans' && !c.teacher) {
      const rm = c.room, now = Date.now(); if (now - (c.lastAns || 0) < 800) return; c.lastAns = now;
      const q = String(m.qt || '').slice(0, 200), n = String(m.n || '?').slice(0, 20), tm = Math.max(0, Math.min(4, m.tm | 0)), ok = m.ok ? 1 : 0;
      if (!q) return;
      const k = tm + '|' + n.toLowerCase(), st = rm.stu.get(k) || { n, tm, b: 0, s: 0 };
      if (ok) st.b++; else st.s++; rm.stu.set(k, st);
      const e = rm.qs.get(q) || { b: 0, s: 0 }; if (ok) e.b++; else e.s++; rm.qs.set(q, e);
    } else if (m.t === 'restore' && c.teacher) {
      const rm = c.room; if (!rm.fresh) return;
      rm.r = Math.max(0, m.r | 0); rm.status = ['wait', 'run', 'pause'].includes(m.status) ? m.status : 'wait';
      rm.startAt = +m.startAt || 0; rm.pausedAt = +m.pausedAt || 0; rm.fresh = false;
      if (m.play >= 5 && m.play <= 120) rm.run.play = Math.floor(m.play);
      if (m.goal === 0 || (m.goal >= 10 && m.goal <= 200)) rm.run.goal = Math.floor(m.goal);
      for (const p of rm.peers.values()) send(p.ws, stMsg(rm));
    } else if (m.t === 'qs' && c.teacher) {
      const rm = c.room;
      if (m.qs === null) rm.qbank = null;
      else {
        const qs = cleanQs(m.qs);
        if (!qs.length) return send(ws, { t: 'qserr', m: 'Tidak ada soal yang valid.' });
        rm.qbank = qs;
      }
      for (const p of rm.peers.values()) send(p.ws, { t: 'qs', qs: rm.qbank });
      send(ws, { t: 'qsok', n: rm.qbank ? rm.qbank.length : 0 });
    } else if (m.t === 'rep' && c.teacher) {
      const rm = c.room;
      send(ws, { t: 'rep', stu: [...rm.stu.values()], qs: [...rm.qs].map(([t, v]) => ({ t, b: v.b, s: v.s })),
        sus: [...rm.peers.values()].filter(x => x.viol > 0 && x.presence).map(x => ({ n: String(x.presence.n || '?').slice(0, 20), tm: x.presence.t | 0, v: x.viol })) });
    } else if (m.t === 'ctl' && c.teacher) {
      const rm = c.room, now = Date.now(); rm.fresh = false;
      if (m.a === 'start') { rm.run = { ...rm.cfg }; rm.r++; rm.status = 'run'; rm.startAt = now; rm.pausedAt = 0; }
      else if (m.a === 'cfg') {
        if (typeof m.play === 'number' && m.play >= 5 && m.play <= 120) rm.cfg.play = Math.floor(m.play);
        if (typeof m.goal === 'number' && (m.goal === 0 || (m.goal >= 10 && m.goal <= 200))) rm.cfg.goal = Math.floor(m.goal);
      }
      else if (m.a === 'stop') { rm.status = 'wait'; rm.pausedAt = 0; }
      else if (m.a === 'pause' && rm.status === 'run') { rm.status = 'pause'; rm.pausedAt = now; }
      else if (m.a === 'resume' && rm.status === 'pause') { rm.startAt += now - rm.pausedAt; rm.status = 'run'; rm.pausedAt = 0; }
      else if ((m.a === 'kick' || m.a === 'move') && typeof m.id === 'string') {
        const t = rm.peers.get(m.id); if (!t || t.teacher) return;
        if (m.a === 'kick') { send(t.ws, { t: 'kick' }); leave(t); }
        else { t.freeUntil = now + 2500; send(t.ws, { t: 'mv', tm: Math.max(0, Math.min(4, m.tm | 0)) }); }
        return;
      }
      else return;
      for (const p of rm.peers.values()) send(p.ws, stMsg(rm));
    }
  });
  ws.on('close', () => leave(c));
  ws.on('error', () => {});
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
});
// Pemain dekat diperbarui tiap tick, pemain jauh ~1 detik sekali (hemat kuota).
setInterval(() => {
  tick++; const far = tick % 8 === 0;
  for (const rm of rooms.values()) {
    for (const [rid, r] of rm.peers) {
      if (r.ws.readyState !== 1) continue;
      const mp = r.presence, hasPos = mp && typeof mp.x === 'number' && typeof mp.y === 'number' && !mp.sp;
      const out = {}; let any = false;
      for (const [id, c] of rm.peers) {
        if (id === rid || !c.presence || r.seen[id] === c.ver) continue;
        let go = far || r.seen[id] === undefined || !hasPos || typeof c.presence.x !== 'number';
        if (!go) go = Math.hypot(c.presence.x - mp.x, c.presence.y - mp.y) < NEAR;
        if (go) { out[id] = c.presence; r.seen[id] = c.ver; any = true; }
      }
      if (any || rm.gone.length) send(r.ws, { t: 'd', p: out, g: rm.gone });
    }
    rm.gone = [];
  }
}, 100);
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  for (const [k, rm] of rooms) if (!rm.peers.size && rm.emptySince && Date.now() - rm.emptySince > 30 * 60000) rooms.delete(k);
}, 25000);
server.listen(process.env.PORT || 3000, () => console.log('Arena Pemburu berjalan'));
