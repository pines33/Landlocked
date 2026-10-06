'use strict';

/* ================= Hjälpfunktioner ================= */
const $ = (sel) => document.querySelector(sel);
const regionNames = new Intl.DisplayNames(['sv'], { type: 'region' });
const flagOf = (cc) => String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
const nameOf = (cc) => { try { return regionNames.of(cc) || cc; } catch { return cc; } };
const label = (cc) => `${flagOf(cc)} ${nameOf(cc)}`;
const gen = (name) => (/[sxz]$/i.test(name) ? name : name + 's'); // svensk genitiv
const isMobile = () => matchMedia('(max-width: 860px)').matches;
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
  del(key) { try { localStorage.removeItem(key); } catch {} },
  keys() { try { return Object.keys(localStorage); } catch { return []; } },
};

/* ================= Tillstånd ================= */
const S = {
  ws: null,
  retry: 0,
  kicked: false,
  queue: [],
  session: store.get('lg_session'), // { code, token }
  seat: null,
  state: null,       // senaste tillstånd från servern
  chat: [],
  marks: new Set(),  // privata markeringar (bara lokalt)
  marksKey: null,
  mode: 'mark',      // 'mark' | 'guess'
  candidate: null,   // land som väntar på bekräftelse
  tab: 'flags',
  unread: 0,
  resultShownRound: null,
  prevTurn: null,
};

let COUNTRIES = [];  // sorterad på svenskt namn
let map = null;
const flagButtons = new Map();

/* ================= Anslutning ================= */
function connect() {
  clearTimeout(connect.timer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  setConn('');

  ws.onopen = () => {
    S.retry = 0;
    setConn('on');
    hideBanner();
    if (S.session) ws.send(JSON.stringify({ t: 'resume', ...S.session }));
    while (S.queue.length) ws.send(JSON.stringify(S.queue.shift()));
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    onMessage(msg);
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    setConn('off');
    if (S.kicked) return;
    if (S.session) showBanner('Anslutningen bröts – återansluter…');
    const delay = Math.min(10000, 500 * 2 ** S.retry++);
    connect.timer = setTimeout(connect, delay);
  };
}

function send(msg) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(msg));
  else S.queue.push(msg);
}

document.addEventListener('visibilitychange', () => {
  // Mobiler stänger ofta sockets i bakgrunden – återanslut direkt när fliken syns igen.
  if (document.visibilityState === 'visible' && !S.kicked &&
      (!S.ws || S.ws.readyState === WebSocket.CLOSED)) connect();
});

function setConn(cls) {
  const el = $('#conn');
  el.className = 'conn ' + cls;
  el.title = cls === 'on' ? 'Ansluten' : cls === 'off' ? 'Frånkopplad' : 'Ansluter…';
}

function showBanner(text, kind = '') {
  const b = $('#banner');
  b.textContent = text;
  b.className = 'banner ' + kind;
  b.hidden = false;
}
function hideBanner() { $('#banner').hidden = true; }

let toastTimer;
function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ================= Serverns meddelanden ================= */
function onMessage(msg) {
  switch (msg.t) {
    case 'session':
      S.session = { code: msg.code, token: msg.token };
      S.seat = msg.seat;
      store.set('lg_session', S.session);
      history.replaceState(null, '', `?rum=${msg.code}`);
      break;

    case 'state': {
      const prev = S.state;
      S.state = msg;
      S.seat = msg.seat;
      if (!prev || prev.round !== msg.round) { S.candidate = null; S.mode = 'mark'; }
      if (msg.phase === 'playing' && msg.turn === msg.seat && S.prevTurn !== msg.seat && prev?.phase === 'playing') {
        toast(S.oppGuessNote ? `${S.oppGuessNote} Din tur!` : 'Din tur!', S.oppGuessNote ? 3600 : 2600);
        navigator.vibrate?.(60);
      }
      S.prevTurn = msg.turn;
      S.oppGuessNote = null;
      loadMarks();
      render();
      break;
    }

    case 'chatLog':
      S.chat = msg.messages || [];
      renderChat();
      break;

    case 'chat':
      S.chat.push(msg.message);
      appendChat(msg.message);
      onLiveChat(msg.message);
      break;

    case 'error':
      if (msg.code === 'nosession') {
        clearSession();
        showStart(msg.msg);
      } else if (!$('#screen-start').hidden) {
        $('#startError').textContent = msg.msg;
      } else {
        toast(msg.msg);
      }
      break;

    case 'kicked':
      S.kicked = true;
      showBanner(msg.msg + ' Ladda om sidan för att fortsätta här.');
      setConn('off');
      break;

    case 'oppLeft':
      clearSession();
      showStart('Motspelaren lämnade rummet.');
      break;
  }
}

