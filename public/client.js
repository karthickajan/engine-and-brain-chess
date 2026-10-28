const SQ = 'abcdefgh';
const NAMES = { w: 'White', b: 'Black' };
const STOCKFISH_URL = 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js';
const rand = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const NAME_KEY = 'lanChessPlayerName';

const playerName = () => {
  const value = localStorage.getItem(NAME_KEY) || '';
  return value.trim() || 'Player';
};

const saveName = value => {
  const clean = (value || '').trim();
  localStorage.setItem(NAME_KEY, clean || 'Player');
  $('#player-name').val(clean || 'Player');
};

const clientId = sessionStorage.getItem('cid') || (sessionStorage.setItem('cid', rand()), sessionStorage.getItem('cid'));
let room = location.hash.slice(1);
if (!/^[\w-]{1,32}$/.test(room)) location.hash = room = rand().slice(0, 6);

class Engine {
  constructor(onBest, onEval) {
    const src = URL.createObjectURL(new Blob([`importScripts('${STOCKFISH_URL}')`], { type: 'text/javascript' }));
    this.w = new Worker(src);
    this.onBest = onBest || (() => {});
    this.onEval = onEval || (() => {});
    this.busy = false;
    this.queued = null;
    this.cur = null;
    this.eval = 0;
    this.w.onmessage = ({ data }) => {
      const scoreMatch = /score\s+(?:cp|mate)\s+(-?\d+)/i.exec(data || '');
      if (scoreMatch) {
        const val = Number(scoreMatch[1]);
        this.eval = /score\s+mate/i.test(data) ? (val > 0 ? 9.9 : -9.9) : val / 100;
        this.onEval(this.eval);
      }
      const m = /^bestmove (\S+)/.exec(data);
      if (!m) return;
      this.busy = false;
      if (this.queued) return this.#run();
      if (m[1] !== '(none)') this.onBest(this.cur, m[1]);
    };
    this.w.postMessage('uci');
  }
  #run() {
    this.cur = this.queued;
    this.queued = null;
    this.busy = true;
    this.w.postMessage(`position fen ${this.cur}`);
    this.w.postMessage('go movetime 1000');
  }
  analyze(fen) {
    if (this.busy && this.cur === fen && !this.queued) return;
    this.queued = fen;
    this.busy ? this.w.postMessage('stop') : this.#run();
  }
  cancel() {
    this.queued = null;
    if (this.busy) this.w.postMessage('stop');
  }
}

const socket = io();
const game = new Chess();
let color = null, state = null, flip = false, hint = null, board;
let selectedSquare = null;
let timerState = { mode: 'normal', limit: 180, increment: 0, white: 180, black: 180, active: 'w', started: false };
let evalValue = 0;

const other = c => (c === 'w' ? 'b' : 'w');
const bottom = () => (flip ? other(color || 'w') : color || 'w');
const myEngine = () => !!(color && state && state.engine[color]);
const canPlay = () => !!(color && state && !state.result && state.turn === color);
const key = s => [s.fen, s.result, color && s.engine[color]].join();
const COLORS_OPP = () => ['w', 'b'].filter(c => c !== color);

function formatClock(seconds, includeIncrement = false) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'No time';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const value = `${m}:${String(s).padStart(2, '0')}`;
  return includeIncrement ? `${value} (+${timerState.increment || 0}s)` : value;
}

function syncTimerUI() {
  const timer = state?.timer || timerState;
  const limit = Number(timer.limit ?? 0) || 0;
  const inc = Number(timer.increment ?? 0) || 0;
  const white = Number(timer.white ?? limit ?? 0);
  const black = Number(timer.black ?? limit ?? 0);
  if (limit <= 0) {
    $('#timer-display').text('No time');
    return;
  }
  const suffix = inc > 0 ? ` (+${inc}s)` : '';
  $('#timer-display').text(`White ${formatClock(white)} • Black ${formatClock(black)}${suffix}`);
}

function resetTimer() {
  const limit = Number($('#time-select').val()) || 0;
  const increment = Number($('#increment-select').val()) || 0;
  timerState = { mode: limit > 0 ? 'normal' : 'none', limit, increment, white: limit, black: limit, active: 'w', started: false };
  if (state) {
    state.timer = timerState;
  }
  syncTimerUI();
  socket.emit('timer-config', { limit, increment });
}

