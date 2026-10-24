const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const PORT = process.env.PORT || 3000;
const ROOM_RE = /^[\w-]{1,32}$/;
const SEAT_GRACE = 30_000;
const ROOM_TTL = 600_000;
const NAMES = { w: 'White', b: 'Black' };
const COLORS = ['w', 'b'];

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const lanIps = () =>
  Object.values(os.networkInterfaces()).flat()
    .filter(i => (i.family === 'IPv4' || i.family === 4) && !i.internal)
    .map(i => i.address);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/lan', (_, res) => res.json(lanIps()));

const rooms = new Map();

const freshGame = () => ({
  chess: new Chess(),
  engine: { w: false, b: false },
  result: null,
  reason: null,
  lastMove: null,
  timer: { limit: 180, increment: 0, white: 180, black: 180, active: 'w', started: false, mode: 'normal' },
  date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
});

const tickRoomTimers = () => {
  for (const room of rooms.values()) {
    if (!room.timer || room.timer.limit <= 0 || !room.timer.started || room.result) continue;
    const active = room.timer.active;
    if (!['w', 'b'].includes(active)) continue;
    room.timer[active] = Math.max(0, room.timer[active] - 1);
    if (room.timer[active] <= 0) {
      room.result = active === 'w' ? '0-1' : '1-0';
      room.reason = `${NAMES[active]} ran out of time`;
    }
    push(room.id, room);
  }
};

const getRoom = id => {
  if (!rooms.has(id)) rooms.set(id, { id, ...freshGame(), seats: { w: null, b: null }, sockets: { w: null, b: null }, timers: {}, gc: null });
  return rooms.get(id);
};

const outcome = r => {
  if (r.result) return { result: r.result, reason: r.reason };
  const c = r.chess;
  if (c.isCheckmate()) return { result: c.turn() === 'w' ? '0-1' : '1-0', reason: 'Checkmate' };
  const draw = [
    [c.isStalemate(), 'Stalemate'],
    [c.isInsufficientMaterial(), 'Insufficient material'],
    [c.isThreefoldRepetition(), 'Threefold repetition'],
    [c.isDraw(), 'Draw'],
  ].find(([hit]) => hit);
  return draw ? { result: '1/2-1/2', reason: draw[1] } : null;
};

const pgnOf = (r, o) => {
  const res = o?.result ?? '*';
  const headers = { Event: 'LAN Chess', Site: 'Local Network', Date: r.date, Round: '-', White: 'White', Black: 'Black', Result: res };
  return `${Object.entries(headers).map(([k, v]) => `[${k} "${v}"]`).join('\n')}\n\n${r.chess.pgn()} ${res}`;
};

const snapshot = r => {
  const o = outcome(r);
  const turn = r.chess.turn();
  const timerText = r.timer.mode === 'none' || r.timer.limit <= 0 ? 'No time' : `${r.timer.white} • ${r.timer.black}`;
  return {
    fen: r.chess.fen(),
    history: r.chess.history(),
    pgn: pgnOf(r, o),
    turn,
    lastMove: r.lastMove,
    result: o?.result ?? null,
    status: o ? `${o.reason} · ${o.result}` : `${NAMES[turn]} to move${r.chess.inCheck() ? ' (check)' : ''}`,
    seated: { w: !!r.sockets.w, b: !!r.sockets.b },
    engine: r.engine,
    timer: { ...r.timer, display: timerText },
  };
};

const push = (room, r) => io.to(room).emit('state', snapshot(r));

const announceSeats = r => {
  for (const c of COLORS) {
    const s = io.sockets.sockets.get(r.sockets[c]);
    if (s) { s.data.color = c; s.emit('joined', { color: c }); }
  }
};