function onLiveChat(m) {
  const me = m.seat === S.seat;
  if (m.kind === 'guess') {
    if (m.correct) return; // resultatrutan visas
    if (me) toast(`Fel – det var inte ${label(m.country)}. Turen går över.`, 3200);
    else S.oppGuessNote = `${m.name} gissade ${label(m.country)} – fel!`; // visas ihop med "Din tur!"
  } else if (!me && (isMobile() && S.tab !== 'chat')) {
    S.unread++;
    renderUnread();
  }
}

function clearSession() {
  S.session = null;
  S.state = null;
  S.chat = [];
  S.candidate = null;
  store.del('lg_session');
  history.replaceState(null, '', location.pathname);
  closeResult();
}

/* ================= Privata markeringar ================= */
function loadMarks() {
  const st = S.state;
  const key = `lg_marks:${st.code}:${S.session?.token}:${st.round}`;
  if (key === S.marksKey) return;
  S.marksKey = key;
  S.marks = new Set(store.get(key) || []);
  // Städa bort markeringar från tidigare rum/omgångar
  for (const k of store.keys()) if (k.startsWith('lg_marks:') && k !== key) store.del(k);
}
function saveMarks() { store.set(S.marksKey, [...S.marks]); }

/* ================= Skärmar ================= */
function showScreen(name) {
  for (const s of ['start', 'lobby', 'board']) $('#screen-' + s).hidden = s !== name;
}

function showStart(error = '') {
  showScreen('start');
  $('#roomChip').hidden = true;
  $('#actionbar').hidden = true;
  $('#startError').textContent = error;
}

function shareUrl() { return `${location.origin}/?rum=${S.state.code}`; }

function render() {
  const st = S.state;
  if (!st) return;
  hideBanner();
  const chip = $('#roomChip');
  chip.hidden = false;
  chip.textContent = st.code;

  if (st.phase === 'lobby') {
    showScreen('lobby');
    $('#lobbyCode').textContent = st.code;
    $('#shareLink').value = shareUrl();
    $('#shareBtn').hidden = !navigator.share;
    $('#actionbar').hidden = true;
    return;
  }

  showScreen('board');
  ensureMap();
  renderStatus();
  renderControls();
  paintMap();
  renderFlags();
  renderAction();
  renderResult();
}

function renderStatus() {
  const st = S.state, opp = st.opp;
  const myTurn = st.phase === 'playing' && st.turn === st.seat;
  let text = '', sub = '';
  if (st.phase === 'picking') {
    if (!st.you.pick) {
      text = 'Välj ditt hemliga land';
      sub = opp.hasPicked ? `${opp.name} har valt sitt land.` : `${opp.name} väljer också…`;
    } else {
      text = `Väntar på ${opp.name}…`;
      sub = 'Du kan byta land tills båda har valt.';
    }
  } else if (st.phase === 'playing') {
    text = myTurn ? 'Din tur' : `${gen(opp.name)} tur`;
    sub = myTurn ? 'Ställ en ja/nej-fråga, markera bort länder – eller gissa.'
                 : `Svara på ${gen(opp.name)} fråga. Du kan markera under tiden.`;
  } else if (st.phase === 'over') {
    text = st.winner === st.seat ? 'Du vann! 🎉' : `${opp.name} vann`;
    sub = opp.rematch && !st.you.rematch ? `${opp.name} vill spela igen!` : 'Omgången är slut.';
  }
  if (!opp.connected) sub = `⚠️ ${opp.name} är frånkopplad – väntar på återanslutning.`;
  const el = $('#statusText');
  el.textContent = text;
  el.classList.toggle('myturn', myTurn);
  $('#statusSub').textContent = sub;

  const mine = $('#myCountry');
  mine.hidden = !st.you.pick;
  if (st.you.pick) {
    mine.innerHTML = '';
    mine.append(span('flag', flagOf(st.you.pick)), span('name', 'Ditt land: ' + nameOf(st.you.pick)));
  }

  const hints = {
    picking: 'Tryck på ett land på kartan eller i listan. Motspelaren ser aldrig ditt val.',
    mark: 'Tryck för att markera bort ett land – tryck igen för att ångra. Markeringarna syns bara för dig.',
    guess: 'Välj det land du tror att motspelaren har och bekräfta. Fel gissning avslutar turen.',
    over: 'Gult = motspelarens land, grönt = ditt.',
  };
  $('#hint').textContent = st.phase === 'picking' ? hints.picking : st.phase === 'over' ? hints.over : hints[S.mode];
}

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