const engine = new Engine(
  (fen, mv) => {
    if (state && fen === state.fen && myEngine() && canPlay()) { hint = mv.slice(0, 2); paint(); }
  },
  score => {
    evalValue = Number.isFinite(score) ? score : 0;
    updateEvalUI();
  }
);

function refreshHint() {
  hint = null;
  evalValue = 0;
  $('#eval-panel').attr('hidden', 'hidden');
  if (myEngine() && canPlay()) {
    engine.analyze(state.fen);
  } else {
    engine.cancel();
  }
}

function updateEvalUI() {
  const active = myEngine() && canPlay() && Number.isFinite(evalValue);
  const display = `${evalValue >= 0 ? '+' : ''}${evalValue.toFixed(2)}`;
  $('#eval-value').text(display);
  $('#eval-panel').prop('hidden', !active);
  if (!active) return;
  const pct = Math.max(0, Math.min(100, ((evalValue + 10) / 20) * 100));
  $('#eval-fill').css('width', `${pct}%`);
}

function syncOrientation() {
  const o = bottom() === 'w' ? 'white' : 'black';
  if (board.orientation() !== o) board.orientation(o);
}

function highlightLegalMoves(square) {
  $('#board .square-55d63').removeClass('legal-move legal-capture');
  if (!square) return;
  const legal = game.moves({ square, verbose: true }) || [];
  legal.forEach(move => {
    const targetClass = move.flags.includes('c') || move.flags.includes('e') ? 'legal-capture' : 'legal-move';
    $('#board .square-' + move.to).addClass(targetClass);
  });
}

function paint() {
  $('#board .square-55d63').removeClass('last-move in-check hint selected-square');
  const sq = s => $('#board .square-' + s);
  if (state && state.lastMove) {
    sq(state.lastMove.from).add(sq(state.lastMove.to)).addClass('last-move');
  }
  if (game.in_check()) {
    game.board().forEach((row, r) => row.forEach((p, c) => {
      if (p && p.type === 'k' && p.color === game.turn()) sq(SQ[c] + (8 - r)).addClass('in-check');
    }));
  }
  if (selectedSquare) sq(selectedSquare).addClass('selected-square');
  if (hint) sq(hint).addClass('hint');
}

function renderMeta() {
  const b = bottom();
  [['#top', other(b)], ['#bottom', b]].forEach(([sel, c]) => {
    const el = $(sel);
    const displayName = (c === color) ? `${playerName()} (${NAMES[c]})` : NAMES[c];
    el.find('.name').text(displayName);
    el.find('.dot').toggleClass('on', state.seated[c]);
    el.find('.badge').prop('hidden', !state.engine[c]);
    el.toggleClass('turn', !state.result && state.turn === c);
  });

  const flagged = COLORS_OPP().filter(c => state.engine[c]).map(c => NAMES[c]);
  $('#engine-warning').prop('hidden', true);
  $('.board-col').toggleClass('warn', false);
  const seatActive = !!(color && state.seated[color]);
  $('#engine-btn').toggleClass('on', myEngine()).prop('disabled', !seatActive);
  $('#new-game').prop('disabled', !color);
  $('#undo-btn').prop('disabled', !color || !!state.result || !state.history.length);
  $('#resign').prop('disabled', !color || !!state.result);
  $('#role').text(color ? `You play ${NAMES[color]}` : 'Spectating');
  $('#status').text(state.status);

  const h = state.history, rows = [];
  for (let i = 0; i < h.length; i += 2) {
    rows.push(`<span class="n">${i / 2 + 1}</span><span class="m${i === h.length - 1 ? ' cur' : ''}">${h[i]}</span><span class="m${i + 1 === h.length - 1 ? ' cur' : ''}">${h[i + 1] ?? ''}</span>`);
  }
  $('#moves').html(rows.join('')).scrollTop(1e6);
}