io.on('connection', socket => {
  const ctx = () => {
    const { room, color } = socket.data;
    const r = rooms.get(room);
    return r ? { room, color, r } : null;
  };

  socket.on('join', ({ room, clientId } = {}) => {
    if (socket.data.room || !ROOM_RE.test(room) || typeof clientId !== 'string') return;
    const r = getRoom(room);
    clearTimeout(r.gc);
    const color = COLORS.find(c => r.seats[c] === clientId) ?? COLORS.find(c => !r.seats[c]) ?? null;
    if (color) {
      const prev = io.sockets.sockets.get(r.sockets[color]);
      if (prev && prev.id !== socket.id) { prev.data.color = null; prev.emit('joined', { color: null }); }
      clearTimeout(r.timers[color]);
      r.seats[color] = clientId;
      r.sockets[color] = socket.id;
    }
    Object.assign(socket.data, { room, color });
    socket.join(room);
    socket.emit('joined', { color });
    push(room, r);
  });

  socket.on('move', m => {
    const c = ctx();
    if (!c?.color) return;
    const { room, color, r } = c;
    if (outcome(r) || r.chess.turn() !== color || typeof m?.from !== 'string' || typeof m?.to !== 'string') return socket.emit('state', snapshot(r));
    try {
      const mv = r.chess.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' });
      r.lastMove = { from: mv.from, to: mv.to };
      if (r.timer.limit > 0) {
        r.timer[color] = Math.max(0, r.timer[color] + (r.timer.increment || 0));
        if (!r.timer.started && r.chess.history().length >= 2) {
          r.timer.started = true;
        }
        r.timer.active = r.chess.turn();
      }
    } catch {
      return socket.emit('state', snapshot(r));
    }
    push(room, r);
  });

  socket.on('timer-config', ({ limit, increment } = {}) => {
    const c = ctx();
    if (!c?.color) return;
    const { room, r } = c;
    const safeLimit = Number(limit) || 0;
    const safeInc = Number(increment) || 0;
    r.timer.limit = safeLimit;
    r.timer.increment = safeInc;
    r.timer.mode = safeLimit > 0 ? 'normal' : 'none';
    r.timer.white = safeLimit;
    r.timer.black = safeLimit;
    r.timer.active = 'w';
    r.timer.started = false;
    push(room, r);
  });

  socket.on('engine-mode-toggle', on => {
    const c = ctx();
    if (!c?.color) return;
    c.r.engine[c.color] = !!on;
    io.to(c.room).emit('engine-mode-toggled', { color: c.color, enabled: !!on, engine: c.r.engine });
  });

  socket.on('new-game', () => {
    const c = ctx();
    if (!c?.color) return;
    const base = freshGame();
    base.timer.limit = c.r.timer.limit || 180;
    base.timer.increment = c.r.timer.increment || 0;
    base.timer.mode = base.timer.limit > 0 ? 'normal' : 'none';
    base.timer.white = base.timer.limit;
    base.timer.black = base.timer.limit;
    Object.assign(c.r, base);
    if (c.r.sockets.w && c.r.sockets.b) for (const k of ['seats', 'sockets']) [c.r[k].w, c.r[k].b] = [c.r[k].b, c.r[k].w];
    announceSeats(c.r);
    push(c.room, c.r);
  });

  socket.on('resign', () => {
    const c = ctx();
    if (!c?.color || outcome(c.r)) return;
    c.r.result = c.color === 'w' ? '0-1' : '1-0';
    c.r.reason = `${NAMES[c.color]} resigned`;
    push(c.room, c.r);
  });

  socket.on('disconnect', () => {
    const c = ctx();
    if (!c) return;
    const { room, color, r } = c;
    if (color && r.sockets[color] === socket.id) {
      r.sockets[color] = null;
      r.timers[color] = setTimeout(() => {
        if (r.sockets[color]) return;
        r.seats[color] = null;
        r.engine[color] = false;
        push(room, r);
      }, SEAT_GRACE);
    }
    push(room, r);
    if (!io.sockets.adapter.rooms.get(room)) {
      r.gc = setTimeout(() => !io.sockets.adapter.rooms.get(room) && rooms.delete(room), ROOM_TTL);
    }
  });
});

setInterval(tickRoomTimers, 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`local:   http://localhost:${PORT}`);
  lanIps().forEach(ip => console.log(`network: http://${ip}:${PORT}`));
});