function renderControls() {
  const st = S.state;
  const myTurn = st.phase === 'playing' && st.turn === st.seat;
  if (!myTurn && S.mode === 'guess') { S.mode = 'mark'; S.candidate = null; }
  $('#controls').hidden = st.phase === 'picking';
  const playing = st.phase === 'playing';
  $('.seg').hidden = !playing;
  $('#endTurnBtn').hidden = !playing;
  $('#endTurnBtn').disabled = !myTurn;
  $('#showResultBtn').hidden = st.phase !== 'over';
  $('#modeGuess').disabled = !myTurn;
  $('#modeMark').classList.toggle('active', S.mode === 'mark');
  $('#modeGuess').classList.toggle('active', S.mode === 'guess');
}

/* ================= Karta ================= */
let downAt = null;

function ensureMap() {
  if (map) return;
  const el = $('#map');
  el.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  map = new jsVectorMap({
    selector: '#map',
    map: 'world',
    backgroundColor: 'transparent',
    zoomButtons: true,
    zoomOnScroll: true,
    zoomMax: 20,
    regionStyle: {
      initial: { fill: cssVar('--land'), stroke: cssVar('--sea'), strokeWidth: 0.4, fillOpacity: 1 },
      hover: { fillOpacity: 0.72, cursor: 'pointer' },
      selected: {},
    },
    onRegionTooltipShow(event, tooltip, code) {
      tooltip.text(label(code));
    },
    onRegionClick(event, code) {
      // Ignorera klick som egentligen var panorering
      if (downAt && Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) > 6) return;
      map._tooltip?.hide();
      onCountry(code);
    },
  });
}

function colorFor(cc) {
  const st = S.state;
  if (st.phase === 'over' && cc === st.opp.pick) return cssVar('--reveal');
  if (cc === S.candidate) return cssVar('--accent');
  if (st.phase !== 'picking' && S.marks.has(cc)) return cssVar('--marked');
  if (cc === st.you.pick) return cssVar('--mine');
  return cssVar('--land');
}

function paintMap() {
  if (!map || !S.state) return;
  const stroke = cssVar('--sea');
  for (const cc in map.regions) {
    map.regions[cc].element.shape.setStyle({ fill: colorFor(cc), stroke });
  }
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { paintMap(); });

/* ================= Interaktion ================= */
function onCountry(cc) {
  const st = S.state;
  if (!st || !COUNTRIES.includes(cc)) return;
  if (st.phase === 'picking') {
    S.candidate = cc === st.you.pick ? null : cc;
  } else if (st.phase === 'playing') {
    if (S.mode === 'guess' && st.turn === st.seat) {
      S.candidate = S.candidate === cc ? null : cc;
    } else {
      if (S.marks.has(cc)) S.marks.delete(cc); else S.marks.add(cc);
      saveMarks();
    }
  } else {
    return;
  }
  paintMap();
  renderFlags();
  renderAction();
}

function renderAction() {
  const st = S.state;
  const bar = $('#actionbar');
  const cc = S.candidate;
  const show = cc && (st.phase === 'picking' || (st.phase === 'playing' && S.mode === 'guess' && st.turn === st.seat));
  bar.hidden = !show;
  if (!show) return;
  const text = $('#actionText');
  text.innerHTML = '';
  text.append(span('flag', flagOf(cc)), span('', (st.phase === 'picking' ? '' : 'Gissa på ') + nameOf(cc) + (st.phase === 'picking' ? '' : '?')));
  $('#actionOk').textContent = st.phase === 'picking' ? 'Välj land' : 'Gissa!';
}