function tryMove(from, to) {
  if (!from || !to || from === to) return false;
  const legal = game.moves({ square: from, verbose: true }) || [];
  const move = legal.find(m => m.to === to);
  if (!move) return false;
  const made = game.move({ from, to, promotion: 'q' });
  if (!made) return false;
  selectedSquare = null;
  highlightLegalMoves(null);
  hint = null;
  paint();
  socket.emit('move', { from, to, promotion: 'q' });
  return true;
}

board = Chessboard('board', {
  draggable: true,
  position: 'start',
  pieceTheme: p => `https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/piece/cburnett/${p}.svg`,
  onDragStart: (source, piece) => {
    if (!canPlay() || piece[0] !== color) return false;
    selectedSquare = source;
    highlightLegalMoves(source);
    paint();
    return true;
  },
  onDrop: (from, to) => {
    if (to === 'offboard') return 'snapback';
    if (tryMove(from, to)) return;
    return 'snapback';
  },
  onClickSquare: (square, piece) => {
    if (!canPlay()) {
      selectedSquare = null;
      highlightLegalMoves(null);
      paint();
      return;
    }
    if (!piece) {
      if (selectedSquare && tryMove(selectedSquare, square)) return;
      selectedSquare = null;
      highlightLegalMoves(null);
      paint();
      return;
    }
    if (piece[0] !== color) {
      if (selectedSquare && tryMove(selectedSquare, square)) return;
      selectedSquare = null;
      highlightLegalMoves(null);
      paint();
      return;
    }
    if (selectedSquare === square) {
      selectedSquare = null;
      highlightLegalMoves(null);
      paint();
      return;
    }
    const legal = game.moves({ square, verbose: true }) || [];
    selectedSquare = legal.length ? square : null;
    highlightLegalMoves(selectedSquare);
    paint();
  },
  onSnapEnd: () => board.position(game.fen()),
});

$('#player-name').val(playerName());
$('#player-name').on('input', () => {
  const value = $('#player-name').val().toString();
  saveName(value);
  if (state) renderMeta();
});

socket.on('connect', () => socket.emit('join', { room, clientId, name: playerName() }));
socket.on('joined', d => { color = d.color; flip = false; });

socket.on('state', s => {
  const prev = state && key(state);
  state = s;
  timerState = s.timer || timerState;
  game.load(s.fen);
  syncOrientation();
  board.position(s.fen);
  if (prev !== key(s)) refreshHint();
  syncTimerUI();
  paint();
  renderMeta();
});

socket.on('engine-mode-toggled', d => {
  if (!state) return;
  state.engine = d.engine;
  renderMeta();
  if (d.color === color) { refreshHint(); paint(); }
});

$('#engine-btn').on('click', () => socket.emit('engine-mode-toggle', !myEngine()));
$('#flip').on('click', () => { if (!state) return; flip = !flip; syncOrientation(); renderMeta(); paint(); });
$('#undo-btn').on('click', () => {
  if (!state || !color || state.result) return;
  socket.emit('undo-request');
});
$('#new-game').on('click', () => confirm('Start a new game?') && socket.emit('new-game'));
$('#resign').on('click', () => confirm('Resign?') && socket.emit('resign'));
$('#export').on('click', () => {
  if (!state) return;
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([state.pgn], { type: 'application/x-chess-pgn' })),
    download: `chess-${room}.pgn`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
const lichessFen = fen => fen.replace(/\s+/g, '_');
$('#analyze').on('click', () => state && window.open(`https://www.chess.com/analysis?fen=${encodeURIComponent(state.fen)}`, '_blank', 'noopener'));
$('#lichess-analyze').on('click', () => state && window.open(`https://lichess.org/analysis/${lichessFen(state.fen)}`, '_blank', 'noopener'));
$('#copy').on('click', () => { $('#invite').trigger('select'); document.execCommand('copy'); });
$('#invite').on('click', e => e.target.select());
$(window).on('resize', () => { board.resize(); paint(); });

$('#timer-reset').on('click', resetTimer);
$('#time-select').on('change', resetTimer);
$('#increment-select').on('change', resetTimer);

resetTimer();
$('#invite').val(location.href);
fetch('/lan').then(r => r.json()).then(ips => {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const host = local && ips[0] ? `${ips[0]}:${location.port}` : location.host;
  $('#invite').val(`${location.protocol}//${host}/#${room}`);
});