$('#actionOk').onclick = () => {
  const st = S.state, cc = S.candidate;
  if (!cc) return;
  if (st.phase === 'picking') send({ t: 'pick', country: cc });
  else if (st.phase === 'playing') { send({ t: 'guess', country: cc }); S.mode = 'mark'; }
  S.candidate = null;
  render();
};
$('#actionCancel').onclick = () => { S.candidate = null; paintMap(); renderFlags(); renderAction(); };

$('#modeMark').onclick = () => { S.mode = 'mark'; S.candidate = null; render(); };
$('#modeGuess').onclick = () => { S.mode = 'guess'; render(); };
$('#endTurnBtn').onclick = () => { send({ t: 'endTurn' }); S.candidate = null; };
$('#resetZoom').onclick = () => map && map.reset();

/* ================= Flagglista ================= */
function buildFlags() {
  const wrap = $('#flags');
  wrap.innerHTML = '';
  for (const cc of COUNTRIES) {
    const b = document.createElement('button');
    b.className = 'flag-btn';
    b.type = 'button';
    b.dataset.cc = cc;
    b.title = nameOf(cc);
    b.append(span('flag', flagOf(cc)), span('nm', nameOf(cc)));
    b.onclick = () => onCountry(cc);
    flagButtons.set(cc, b);
    wrap.append(b);
  }
}

function renderFlags() {
  const st = S.state;
  if (!st) return;
  const q = $('#search').value.trim().toLocaleLowerCase('sv');
  const hide = $('#hideMarked').checked && st.phase !== 'picking';
  const showMarks = st.phase !== 'picking';
  let left = 0;
  for (const [cc, b] of flagButtons) {
    const marked = showMarks && S.marks.has(cc);
    if (!marked) left++;
    b.classList.toggle('marked', marked);
    b.classList.toggle('candidate', cc === S.candidate);
    b.classList.toggle('mine', cc === st.you.pick);
    b.classList.toggle('reveal', st.phase === 'over' && cc === st.opp.pick);
    const match = !q || nameOf(cc).toLocaleLowerCase('sv').includes(q) || cc.toLowerCase() === q;
    b.hidden = !match || (hide && marked);
  }
  $('#hideMarked').parentElement.hidden = st.phase === 'picking';
  $('#flagCount').textContent = st.phase === 'picking'
    ? `${COUNTRIES.length} länder`
    : `${left} av ${COUNTRIES.length} kvar`;
}

$('#search').addEventListener('input', renderFlags);
$('#hideMarked').addEventListener('change', renderFlags);

/* ================= Flikar (mobil) ================= */
for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    S.tab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + S.tab));
    if (S.tab === 'chat') { S.unread = 0; renderUnread(); scrollChat(); }
  };
}
function renderUnread() {
  const u = $('#unread');
  u.hidden = !S.unread;
  u.textContent = S.unread;
}

/* ================= Chatt ================= */
function chatNode(m) {
  const div = document.createElement('div');
  if (m.kind === 'guess') {
    div.className = 'sys' + (m.correct ? ' win' : '');
    div.textContent = `${m.seat === S.seat ? 'Du' : m.name} gissade ${label(m.country)} – ${m.correct ? 'rätt! 🎉' : 'fel'}`;
  } else {
    div.className = 'msg' + (m.seat === S.seat ? ' me' : '');
    if (m.seat !== S.seat) div.append(span('who', m.name));
    div.append(document.createTextNode(m.text));
  }
  return div;
}

function renderChat() {
  const log = $('#chatLog');
  log.innerHTML = '';
  if (!S.chat.length) {
    log.append(span('chat-empty', 'Ställ frågor här – eller prata i ett röstsamtal.'));
  }
  for (const m of S.chat) log.append(chatNode(m));
  scrollChat();
}

function appendChat(m) {
  const log = $('#chatLog');
  log.querySelector('.chat-empty')?.remove();
  log.append(chatNode(m));
  scrollChat();
}

function scrollChat() {
  const log = $('#chatLog');
  log.scrollTop = log.scrollHeight;
}

$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  send({ t: 'chat', text });
  input.value = '';
};

/* ================= Resultat ================= */
const dlg = $('#resultDlg');

function renderResult() {
  const st = S.state;
  if (st.phase !== 'over') { closeResult(); return; }
  const won = st.winner === st.seat;
  $('#resultEmoji').textContent = won ? '🏆' : '🙈';
  $('#resultTitle').textContent = won ? 'Du gissade rätt!' : `${st.opp.name} gissade rätt`;
  const rev = $('#resultReveal');
  rev.innerHTML = '';
  for (const [who, cc] of [['Ditt land', st.you.pick], [`${gen(st.opp.name)} land`, st.opp.pick]]) {
    const box = document.createElement('div');
    box.append(span('who', who), span('flag', flagOf(cc)), span('', nameOf(cc)));
    rev.append(box);
  }
  let sub = '';
  if (st.you.rematch && !st.opp.rematch) sub = `Väntar på att ${st.opp.name} vill spela igen…`;
  else if (st.opp.rematch && !st.you.rematch) sub = `${st.opp.name} vill spela igen!`;
  $('#resultSub').textContent = sub;
  $('#rematchBtn').disabled = st.you.rematch;
  $('#rematchBtn').textContent = st.you.rematch ? 'Väntar…' : 'Spela igen';

  if (S.resultShownRound !== st.round) {
    S.resultShownRound = st.round;
    openResult();
  }
}

function openResult() { if (!dlg.open) dlg.showModal(); }
function closeResult() { if (dlg.open) dlg.close(); }

$('#rematchBtn').onclick = () => send({ t: 'rematch' });
$('#closeResult').onclick = closeResult;
$('#showResultBtn').onclick = openResult;

/* ================= Start / lobby ================= */
const nameInput = $('#nameInput');
nameInput.value = store.get('lg_name') || '';
nameInput.addEventListener('input', () => store.set('lg_name', nameInput.value.trim()));

function startSession(msg) {
  $('#startError').textContent = '';
  S.kicked = false;
  S.session = null;
  S.state = null;
  S.chat = [];
  send(msg);
}

$('#createBtn').onclick = () => startSession({ t: 'create', name: nameInput.value });

$('#joinForm').onsubmit = (e) => {
  e.preventDefault();
  const code = $('#codeInput').value.trim().toUpperCase();
  if (code.length !== 4) { $('#startError').textContent = 'Rumskoden har fyra tecken.'; return; }
  startSession({ t: 'join', code, name: nameInput.value });
};
$('#codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

async function copyLink() {
  const url = shareUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast('Länken är kopierad');
  } catch {
    $('#shareLink').select();
    toast('Markera och kopiera länken');
  }
}
$('#copyBtn').onclick = copyLink;
$('#roomChip').onclick = copyLink;
$('#shareBtn').onclick = () => navigator.share({ title: 'Landsgissning', text: `Spela landsgissning med mig! Kod: ${S.state.code}`, url: shareUrl() }).catch(() => {});

for (const b of document.querySelectorAll('.leaveBtn')) {
  b.onclick = () => {
    if (!confirm('Lämna rummet? Spelet avslutas för båda.')) return;
    send({ t: 'leave' });
    clearSession();
    showStart();
  };
}

/* ================= Uppstart ================= */
async function init() {
  const res = await fetch('/countries.json');
  const codes = await res.json();
  COUNTRIES = codes.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'sv'));
  buildFlags();

  const urlCode = new URLSearchParams(location.search).get('rum')?.toUpperCase();
  if (urlCode && S.session?.code !== urlCode) {
    // Inbjudningslänk till ett annat rum än det sparade
    S.session = null;
    store.del('lg_session');
  }
  if (S.session) {
    showBanner(`Ansluter till rum ${S.session.code}…`, 'info');
  } else {
    showStart();
    if (urlCode) {
      $('#codeInput').value = urlCode;
      (nameInput.value ? $('#codeInput') : nameInput).focus();
    }
  }
  connect();
}

init().catch((err) => {
  console.error(err);
  showBanner('Kunde inte ladda spelet. Försök ladda om sidan.');
});
