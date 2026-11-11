/* =========================================================
   EMS — Отчётная система ИП
   ========================================================= */

window.__EMS_BOOTED = true;

let CONFIG = loadConfig();

/* Разовая миграция: раньше у блока «Профнепригодность» полоса была красной.
   Теперь у всех сообщений единый зелёный акцент. */
(function migrateBotColors() {
  try {
    const key = 'ems.bot.colors.green.v1';
    if (localStorage.getItem(key)) return;
    if (CONFIG && CONFIG.botMessages) {
      Object.keys(CONFIG.botMessages).forEach(id => {
        const item = CONFIG.botMessages[id];
        if (item && String(item.color || '').toLowerCase() === '#ff6a6a') {
          item.color = '#b6e04d';
        }
      });
      persistConfig(CONFIG);
    }
    localStorage.setItem(key, '1');
  } catch (e) {}
})();

/* Основной сайт живёт на Vercel и сам обслуживает /api. Зеркало на GitHub Pages
   серверной части не имеет, поэтому обращается к API основного домена.
   Если провайдер режет один адрес, пробуем резервный адрес того же проекта. */
/* Релей на Deno Deploy (папка relay/deno) — для сетей, где режут Vercel.
   Принимает запрос и пересылает его в наш API, секретов в нём нет. */
const API_RELAY = 'https://ems-relay.qwerty9812345.deno.net';

const API_HOSTS = (function () {
  const h = String((typeof location !== 'undefined' && location.hostname) || '');
  if (!h || h === 'localhost' || h === '127.0.0.1') return [''];
  const sameOrigin = h === 'ems.celleste.site' || h === 'ems-ip.pages.dev' || /\.vercel\.app$/.test(h);
  if (sameOrigin) {
    /* Основной сайт сам обслуживает /api; релей — запасной путь,
       если провайдер не пускает POST. */
    return API_RELAY ? ['', API_RELAY] : [''];
  }
  const hosts = ['https://ems.celleste.site'];
  if (API_RELAY) hosts.push(API_RELAY);
  hosts.push('https://gta5rpip.vercel.app');
  return hosts;
})();

let apiHostIndex = 0;
try {
  const saved = Number(localStorage.getItem('ems.api.host') || '0');
  if (saved >= 0 && saved < API_HOSTS.length) apiHostIndex = saved;
} catch (e) {}

function apiUrl(path) { return API_HOSTS[apiHostIndex] + path; }

/* Выбираем адрес API, который реально отвечает. Проверка идёт дешёвым
   GET /api/health, поэтому сама отправка отчёта не дублируется. */
let apiHostReady = null;
function ensureApiHost() {
  if (API_HOSTS.length < 2) return Promise.resolve(apiHostIndex);
  if (apiHostReady) return apiHostReady;
  apiHostReady = (async () => {
    for (let i = 0; i < API_HOSTS.length; i++) {
      const idx = (apiHostIndex + i) % API_HOSTS.length;
      try {
        const ctl = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
          ? AbortSignal.timeout(6000) : undefined;
        const res = await fetch(API_HOSTS[idx] + '/api/health', { cache: 'no-store', signal: ctl });
        if (res.ok) {
          apiHostIndex = idx;
          try { localStorage.setItem('ems.api.host', String(idx)); } catch (e) {}
          return idx;
        }
      } catch (e) { /* пробуем следующий адрес */ }
    }
    apiHostReady = null; /* не запоминаем неудачу: в следующий раз проверим заново */
    return apiHostIndex;
  })();
  return apiHostReady;
}

function resetApiHost() { apiHostReady = null; }

/* Любой запрос к API сначала дожидается выбора рабочего адреса. */
async function apiFetch(path, options) {
  await ensureApiHost();
  return fetch(apiUrl(path), options);
}

const state = {
  form: 'menu',
  periods: { weekly: null, night: null },
  rank: '',
  std: { weekly: {}, promotion: {}, night: {} },
  extras: { weekly: [], promotion: [], night: [] }
};

const FORM_PREFIX = { weekly: 'Weekly', promotion: 'Promotion', night: 'Night', stat: 'Stat', intern: 'Intern', unfit: 'Unfit' };
function formPrefix(formType) {
  return FORM_PREFIX[formType] || 'Weekly';
}
function periodFor(formType) {
  return state.periods[formType] || (state.periods[formType] = { start: null, end: null, hover: null, calMonth: new Date() });
}

let editedConfig = null;
let adminUnlocked = false;

const AUTH_TTL = 7 * 24 * 60 * 60 * 1000;
const ADMIN_AUTH_KEY = 'ems.admin.until';
const EDITOR_AUTH_KEY = 'ems.editor.until';
const QUIZ_KEY = 'ems.quiz.checked.v1';
let editorUnlocked = false;

function readAuth(key) {
  try {
    const until = parseInt(localStorage.getItem(key) || '', 10);
    if (until && Date.now() < until) return true;
    if (until) localStorage.removeItem(key);
  } catch (e) {}
  return false;
}

function grantAuth(key) {
  try { localStorage.setItem(key, String(Date.now() + AUTH_TTL)); } catch (e) {}
}

function revokeAuth(key) {
  try { localStorage.removeItem(key); } catch (e) {}
}

function restoreAuth() {
  adminUnlocked = readAuth(ADMIN_AUTH_KEY);
  editorUnlocked = readAuth(EDITOR_AUTH_KEY);
}

let webhookStatus = [];

const $ = id => document.getElementById(id);

/* Безопасная привязка обработчика: не падает, если элемента нет
   (например, при рассинхроне версий index.html и app.js). */
function on(id, event, handler, opts) {
  const el = $(id);
  if (!el) { console.warn('[EMS] нет элемента #' + id); return null; }
  el.addEventListener(event, handler, opts);
  return el;
}

/* ================= Кастомные SVG-иконки ================= */

const ICONS = {
  chart: '<path d="M4.5 20V11"/><path d="M9.7 20V4.8"/><path d="M14.9 20v-6.4"/><path d="M20.1 20V8.6"/><path d="M3 20h18"/>',
  star: '<path d="m12 3.4 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  pin: '<path d="M12 21.2s6.8-5.6 6.8-11a6.8 6.8 0 1 0-13.6 0c0 5.4 6.8 11 6.8 11z"/><circle cx="12" cy="10.1" r="2.5"/>',
  alert: '<path d="M12 4.4 2.9 20h18.2z"/><path d="M12 10.2v4.1"/><path d="M12 17.1h.01"/>',
  check: '<circle cx="12" cy="12" r="8.6"/><path d="m8.4 12.3 2.5 2.5 4.7-5.1"/>',
  close: '<path d="M6.6 6.6 17.4 17.4"/><path d="M17.4 6.6 6.6 17.4"/>',
  send: '<path d="M20.8 3.6 10.2 14.2"/><path d="M20.8 3.6 14.4 21l-4.2-6.8L3.4 10z"/>',
  loader: '<path d="M12 3.6v3.2"/><path d="M12 17.2v3.2"/><path d="M3.6 12h3.2"/><path d="M17.2 12h3.2"/><path d="m6.1 6.1 2.3 2.3"/><path d="m15.6 15.6 2.3 2.3"/><path d="m17.9 6.1-2.3 2.3"/><path d="m8.4 15.6-2.3 2.3"/>',
  trash: '<path d="M4.8 7.2h14.4"/><path d="M9.4 7.2V5.4a1.6 1.6 0 0 1 1.6-1.6h2a1.6 1.6 0 0 1 1.6 1.6v1.8"/><path d="M6.6 7.2 7.4 19a1.8 1.8 0 0 0 1.8 1.7h5.6A1.8 1.8 0 0 0 16.6 19l.8-11.8"/>',
  book: '<path d="M4.4 5.4A2.4 2.4 0 0 1 6.8 3H19.6v14.4H6.8a2.4 2.4 0 0 0-2.4 2.4z"/><path d="M4.4 19.8a2.4 2.4 0 0 1 2.4-2.4h12.8v3.2H6.8a2.4 2.4 0 0 1-2.4-2.4z"/><path d="M8.6 7.6h7"/><path d="M8.6 10.8h4.6"/>',
  medic: '<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="5"/><path d="M12 8.2v7.6"/><path d="M8.2 12h7.6"/>',
  cert: '<rect x="4.4" y="3.4" width="15.2" height="12.4" rx="2.2"/><path d="M8.2 7.8h7.6"/><path d="M8.2 11.4h4.8"/><path d="m9 15.8-1 4.8 4-2 4 2-1-4.8"/>',
  shield: '<path d="M12 3.2 4.9 6v6.1c0 4.3 3 7.4 7.1 8.7 4.1-1.3 7.1-4.4 7.1-8.7V6z"/><path d="m9 12 2.2 2.2 4.2-4.4"/>',
  heart: '<path d="M20.3 8.7a4.5 4.5 0 0 0-8.3-2.6 4.5 4.5 0 0 0-8.3 2.6c0 4.3 5.3 7.6 8.3 10.3 3-2.7 8.3-6 8.3-10.3z"/><path d="M6.6 12.2h2.8l1.5-2.2 1.9 3.9 1.4-1.9h3.2"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3.4v2.2"/><path d="M12 18.4v2.2"/><path d="M3.4 12h2.2"/><path d="M18.4 12h2.2"/><path d="m6 6 1.6 1.6"/><path d="M16.4 16.4 18 18"/><path d="m18 6-1.6 1.6"/><path d="M7.6 16.4 6 18"/>',
  moon: '<path d="M20.6 13.2A8.4 8.4 0 1 1 10.8 3.4a6.6 6.6 0 0 0 9.8 9.8z"/>',
  truck: '<path d="M2.8 6.4h10.6v9.8H2.8z"/><path d="M13.4 9.6h3.6l3.2 3.2v3.4h-6.8z"/><circle cx="7" cy="17.8" r="1.9"/><circle cx="16.9" cy="17.8" r="1.9"/><path d="M4.7 17.8H5.1"/><path d="M8.9 17.8h6.1"/>',
  brain: '<path d="M9.6 4.6a2.7 2.7 0 0 0-2.7 2.7 2.5 2.5 0 0 0-1.7 4.4 2.6 2.6 0 0 0 1.1 4.4 2.6 2.6 0 0 0 3.3 2.5"/><path d="M14.4 4.6a2.7 2.7 0 0 1 2.7 2.7 2.5 2.5 0 0 1 1.7 4.4 2.6 2.6 0 0 1-1.1 4.4 2.6 2.6 0 0 1-3.3 2.5"/><path d="M12 4.7v14.7"/>',
  gift: '<rect x="3.6" y="9.6" width="16.8" height="10.8" rx="1.8"/><path d="M3.6 13.6h16.8"/><path d="M12 9.6v10.8"/><path d="M12 9.6c-2.7 0-4.5-1-4.5-2.7S9.3 4.3 12 9.6z"/><path d="M12 9.6c2.7 0 4.5-1 4.5-2.7S14.7 4.3 12 9.6z"/>',
  plus: '<path d="M12 5.2v13.6"/><path d="M5.2 12h13.6"/>',
  back: '<path d="M19 12H5.4"/><path d="m11.2 6-6 6 6 6"/>',
  grip: '<circle cx="9" cy="5" r="1.6"/><circle cx="15" cy="5" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="19" r="1.6"/><circle cx="15" cy="19" r="1.6"/>',
  clip: '<rect x="5.4" y="4.2" width="13.2" height="16.8" rx="2.4"/><path d="M9 3.6h6"/><path d="M9 2.6h6"/><path d="m9.4 12.2 1.9 1.9 3.4-3.6"/>',
  pencil: '<path d="M4.4 19.6h4.1L20 8.1a2.1 2.1 0 0 0-3-3L5.5 16.6z"/><path d="M14.8 5.3l3 3"/>'
};

function svgIcon(name, cls) {
  const body = ICONS[name] || ICONS.chart;
  return `<svg class="ico${cls ? ' ' + cls : ''}" data-i="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const CATEGORY_ICONS = {
  'Отдел ИП': 'book',
  'Ассистент ИП': 'medic',
  'Лицензёр': 'cert',
  'Отдел АБ': 'shield',
  'Отдел МК': 'heart',
  'Отдел СШ': 'sun',
  'Отдел ОП': 'truck',
  'Психолог': 'brain',
  'Доп Балы': 'gift'
};

function iconForCategory(cat) {
  return CATEGORY_ICONS[removeEmojis(cat)] || 'plus';
}

function hydrateIcons(root) {
  const scope = root || document;
  if (!scope || !scope.querySelectorAll) return;
  const isIco = c => (c.localName || c.tagName || '').toLowerCase() === 'svg' && c.classList && c.classList.contains('ico');
  scope.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    const direct = [...el.children].filter(isIco);
    if (direct.length === 1 && direct[0].getAttribute('data-i') === name) {
      el._iconDone = name;
      return;
    }
    const tmp = document.createElement('div');
    tmp.innerHTML = el.innerHTML;
    [...tmp.children].filter(isIco).forEach(n => n.remove());
    el.innerHTML = svgIcon(name) + tmp.innerHTML;
    el._iconDone = name;
  });
}

/* Округление баллов до 2 знаков (плавающая точка) */
function round2(n) {
  const v = Number(n);
  if (!isFinite(v)) return 0;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function fmtPoints(n) {
  const v = round2(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '').replace(/\.$/, '');
}


/* ================= Утилиты ================= */

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

function getDeclension(number, one, two, five) {
  let n = Math.abs(number) % 100;
  if (n >= 5 && n <= 20) return `${number} ${five}`;
  n %= 10;
  if (n === 1) return `${number} ${one}`;
  if (n >= 2 && n <= 4) return `${number} ${two}`;
  return `${number} ${five}`;
}

function extractFirstEmoji(str) {
  if (!str) return null;
  const m = String(str).match(/\p{Emoji}/u);
  return m ? m[0] : null;
}

function removeEmojis(str) {
  return str ? String(str).replace(/\p{Emoji}/gu, '').trim() : '';
}

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function ruDate(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  return v;
}

function showLoading(text) {
  const lt = $('loadingTitle'); if (lt) lt.textContent = text || 'Загружаем…';
  $('loadingOverlay').classList.add('active');
}
function hideLoading() { $('loadingOverlay').classList.remove('active'); }

function finishEntryLoading() {
  const o = $('loadingOverlay');
  if (!o || !o.classList.contains('active')) return;
  const start = window.__EMS_START || Date.now();
  const wait = Math.max(0, 900 - (Date.now() - start));
  setTimeout(() => {
    const t = $('loadingTitle'); if (t) t.textContent = 'Готово';
    o.classList.add('ready');
    setTimeout(() => { o.classList.remove('active', 'ready'); }, 420);
  }, wait);
}

/* Плавный счётчик баллов (поддержка дробных значений) */
function setNumber(el, value) {
  const target = round2(value);
  const from = round2(parseFloat(el.dataset.val || '0') || 0);
  el.dataset.val = target;
  if (from === target || typeof requestAnimationFrame !== 'function') { el.textContent = fmtPoints(target); return; }
  cancelAnimationFrame(el._raf);
  const start = performance.now();
  const duration = 550;
  const step = now => {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmtPoints(from + (target - from) * eased);
    if (p < 1) el._raf = requestAnimationFrame(step);
    else el.textContent = fmtPoints(target);
  };
  el._raf = requestAnimationFrame(step);
}

/* Параллакс фона: сферы + прожектор за курсором */
function initParallax() {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const orbs = [...document.querySelectorAll('.orb')];
  let targetX = window.innerWidth / 2;
  let targetY = window.innerHeight * 0.2;
  let curX = targetX;
  let curY = targetY;

  document.addEventListener('mousemove', e => {
    targetX = e.clientX;
    targetY = e.clientY;
    document.documentElement.style.setProperty('--mx', e.clientX + 'px');
    document.documentElement.style.setProperty('--my', e.clientY + 'px');
  });

  if (reduced || typeof requestAnimationFrame !== 'function') return;

  (function loop() {
    curX += (targetX - curX) * 0.05;
    curY += (targetY - curY) * 0.05;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    orbs.forEach(orb => {
      const depth = (Number(orb.dataset.depth) || 20) / 100;
      orb.style.transform = `translate3d(${((curX - cx) * depth).toFixed(2)}px, ${((curY - cy) * depth).toFixed(2)}px, 0)`;
    });
    requestAnimationFrame(loop);
  })();
}

/* ================= Тосты ================= */

function toast(title, message, type) {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.innerHTML =
    `<div class="t-icon">${type === 'error' ? svgIcon('alert') : svgIcon('check')}</div>` +
    `<div class="t-body"><div class="t-title">${escapeHtml(title)}</div>` +
    (message ? `<div class="t-msg">${escapeHtml(message)}</div>` : '') + `</div>`;
  $('toastStack').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, 4200);
}

function showFormError(formType, message) {
  const box = $('errorMsg' + formPrefix(formType));
  box.innerHTML = message;
  box.classList.add('show');
  if (box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  clearTimeout(box._t);
  /* Блок с кнопкой «Повторить отправку» не прячем — иначе не успеть нажать. */
  if (!/err-retry/.test(message)) {
    box._t = setTimeout(() => box.classList.remove('show'), 7000);
  }
}

/* ================= Применение конфигурации ================= */

function applyConfig() {
  $('weeklyTitle').innerHTML = svgIcon('chart') + `<span>${escapeHtml(CONFIG.weeklyTitle || 'Еженедельный отчёт')}</span>`;
  $('promotionTitle').innerHTML = svgIcon('star') + `<span>${escapeHtml(CONFIG.promotionTitle || 'Отчёт на повышение')}</span>`;
  $('nightTitle').innerHTML = svgIcon('moon') + `<span>${escapeHtml(CONFIG.nightTitle || 'Ночная активность')}</span>`;
  $('statTitle').innerHTML = svgIcon('clip') + `<span>${escapeHtml(CONFIG.statTitle || 'Запись на стажировку')}</span>`;
  $('internTitle').innerHTML = svgIcon('cert') + `<span>${escapeHtml(removeEmojis(CONFIG.internTitle) || 'Отчёт о стажировке')}</span>`;
  $('unfitTitle').innerHTML = svgIcon('alert') + `<span>${escapeHtml(removeEmojis(CONFIG.unfitTitle) || 'Профнепригодность')}</span>`;

    $('menuTitleWeekly').textContent = removeEmojis(CONFIG.weeklyTitle) || 'Еженедельный отчёт';
    $('menuTitlePromotion').textContent = removeEmojis(CONFIG.promotionTitle) || 'Отчёт на повышение';
    $('menuTitleNight').textContent = removeEmojis(CONFIG.nightTitle) || 'Ночная активность';
    $('menuTitleStat').textContent = removeEmojis(CONFIG.statTitle) || 'Запись на стажировку';
    $('menuTitleQuiz').textContent = removeEmojis(CONFIG.quizTitle) || 'Вопросы для стажировки';
    $('menuTitleIntern').textContent = removeEmojis(CONFIG.internTitle) || 'Отчёт о стажировке';
    $('menuTitleUnfit').textContent = removeEmojis(CONFIG.unfitTitle) || 'Профнепригодность';

    hydrateIcons();

    renderRules('weeklyRulesContainer', CONFIG.weeklyRules);
    renderRules('promotionRulesContainer', CONFIG.promotionRules);
    renderRules('nightRulesContainer', CONFIG.nightRules);
    renderRules('statRulesContainer', CONFIG.statRules);
    renderRules('internRulesContainer', CONFIG.internRules);
    renderRules('unfitRulesContainer', CONFIG.unfitRules);
    renderPhotoBar('photoBarWeekly', CONFIG.photoHosts);
    renderPhotoBar('photoBarPromotion', CONFIG.photoHosts);
    renderPhotoBar('photoBarNight', CONFIG.photoHosts);
    renderBanner('bannerWeeklyContainer', CONFIG.bannerWeekly);
    renderBanner('bannerPromotionContainer', CONFIG.bannerPromotion);
    renderBanner('bannerNightContainer', CONFIG.bannerNight);
    renderBanner('bannerStatContainer', CONFIG.bannerStat);
    renderBanner('bannerInternContainer', CONFIG.bannerIntern);
    renderBanner('bannerUnfitContainer', CONFIG.bannerUnfit);

    updateMenuVisibility();
    updateDeliveryChip();
    finishEntryLoading();
}

function updateMenuVisibility() {
  const unlocked = adminUnlocked || editorUnlocked;
  const q = $('selectQuiz');
  const i = $('selectIntern');
  const u = $('selectUnfit');
  if (q) q.classList.toggle('hidden', !unlocked);
  if (i) i.classList.toggle('hidden', !unlocked);
  if (u) u.classList.toggle('hidden', !unlocked);
  const p = $('selectPremium');
  if (p) p.classList.toggle('hidden', !adminUnlocked);
  /* Блок 09 «Наборы» — только старший состав; редактирование текста и ролей — в админке. */
  const a = $('selectAnnounce');
  if (a) a.classList.toggle('hidden', !adminUnlocked);
  /* Блок 10 «Результаты наборов» — только СС. */
  const s = $('selectSets');
  if (s) s.classList.toggle('hidden', !adminUnlocked);
}

function renderRules(id, rules) {
  const box = $(id);
  if (!rules || !rules.length) { box.classList.add('hidden'); return; }
  box.innerHTML = '<div class="rules-title">Правила заполнения</div>' +
    rules.map(r => `<div class="rule-item"><div class="rule-dot"></div><div>${escapeHtml(r)}</div></div>`).join('');
  box.classList.remove('hidden');
}

function renderPhotoBar(id, hosts) {
  const box = $(id);
  if (!hosts || !hosts.length) { box.classList.add('hidden'); return; }
  box.innerHTML =
    '<div class="photobar-label">Фотохостинги</div><div class="photobar-links">' +
    hosts.map(h => {
      const url = (h.url || '').trim();
      const label = escapeHtml(h.name);
      return url
        ? `<a class="ph-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${label}</a>`
        : `<span class="ph-link muted" title="URL не задан — укажите его в админ-панели">${label}</span>`;
    }).join('') +
    '</div>';
  box.classList.remove('hidden');
}

function detectBannerType(url) {
  const u = String(url || '').trim().toLowerCase();
  if (!u) return 'image';
  if (u.startsWith('data:image/gif')) return 'gif';
  if (u.startsWith('data:video')) return 'video';
  if (u.startsWith('data:')) return 'image';
  if (/(?:youtube\.com\/(?:watch\?|shorts\/|embed\/|live\/)|youtu\.be\/)/.test(u)) return 'youtube';
  if (/\.(?:mp4|webm|ogv|ogg|mov|m4v)(?:\?|$)/.test(u)) return 'video';
  if (/\.(?:gif|gifv)(?:\?|$)/.test(u)) return 'gif';
  return 'image';
}

function youtubeId(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : '';
}

function bannerType(banner) {
  const t = (banner && banner.type) || 'auto';
  return t === 'auto' ? detectBannerType(banner && banner.url) : t;
}

function bannerMarkup(banner, opts) {
  const o = opts || {};
  const url = String((banner && banner.url) || '').trim();
  if (!url) return '';
  const esc = escapeHtml;
  const type = bannerType(banner);

  if (type === 'youtube') {
    const id = youtubeId(url);
    if (id) {
      return `<div class="banner-embed"><iframe src="https://www.youtube-nocookie.com/embed/${esc(id)}?rel=0&modestbranding=1" title="Баннер" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`;
    }
    return `<div class="banner-fallback">Не удалось распознать видео YouTube: ${esc(url)}</div>`;
  }

  if (type === 'video') {
    return `<video class="banner-video" src="${esc(url)}" ${o.controls ? 'controls' : 'autoplay'} muted loop playsinline preload="metadata"></video>`;
  }

  return `<img src="${esc(url)}" alt="Баннер" loading="lazy">`;
}

function renderBanner(id, banner) {
  const box = $(id);
  if (banner && banner.visible && banner.url && banner.url.trim()) {
    box.innerHTML = `<div class="banner-box">${bannerMarkup(banner)}</div>`;
    box.classList.remove('hidden');
  } else {
    box.innerHTML = '';
    box.classList.add('hidden');
  }
}

function updateDeliveryChip() {
  const chip = $('deliveryChip');
  if (!chip) return;
  if (webhookStatus.length) {
    chip.textContent = 'Discord подключён';
    chip.classList.add('live');
  } else {
    chip.textContent = 'Локальное сохранение';
    chip.classList.remove('live');
  }
}

let gsheetConfigured = false;

async function fetchWebhookStatus() {
  try {
    const res = await apiFetch('/api/webhook', { method: 'GET' });
    const j = await res.json().catch(() => null);
    webhookStatus = (j && Array.isArray(j.configured)) ? j.configured : [];
    gsheetConfigured = !!(j && j.gsheetConfigured);
  } catch (e) {
    webhookStatus = [];
    gsheetConfigured = false;
  }
  updateDeliveryChip();
}

/* ================= Навигация ================= */

function showScreen(name) {
  if (name === 'premium' && !adminUnlocked) return;
  if (name === 'sets' && !adminUnlocked) return;
  state.form = name;
  $('menuScreen').classList.toggle('hidden', name !== 'menu');
  $('weeklyForm').classList.toggle('hidden', name !== 'weekly');
  $('promotionForm').classList.toggle('hidden', name !== 'promotion');
  $('nightForm').classList.toggle('hidden', name !== 'night');
  $('statForm').classList.toggle('hidden', name !== 'stat');
  $('quizForm').classList.toggle('hidden', name !== 'quiz');
  $('internForm').classList.toggle('hidden', name !== 'intern');
  $('unfitForm').classList.toggle('hidden', name !== 'unfit');
  $('premiumForm').classList.toggle('hidden', name !== 'premium');
  if ($('announceForm')) $('announceForm').classList.toggle('hidden', name !== 'announce');
  if ($('setsForm')) $('setsForm').classList.toggle('hidden', name !== 'sets');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'weekly') { setCurrentWeek('weekly'); renderCalendar('weekly'); }
  if (name === 'night') { setCurrentWeek('night'); renderCalendar('night'); }
  if (name === 'promotion') toggleConditionalFields();
  if (name === 'quiz') renderQuiz();
  if (name === 'premium') renderPremium();
  if (name === 'announce') renderAdminAnnounce();
  if (name === 'sets') renderSetsForm();
}

/* ================= Календарь ================= */

function openPicker(formType, open) {
  const ft = formType === 'night' ? 'night' : 'weekly';
  const p = formPrefix(ft);
  const picker = $('datePicker' + p);
  const card = picker.closest('.card');
  picker.classList.toggle('active', open);
  if (card) card.classList.toggle('picker-open', open);
  if (!open) {
    picker.classList.remove('up');
    return;
  }
  renderCalendar(ft);
  picker.classList.remove('up');
  const fr = $('periodInput' + p).getBoundingClientRect();
  if (fr.bottom + 12 + picker.offsetHeight > window.innerHeight - 8) picker.classList.add('up');
}

function initPeriodSelector(formType) {
  const ft = formType === 'night' ? 'night' : 'weekly';
  const p = formPrefix(ft);
  $('periodInput' + p).addEventListener('click', e => {
    e.stopPropagation();
    openPicker(ft, !$('datePicker' + p).classList.contains('active'));
  });
  document.addEventListener('click', e => {
    const picker = $('datePicker' + p);
    if (!picker.contains(e.target) && e.target !== $('periodInput' + p)) openPicker(ft, false);
  });
}

function renderCalendar(formType) {
  const ft = formType === 'night' ? 'night' : 'weekly';
  const p = formPrefix(ft);
  const ps = periodFor(ft);
  const cal = $('calendar' + p);
  if (!cal) return;
  const year = ps.calMonth.getFullYear();
  const month = ps.calMonth.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const monthLabel = first.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

  const status = !ps.start
    ? 'Выберите первую дату — начало периода'
    : !ps.end
      ? `Начало: <b>${ps.start.toLocaleDateString('ru-RU')}</b> — теперь выберите конец`
      : `Период: <b>${ps.start.toLocaleDateString('ru-RU')} — ${ps.end.toLocaleDateString('ru-RU')}</b>`;

  let html = `<div class="cal-head">
      <button class="cal-nav" data-nav="-1">←</button>
      <span class="cal-title">${monthLabel}</span>
      <button class="cal-nav" data-nav="1">→</button>
    </div>
    <div class="cal-status">${status}</div>
    <div class="cal-grid">`;

  ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].forEach(d => html += `<div class="cal-wd">${d}</div>`);

  const offset = first.getDay() === 0 ? 6 : first.getDay() - 1;
  const prevDays = new Date(year, month, 0).getDate();

  for (let i = offset; i > 0; i--) {
    const day = prevDays - i + 1;
    html += dayCell(day, year, month - 1, ft);
  }
  for (let d = 1; d <= last.getDate(); d++) html += dayCell(d, year, month, ft);
  const rest = 42 - (offset + last.getDate());
  for (let i = 1; i <= rest; i++) html += dayCell(i, year, month + 1, ft);

  html += '</div>';
  cal.innerHTML = html;

  cal.querySelectorAll('.cal-nav').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      ps.calMonth.setMonth(ps.calMonth.getMonth() + Number(btn.dataset.nav));
      renderCalendar(ft);
    };
  });
  cal.querySelectorAll('.cal-day').forEach(cell => {
    cell.onclick = e => {
      e.stopPropagation();
      pickDate(ft, Number(cell.dataset.year), Number(cell.dataset.month), Number(cell.dataset.day));
    };
    cell.addEventListener('mouseenter', () => {
      if (!ps.start || ps.end) return;
      const d = new Date(Number(cell.dataset.year), Number(cell.dataset.month), Number(cell.dataset.day));
      d.setHours(0, 0, 0, 0);
      if (ps.hover && d.getTime() === ps.hover.getTime()) return;
      ps.hover = d;
      refreshCalClasses(ft);
    });
  });
  const calBox = cal;
  if (!calBox._hoverBound) {
    calBox._hoverBound = true;
    calBox.addEventListener('mouseleave', () => {
      if (!ps.hover) return;
      ps.hover = null;
      refreshCalClasses(ft);
    });
  }
}

function refreshCalClasses(formType) {
  const ft = formType === 'night' ? 'night' : 'weekly';
  const p = formPrefix(ft);
  const cal = $('calendar' + p);
  if (!cal) return;
  cal.querySelectorAll('.cal-day').forEach(c => {
    const d = new Date(Number(c.dataset.year), Number(c.dataset.month), Number(c.dataset.day));
    d.setHours(0, 0, 0, 0);
    c.className = 'cal-day ' + dateClass(ft, d);
  });
}

function dayCell(day, year, month, formType) {
  const date = new Date(year, month, day);
  const cls = dateClass(formType, date);
  return `<div class="cal-day ${cls}" data-year="${year}" data-month="${month}" data-day="${day}">${day}</div>`;
}

function dateClass(formType, date) {
  const ft = formType === 'night' ? 'night' : 'weekly';
  const ps = periodFor(ft);
  if (!ps.start && !ps.end) return '';
  const key = formatDate(date);

  if (ps.start && !ps.end && ps.hover) {
    const lo = ps.hover < ps.start ? ps.hover : ps.start;
    const hi = ps.hover < ps.start ? ps.start : ps.hover;
    if (key === formatDate(ps.start)) return ps.hover.getTime() === ps.start.getTime() ? 'single' : 'start';
    if (key === formatDate(ps.hover)) return 'end';
    if (date > lo && date < hi) return 'range';
    return '';
  }

  if (ps.start && key === formatDate(ps.start)) {
    return ps.end ? 'start' : 'single';
  }
  if (ps.end && key === formatDate(ps.end)) return 'end';
  if (ps.start && ps.end && date > ps.start && date < ps.end) return 'range';
  return '';
}

function pickDate(formType, year, month, day) {
  const ft = formType === 'night' ? 'night' : 'weekly';
  const ps = periodFor(ft);
  const date = new Date(year, month, day);
  date.setHours(0, 0, 0, 0);
  ps.hover = null;

  if (!ps.start || (ps.start && ps.end)) {
    ps.start = date;
    ps.end = null;
  } else {
    if (date.getTime() === ps.start.getTime()) {
      ps.start = null;
      ps.end = null;
      toast('Нельзя выбрать одинаковые даты', 'Начало и конец периода должны отличаться', 'error');
    } else if (date < ps.start) {
      ps.end = ps.start;
      ps.start = date;
    } else {
      ps.end = date;
    }
    openPicker(ft, false);
  }
  updatePeriodDisplay(ft);
  renderCalendar(ft);
}

function setCurrentWeek(formType) {
  const ft = formType === 'night' ? 'night' : 'weekly';
  const ps = periodFor(ft);
  const p = formPrefix(ft);
  const now = new Date();
  const msk = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const dow = msk.getDay();
  const toMonday = dow === 0 ? 6 : dow - 1;
  ps.hover = null;
  ps.start = new Date(msk);
  ps.start.setDate(msk.getDate() - toMonday);
  ps.start.setHours(0, 0, 0, 0);
  ps.end = new Date(ps.start);
  ps.end.setDate(ps.start.getDate() + 6);
  ps.end.setHours(0, 0, 0, 0);
  ps.calMonth = new Date(ps.start);
  updatePeriodDisplay(ft);
}

function clearPeriod(formType) {
  const ft = formType === 'night' ? 'night' : 'weekly';
  const ps = periodFor(ft);
  ps.start = null;
  ps.end = null;
  ps.hover = null;
  updatePeriodDisplay(ft);
  renderCalendar(ft);
}

function updatePeriodDisplay(formType) {
  const ft = formType === 'night' ? 'night' : 'weekly';
  const ps = periodFor(ft);
  const el = $('periodInput' + formPrefix(ft));
  if (ps.start && ps.end) {
    el.value = `${ps.start.toLocaleDateString('ru-RU')} — ${ps.end.toLocaleDateString('ru-RU')}`;
    el.classList.remove('partial');
    el.placeholder = 'Выберите период';
  } else if (ps.start) {
    el.value = `${ps.start.toLocaleDateString('ru-RU')} — выберите конец`;
    el.classList.add('partial');
  } else {
    el.value = '';
    el.classList.remove('partial');
    el.placeholder = 'Выберите период';
  }
}

/* ================= Ранги ================= */

function renderRanks() {
  const ranks = ['4 → 5', '5 → 6', '6 → 7', '7 → 8', '8 → 9', '9 → 10'];
  const box = $('ranksContainer');
  box.innerHTML = '';
  ranks.forEach(r => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rank-btn' + (state.rank === r ? ' active' : '');
    btn.textContent = r;
    btn.onclick = () => {
      state.rank = r;
      $('rankSelect').value = r;
      box.querySelectorAll('.rank-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      box.classList.remove('err');
      toggleConditionalFields();
    };
    box.appendChild(btn);
  });
}

function toggleConditionalFields() {
  const rank = $('rankSelect').value;
  $('examMedField').classList.toggle('hidden', rank !== '5 → 6');
  $('examAspField').classList.toggle('hidden', rank !== '4 → 5');
  $('testPromotionField').classList.toggle('hidden', rank === '4 → 5');
}

/* ================= Пункты / баллы ================= */

const ALWAYS_FORM_KEYS = ['weekly', 'promotion', 'night'];
const ALWAYS_FORM_LABEL = { weekly: 'еженедельный отчёт', promotion: 'повышение', night: 'ночная активность' };
const ALWAYS_FORM_SHORT = { weekly: 'еженеделька', promotion: 'повышение', night: 'ночная' };
const ALWAYS_FORM_COLOR = { weekly: '#ffd88a', promotion: '#c78bff', night: '#5ad1ff' };

function formKindName(t) {
  return t === 'weekly' ? 'Еженедельный отчёт' : (t === 'night' ? 'Ночная активность' : 'Отчёт на повышение');
}

function alwaysVisibleFor(cfg, formType) {
  return (cfg && cfg.alwaysVisibleForm && cfg.alwaysVisibleForm[formType]) || [];
}

function ensureAlwaysForm(cfg) {
  if (!cfg.alwaysVisibleForm || typeof cfg.alwaysVisibleForm !== 'object') cfg.alwaysVisibleForm = {};
  ALWAYS_FORM_KEYS.forEach(f => {
    if (!Array.isArray(cfg.alwaysVisibleForm[f])) cfg.alwaysVisibleForm[f] = [];
  });
  return cfg.alwaysVisibleForm;
}

function removeAlwaysFromAll(cfg, name) {
  ensureAlwaysForm(cfg);
  ALWAYS_FORM_KEYS.forEach(f => {
    cfg.alwaysVisibleForm[f] = cfg.alwaysVisibleForm[f].filter(i => i !== name);
  });
}

function isAlwaysVisibleAnywhere(cfg, name) {
  return ALWAYS_FORM_KEYS.some(f => alwaysVisibleFor(cfg, f).includes(name));
}

function rateFor(formType, name) {
  const r = CONFIG.points[name] || 0;
  return formType === 'night' ? round2(r * 2) : r;
}

function stdValues(formType) {
  return state.std[formType];
}

function extras(formType) {
  return state.extras[formType];
}

function renderActions(formType) {
  const box = $('actionsList' + formPrefix(formType));
  box.innerHTML = '';
  alwaysVisibleFor(CONFIG, formType).forEach(name => {
    if (CONFIG.points[name] !== undefined) addCard(box, name, true, null, formType);
  });
  extras(formType).forEach(item => addCard(box, item.name, false, item.id, formType));
}

function addCard(box, name, isStandard, id, formType) {
  const rate = rateFor(formType, name);
  const store = stdValues(formType);
  let link = '', count = 0;

  if (isStandard) {
    store[name] = store[name] || { link: '', count: 0, points: 0 };
    link = store[name].link;
    count = store[name].count;
  } else {
    const item = extras(formType).find(i => i.id === id);
    if (item) { link = item.link; count = item.count; }
  }

  const shot = formType === 'night'
    ? (isStandard ? ((store[name] && store[name].imageData) || '') : (((extras(formType).find(i => i.id === id) || {}).imageData) || ''))
    : '';
  const linkLabel = formType === 'night' ? 'Ссылка / скриншот (Ctrl+V)' : 'Ссылка';

  const card = document.createElement('div');
  card.className = 'action-card';
  card.id = `card_${isStandard ? name : id}_${formType}`;
  card.innerHTML = `
    <div class="action-head">
      <div class="action-name">${escapeHtml(name)}</div>
      <div class="action-rate">${fmtPoints(rate)} балл(ов) за единицу</div>
    </div>
    <div class="action-grid">
      <div class="fgroup">
        <label>${linkLabel}</label>
        <textarea class="action-link" rows="2" placeholder="https://">${escapeHtml(link)}</textarea>
      </div>
      <div class="fgroup">
        <label>Количество</label>
        <input type="number" class="action-count count" min="0" step="0.1" inputmode="decimal" placeholder="0" value="${count || ''}">
      </div>
      <div class="fgroup">
        <label>Баллы</label>
        <input type="text" class="action-points" readonly value="${fmtPoints(count * rate)}">
      </div>
      ${isStandard ? '<div></div>' : '<button type="button" class="remove-btn" title="Удалить пункт" data-icon="close"></button>'}
    </div>
    ${shot ? `<div class="action-shot">
      <img src="${shot}" alt="Скриншот пункта">
      <button type="button" class="shot-del" title="Убрать скриншот" data-icon="close"></button>
    </div>` : ''}`;

  box.appendChild(card);
  hydrateIcons(card);

  const linkEl = card.querySelector('.action-link');
  const countEl = card.querySelector('.action-count');

  linkEl.addEventListener('input', () => {
    linkEl.classList.remove('err-field');
    setField(formType, isStandard, name, id, 'link', linkEl.value);
  });
  countEl.addEventListener('input', () => {
    countEl.classList.remove('err-field');
    setField(formType, isStandard, name, id, 'count', countEl.value);
  });

  if (formType === 'night') {
    linkEl.addEventListener('paste', e => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.type && it.type.indexOf('image') === 0) {
          e.preventDefault();
          const f = it.getAsFile();
          if (f) handleActionShot(formType, isStandard, name, id, f);
          return;
        }
      }
    });
  }

  const shotDel = card.querySelector('.shot-del');
  if (shotDel) {
    shotDel.onclick = () => {
      if (isStandard) { const t = stdValues(formType)[name]; if (t) t.imageData = ''; }
      else { const t = extras(formType).find(i => i.id === id); if (t) t.imageData = ''; }
      renderActions(formType);
    };
  }

  if (!isStandard) {
    card.querySelector('.remove-btn').onclick = () => {
      state.extras[formType] = extras(formType).filter(i => i.id !== id);
      renderActions(formType);
      updatePoints(formType);
    };
  }
}

function setField(formType, isStandard, name, id, field, value) {
  const rate = rateFor(formType, name);
  let target;

  if (isStandard) {
    const store = stdValues(formType);
    store[name] = store[name] || { link: '', count: 0, points: 0 };
    target = store[name];
  } else {
    target = extras(formType).find(i => i.id === id);
    if (!target) return;
  }

  if (field === 'link') target.link = value;
  if (field === 'count') {
    target.count = round2(parseFloat(value) || 0);
    target.points = round2(target.count * rate);
    const card = document.getElementById(`card_${isStandard ? name : id}_${formType}`);
    if (card) card.querySelector('.action-points').value = fmtPoints(target.points);
  }
  updatePoints(formType);
}

function updatePoints(formType) {
  const store = stdValues(formType);
  let total = 0;
  const breakdown = [];

  alwaysVisibleFor(CONFIG, formType).forEach(name => {
    const v = store[name];
    if (v && v.count > 0) {
      total = round2(total + v.points);
      breakdown.push({ name, points: v.points });
    }
  });
  extras(formType).forEach(item => {
    if (item.count > 0 && item.points > 0) {
      total = round2(total + item.points);
      breakdown.push({ name: item.name, points: item.points });
    }
  });

  const prefix = formPrefix(formType);
  setNumber($(`totalPoints${prefix}`), total);
  $(`pointsBreakdown${prefix}`).innerHTML = breakdown.length
    ? breakdown.map(b => `<span class="badge">${escapeHtml(b.name)} <b>+${fmtPoints(b.points)}</b></span>`).join('')
    : '<span class="badge">Нет данных</span>';
}

/* ================= Модалка выбора пункта ================= */

function openActModal() {
  $('actSearch').value = '';
  renderActModal('');
  $('actModal').classList.add('active');
  document.body.classList.add('modal-open');
  setTimeout(() => $('actSearch').focus(), 60);
}

function closeActModal() {
  $('actModal').classList.remove('active');
  document.body.classList.remove('modal-open');
}

function renderActModal(query) {
  const formType = state.form;
  const body = $('actModalBody');
  const q = (query || '').trim().toLowerCase();
  body.innerHTML = '';
  let found = 0;

  CONFIG.categoryOrder.forEach(category => {
    const items = (CONFIG.categories[category] || []).filter(item => {
      if (extras(formType).some(i => i.name === item)) return false;
      if (alwaysVisibleFor(CONFIG, formType).includes(item)) return false;
      if (CONFIG.points[item] === undefined) return false;
      if (q && !item.toLowerCase().includes(q)) return false;
      return true;
    });
    if (!items.length) return;
    found += items.length;

    const color = CONFIG.categoryColors[category] || '#b6e04d';
    const block = document.createElement('div');
    block.className = 'act-category';
    block.innerHTML = `<div class="act-category-title" style="color:${color};border-color:${color}">${svgIcon(iconForCategory(category))}<span>${escapeHtml(category)}</span></div>
<div class="act-items"></div>`;
    const grid = block.querySelector('.act-items');

    items.forEach(item => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'act-item';
      btn.innerHTML = `<span>${escapeHtml(item)}</span><span class="pts">+${fmtPoints(rateFor(formType, item))}</span>`;
      btn.onclick = () => {
        state.extras[formType].push({ id: Date.now(), name: item, link: '', count: 0, points: 0 });
        renderActions(formType);
        updatePoints(formType);
        closeActModal();
      };
      grid.appendChild(btn);
    });
    body.appendChild(block);
  });

  if (!found) body.innerHTML = '<div class="act-empty">Нет доступных пунктов — они уже добавлены или не настроены в админке.</div>';
}

/* ================= Валидация ================= */

function validateActions(formType) {
  const errors = [];

  alwaysVisibleFor(CONFIG, formType).forEach(name => {
    const card = document.getElementById(`card_${name}_${formType}`);
    if (!card) return;
    const linkEl = card.querySelector('.action-link');
    const countEl = card.querySelector('.action-count');
    const link = linkEl.value.trim();
    const count = countEl.value;
    const stored = stdValues(formType)[name];
    const hasImage = formType === 'night' && !!(stored && stored.imageData);

    const linkBad = !link && !hasImage;
    const countBad = !count || round2(parseFloat(count) || 0) === 0;
    linkEl.classList.toggle('err-field', linkBad);
    countEl.classList.toggle('err-field', countBad);
    if (linkBad) errors.push(`В пункте «${name}» не заполнена ссылка`);
    if (countBad) errors.push(`В пункте «${name}» не заполнено количество`);
  });

  extras(formType).forEach(item => {
    const card = document.getElementById(`card_${item.id}_${formType}`);
    if (!card) return;
    const linkEl = card.querySelector('.action-link');
    const countEl = card.querySelector('.action-count');
    const link = linkEl.value.trim();
    const count = countEl.value;
    const hasImage = formType === 'night' && !!item.imageData;
    const hasLink = !!link || hasImage;
    const hasCount = !!count && round2(parseFloat(count) || 0) > 0;

    let bad = false;
    if (hasLink && !hasCount) { errors.push(`В пункте «${item.name}» заполнена ссылка, но не заполнено количество`); bad = true; }
    else if (!hasLink && hasCount) { errors.push(`В пункте «${item.name}» заполнено количество, но не заполнена ссылка`); bad = true; }
    else if (!hasLink && !hasCount) { errors.push(`В пункте «${item.name}» не заполнены ссылка и количество`); bad = true; }

    linkEl.classList.toggle('err-field', bad && !hasLink);
    countEl.classList.toggle('err-field', bad && !hasCount);
  });

  return errors;
}

function validateWeekly() {
  if (!$('fullNameWeekly').value.trim()) return ['Заполните имя и фамилию'];
  if (!periodFor('weekly').start || !periodFor('weekly').end) return ['Выберите период подачи отчёта'];
  return validateActions('weekly');
}

function validateNight() {
  if (!$('fullNameNight').value.trim()) return ['Заполните имя и фамилию'];
  if (!periodFor('night').start || !periodFor('night').end) return ['Выберите период подачи отчёта'];
  return validateActions('night');
}

function validatePromotion() {
  const errors = [];
  if (!$('fullNamePromotion').value.trim()) errors.push('Заполните имя и фамилию');

  const rank = $('rankSelect').value;
  if (!rank) {
    errors.push('Выберите повышение с ранга на ранг');
    $('ranksContainer').classList.add('err');
    setTimeout(() => $('ranksContainer').classList.remove('err'), 3000);
  }

  if (rank !== '4 → 5' && !$('testLinkPromotion').value.trim()) errors.push('Заполните ссылку на сдачу теста');
  if (rank === '5 → 6' && !$('examMedLink').value.trim()) errors.push('Заполните ссылку на экзамен Лицензию Мед.Карт');
  if (rank === '4 → 5' && !$('examAspLink').value.trim()) errors.push('Заполните ссылку на экзамен Лицензии АСМП');

  return errors.concat(validateActions('promotion'));
}

function validateStat() {
  const errors = [];
  if (!$('fullNameStat').value.trim()) {
    errors.push('Заполните имя и фамилию');
    textErr('fullNameStat', true);
  } else textErr('fullNameStat', false);
  const uid = $('userIdStat').value.trim();
  if (!uid) {
    errors.push('Укажите ID пользователя (Discord)');
    textErr('userIdStat', true);
  } else if (!/^\d{15,25}$/.test(uid)) {
    errors.push('ID пользователя должен состоять только из цифр');
    textErr('userIdStat', true);
  } else textErr('userIdStat', false);
  if (!$('attendanceLinkStat').value.trim()) {
    errors.push('Заполните ссылку на присутствие в наборе в EMS');
    textErr('attendanceLinkStat', true);
  } else if (!/^https?:\/\//i.test($('attendanceLinkStat').value.trim())) {
    errors.push('Ссылка на присутствие должна начинаться с http:// или https://');
    textErr('attendanceLinkStat', true);
  } else textErr('attendanceLinkStat', false);
  if (!$('prefTimeStat').value.trim()) {
    errors.push('Укажите удобное время прохождения стажировки');
    textErr('prefTimeStat', true);
  } else textErr('prefTimeStat', false);
  return errors;
}

function validateIntern() {
  const errors = [];
  const host = $('internHostId').value.trim();
  const taker = $('internTakerId').value.trim();
  const result = $('internResult').value;
  if (!/^\d{15,25}$/.test(host)) {
    errors.push('Укажите корректный Discord ID того, кто принимал');
    textErr('internHostId', true);
  } else textErr('internHostId', false);
  if (!/^\d{15,25}$/.test(taker)) {
    errors.push('Укажите корректный Discord ID того, кто сдавал');
    textErr('internTakerId', true);
  } else textErr('internTakerId', false);
  const toggle = $('internResultToggle');
  if (!result) {
    errors.push('Выберите результат стажировки');
    if (toggle) toggle.classList.add('err-field');
  } else if (toggle) toggle.classList.remove('err-field');
  return errors;
}

function validateUnfit() {
  const errors = [];
  const reporterId = $('unfitReporterId').value.trim();
  const id = $('unfitEmployeeId').value.trim();
  const name = $('unfitFullName').value.trim();
  const passport = $('unfitPassport').value.trim();
  const date = $('unfitLastPromo').value;
  const rank = $('unfitRank').value;
  const photoUrl = $('unfitPhotoUrl').value.trim();

  if (!/^\d{15,25}$/.test(reporterId)) { errors.push('Укажите корректный Discord ID того, кто отправляет'); textErr('unfitReporterId', true); }
  else textErr('unfitReporterId', false);
  if (!/^\d{15,25}$/.test(id)) { errors.push('Укажите корректный Discord ID сотрудника'); textErr('unfitEmployeeId', true); }
  else textErr('unfitEmployeeId', false);
  if (!name) { errors.push('Укажите ФИ сотрудника'); textErr('unfitFullName', true); }
  else textErr('unfitFullName', false);
  if (!passport) { errors.push('Укажите номер паспорта сотрудника'); textErr('unfitPassport', true); }
  else textErr('unfitPassport', false);
  if (!date) { errors.push('Укажите дату последнего повышения'); textErr('unfitLastPromo', true); }
  else textErr('unfitLastPromo', false);
  if (!rank) { errors.push('Выберите текущий ранг сотрудника'); textErr('unfitRankField', true); }
  else textErr('unfitRankField', false);
  if (!unfitPhotoData && !photoUrl) { errors.push('Прикрепите фото: ссылку или изображение через Ctrl+V'); textErr('unfitPhotoUrl', true); }
  else if (photoUrl && !unfitPhotoData && !/^https?:\/\/\S+$/i.test(photoUrl)) { errors.push('Ссылка на фото должна начинаться с http(s)://'); textErr('unfitPhotoUrl', true); }
  else textErr('unfitPhotoUrl', false);
  return errors;
}

function setInternResult(value) {
  const toggle = $('internResultToggle');
  const input = $('internResult');
  if (input) input.value = value || '';
  if (!toggle) return;
  toggle.dataset.value = value || '';
  toggle.querySelectorAll('.result-opt').forEach(btn => btn.classList.toggle('active', btn.dataset.value === value));
  if (value) toggle.classList.remove('err-field');
}

function initInternToggle() {
  const toggle = $('internResultToggle');
  if (!toggle) return;
  toggle.querySelectorAll('.result-opt').forEach(btn => {
    btn.onclick = () => setInternResult(btn.dataset.value);
  });
  setInternResult($('internResult') ? $('internResult').value : '');
}

function textErr(id, err) {
  const el = $(id);
  if (el) el.classList.toggle('err-field', !!err);
}

/* ================= Сбор и отправка ================= */

function collectItems(formType) {
  const store = stdValues(formType);
  const standard = [];
  alwaysVisibleFor(CONFIG, formType).forEach(name => {
    const v = store[name];
    if (v && v.count > 0) standard.push({ name, link: v.link, count: v.count, points: v.points, imageData: v.imageData || '' });
  });

  const extra = [];
  extras(formType).forEach(item => {
    const card = document.getElementById(`card_${item.id}_${formType}`);
    if (!card) return;
    const link = card.querySelector('.action-link').value.trim();
    const count = round2(parseFloat(card.querySelector('.action-count').value) || 0);
    if ((link || item.imageData) && count > 0) extra.push({ name: item.name, link, count, points: round2(rateFor(formType, item.name) * count), imageData: item.imageData || '' });
  });
  return { standard, extra };
}

function totalPoints(items) {
  return round2(items.standard.concat(items.extra).reduce((sum, i) => sum + i.points, 0));
}

/* Строка для Google-таблицы: колонки листа «Еженедельки» (кроме колонки «Еженеделька»,
   её администратор отмечает вручную). Сервер отправит её в веб-приложение Apps Script. */
const WEEKLY_SHEET_POINTS = [
  { key: 'exams', name: 'Провести осмотр' },
  { key: 'pmp', name: 'Оказать ПМП' },
  { key: 'drugs', name: 'Укол от наркозависимости' },
  { key: 'medCards', name: 'Выдача мед. карты' }
];

/* Три пункта про наборы в таблице идут одной суммой в колонку D. */
const WEEKLY_SET_ITEMS = [
  { key: 'setsBase', name: 'Участие в наборах граждан в ряды EMS' },
  { key: 'setsAnnulled', name: 'Участие в аннулированных наборах граждан в ряды EMS' },
  { key: 'setsNight', name: 'Участие в ночных наборах граждан в ряды EMS' }
];

function weeklySheetData(report) {
  const counts = {};
  WEEKLY_SHEET_POINTS.forEach(p => { counts[p.key] = 0; });
  WEEKLY_SET_ITEMS.forEach(p => { counts[p.key] = 0; });

  const allItems = (report.items.standard || []).concat(report.items.extra || []);
  const pick = name => allItems.filter(it => it.name === name);

  allItems.forEach(it => {
    const hit = WEEKLY_SHEET_POINTS.find(p => p.name === it.name);
    if (hit) counts[hit.key] = round2((counts[hit.key] || 0) + (Number(it.count) || 0));
  });

  let setsCount = 0;
  let setsPoints = 0;
  WEEKLY_SET_ITEMS.forEach(p => {
    const found = pick(p.name);
    const count = round2(found.reduce((sum, it) => sum + (Number(it.count) || 0), 0));
    const points = round2(found.reduce((sum, it) => {
      const own = Number(it.points);
      return sum + (Number.isFinite(own) ? own : (Number(it.count) || 0) * rateFor('weekly', p.name));
    }, 0));
    counts[p.key] = count;
    setsCount = round2(setsCount + count);
    setsPoints = round2(setsPoints + points);
  });

  /* sets — суммарное количество наборов; оно же уходит в колонку D
     (по решению администратора в D пишется количество, а не баллы).
     setsPoints — сумма баллов за эти три пункта, остаётся справочно. */
  counts.sets = setsCount;
  counts.setsPoints = setsPoints;

  return {
    fullName: report.fullName || '',
    startDate: report.startDate || '',
    endDate: report.endDate || '',
    totalPoints: report.totalPoints || 0,
    columnD: setsCount,
    columnDCount: setsCount,
    counts
  };
}

function submitForm(formType) {
  const errors = formType === 'weekly' ? validateWeekly()
    : formType === 'night' ? validateNight()
      : formType === 'promotion' ? validatePromotion()
        : formType === 'intern' ? validateIntern()
          : formType === 'unfit' ? validateUnfit() : validateStat();
  if (errors.length) {
    showFormError(formType, errors.map(e => '• ' + e).join('<br>'));
    return;
  }

  const items = (formType === 'stat' || formType === 'intern' || formType === 'unfit') ? { standard: [], extra: [] } : collectItems(formType);
  const report = {
    id: 'r' + Date.now(),
    type: formType,
    createdAt: new Date().toISOString(),
    totalPoints: totalPoints(items),
    items
  };

  if (formType === 'weekly') {
    const wk = periodFor('weekly');
    report.fullName = $('fullNameWeekly').value.trim();
    report.period = $('periodInputWeekly').value;
    report.startDate = formatDate(wk.start);
    report.endDate = formatDate(wk.end);
  } else if (formType === 'night') {
    const np = periodFor('night');
    report.fullName = $('fullNameNight').value.trim();
    report.period = $('periodInputNight').value;
    report.startDate = formatDate(np.start);
    report.endDate = formatDate(np.end);
  } else if (formType === 'stat') {
    report.fullName = $('fullNameStat').value.trim();
    report.userId = $('userIdStat').value.trim();
    report.attendanceLink = $('attendanceLinkStat').value.trim();
    report.prefTime = $('prefTimeStat').value.trim();
  } else if (formType === 'intern') {
    report.hostId = $('internHostId').value.trim();
    report.takerId = $('internTakerId').value.trim();
    report.result = $('internResult').value;
  } else if (formType === 'unfit') {
    report.reporterId = $('unfitReporterId').value.trim();
    report.employeeId = $('unfitEmployeeId').value.trim();
    report.fullName = $('unfitFullName').value.trim();
    report.passport = $('unfitPassport').value.trim();
    report.lastPromo = $('unfitLastPromo').value;
    report.rank = $('unfitRank').value;
    report.photo = $('unfitPhotoUrl').value.trim();
    report.photoData = unfitPhotoData ? unfitPhotoData.dataUrl : '';
  } else {
    report.fullName = $('fullNamePromotion').value.trim();
    report.rank = $('rankSelect').value;
    report.testLink = report.rank === '4 → 5' ? '' : $('testLinkPromotion').value.trim();
    report.examMedLink = $('examMedLink').value.trim();
    report.examAspLink = $('examAspLink').value.trim();
  }

  const toSave = { ...report, sent: false };
  delete toSave.photoData;
  if (toSave.items) {
    const stripShot = it => { const c = Object.assign({}, it); delete c.imageData; delete c.imageName; return c; };
    toSave.items = {
      standard: (report.items.standard || []).map(stripShot),
      extra: (report.items.extra || []).map(stripShot)
    };
  }
  saveReport(toSave);
  sendReport(report, formType);
}

async function sendReport(report, formType) {
  const btn = $('submitBtn' + formPrefix(formType));
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = svgIcon('loader', 'spin') + '<span>Отправка…</span>';
  showLoading('Отправляем отчёт…');

  const slot = slotFor(formType);
  const payload = formType === 'promotion'
    ? buildPromotionMessage(report)
    : formType === 'night'
      ? buildNightMessage(report)
      : formType === 'stat'
        ? buildStatMessage(report)
        : formType === 'intern'
          ? buildInternMessage(report)
          : formType === 'unfit'
            ? buildUnfitMessage(report)
            : buildWeeklyMessage(report);
  const sheet = formType === 'weekly' ? weeklySheetData(report) : null;

  let file = null;
  if (formType === 'unfit' && report.photoData) {
    file = { name: UNFIT_PHOTO_NAME, type: 'image/jpeg', dataUrl: report.photoData };
  } else if (formType === 'night') {
    const files = [];
    (report.items.standard || []).concat(report.items.extra || []).forEach(it => {
      if (it.imageData && it.imageName) files.push({ name: it.imageName, type: 'image/jpeg', dataUrl: it.imageData });
    });
    if (files.length) file = files;
  }

  try {
    const outcome = await postToProxy(slot, payload, file, sheet, null);
    if (outcome.ok) {
      lastSendAttempt = null;
      markSent(report.id);
      hideLoading();
      const sheetNote = sheet && outcome.sheet && outcome.sheet.ok === false
        ? ' (не удалось записать в таблицу)'
        : '';
      toast(formType === 'stat' ? 'Заявка отправлена' : 'Отчёт отправлен', 'Сообщение опубликовано в Discord.' + sheetNote);
      resetForm(formType);
      return;
    }
    if (outcome.code === 'not_configured') {
      hideLoading();
      toast('Отчёт сохранён', 'Вебхук Discord не настроен — данные записаны локально. Свяжитесь с администратором сайта.');
      resetForm(formType);
      return;
    }
    throw new Error(outcome.detail || ('Ошибка отправки (Discord ' + (outcome.status || '') + ')'));
  } catch (e) {
    hideLoading();
    const raw = String((e && e.message) || e);
    const network = /timeout|timed out|abort|failed to fetch|networkerror|load failed|fetch/i.test(raw);
    lastSendAttempt = { report, formType };
    showFormError(
      formType,
      'Не удалось отправить отчёт: ' +
        (network ? 'сервер не ответил за 45 секунд.' : escapeHtml(raw)) +
        '<br>Отчёт сохранён локально.' +
        '<br><button type="button" class="err-retry" onclick="retryLastSend()">Повторить отправку</button>'
    );
    toast('Ошибка отправки', network ? 'Сервер не ответил — похоже, сеть блокирует запрос.' : raw, 'error');
    markSent(report.id, false, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

/* Последняя неудачная отправка — чтобы можно было повторить одной кнопкой. */
let lastSendAttempt = null;

function retryLastSend() {
  if (!lastSendAttempt) return;
  const { report, formType } = lastSendAttempt;
  const box = $('errorMsg' + formPrefix(formType));
  if (box) box.classList.remove('show');
  sendReport(report, formType);
}

function markSent(id, sent = true, failed = false) {
  const list = loadReports();
  const rec = list.find(r => r.id === id);
  if (rec) {
    rec.sent = sent;
    rec.failed = failed;
    localStorage.setItem(REPORTS_KEY, JSON.stringify(list));
  }
}

function slotFor(formType) {
  return formType === 'promotion' ? 'promotion'
    : formType === 'night' ? 'night'
      : formType === 'stat' ? 'stat'
        : formType === 'intern' ? 'intern'
          : formType === 'unfit' ? 'unfit' : 'weekly';
}

async function postToProxy(slot, payload, file, sheet, opts) {
  const body = { slot, payload };
  if (Array.isArray(file)) {
    if (file.length) body.files = file;
  } else if (file) {
    body.file = file;
  }
  if (sheet && typeof sheet === 'object') {
    body.sheet = sheet;
  }
  if (opts && opts.fileAfter) body.fileAfter = true;

  const send = () => apiFetch('/api/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(45000) : undefined
  });

  let res;
  try {
    res = await send();
  } catch (e) {
    /* Сеть не пустила запрос. Если есть релей — сразу повторяем через него,
       пользователю ничего нажимать не нужно. */
    const relayIdx = API_RELAY ? API_HOSTS.indexOf(API_RELAY) : -1;
    if (relayIdx < 0 || apiHostIndex === relayIdx) {
      resetApiHost();
      throw e;
    }
    const prev = apiHostIndex;
    apiHostIndex = relayIdx;
    apiHostReady = Promise.resolve(relayIdx);
    try {
      res = await send();
      try { localStorage.setItem('ems.api.host', String(relayIdx)); } catch (err) {}
    } catch (e2) {
      apiHostIndex = prev;
      resetApiHost();
      throw e2;
    }
  }
  return res.json().catch(() => ({ ok: false, code: 'error', detail: 'Некорректный ответ прокси' }));
}

/* ---- Отчёт на повышение ИП: роли для упоминаний и оформление вебхука ---- */
const PROMO_MENTION_ROLES = ['745515563333189632', '745515556873961552'];
const PROMO_AVATAR = 'https://ems.celleste.site/avatar.jpg';
const PROMO_FOOTER = { text: 'By Celleste · Отчётная система ИП', icon_url: PROMO_AVATAR };
const PROMO_WEBHOOK_BRAND = {
  username: 'Отчет на повышение',
  avatar_url: PROMO_AVATAR
};

/* ---- Еженедельный отчёт: роли, оформление, сообщение ---- */
const WEEKLY_MENTION_ROLES = ['745515563333189632', '745515556873961552'];
const WEEKLY_FOOTER = PROMO_FOOTER;
const WEEKLY_WEBHOOK_BRAND = {
  username: 'Еженедельный отчёт',
  avatar_url: PROMO_AVATAR
};

/* ---- Ночная активность: роли, оформление, сообщение ---- */
const NIGHT_MENTION_ROLES = ['745515563333189632', '745515556873961552'];
const NIGHT_FOOTER = PROMO_FOOTER;
const NIGHT_WEBHOOK_BRAND = {
  username: 'Ночная активность',
  avatar_url: PROMO_AVATAR
};

/* ---- Запись на стажировку: роли для упоминаний и оформление вебхука ---- */
const STAT_MENTION_ROLES = ['745515563333189632', '745515556873961552', '1199645295760388118'];
const STAT_FOOTER = PROMO_FOOTER;
const STAT_WEBHOOK_BRAND = {
  username: 'Запись на стажировку',
  avatar_url: PROMO_AVATAR
};

/* ---- Отчёт о стажировке: роли для упоминаний и оформление вебхука ---- */
const INTERN_MENTION_ROLES = ['745515563333189632', '745515556873961552'];
const INTERN_FOOTER = PROMO_FOOTER;
const INTERN_WEBHOOK_BRAND = {
  username: 'Отчёт о стажировке',
  avatar_url: PROMO_AVATAR
};

/* ---- Профнепригодность: роли для упоминаний и оформление вебхука ---- */
const UNFIT_MENTION_ROLES = ['745515563333189632', '745515556873961552'];
const UNFIT_FOOTER = PROMO_FOOTER;
const UNFIT_WEBHOOK_BRAND = {
  username: 'Профнепригодность',
  avatar_url: PROMO_AVATAR
};
const UNFIT_PHOTO_NAME = 'photo.jpg';

/* ---- Оформление сообщений ботов: настройки из конфига с фолбэком на дефолт ---- */
function resolveBotMessage(block, source) {
  const cfg = source || CONFIG || {};
  const stored = (cfg.botMessages && cfg.botMessages[block]) || {};
  const def = (DEFAULT_CONFIG.botMessages && DEFAULT_CONFIG.botMessages[block]) || {};
  const pick = (key) => {
    if (stored[key] !== undefined && stored[key] !== null) return stored[key];
    return def[key] !== undefined ? def[key] : '';
  };
  const roles = Array.isArray(stored.roles) ? stored.roles : (Array.isArray(def.roles) ? def.roles : []);
  return {
    username: String(pick('username') || '').trim(),
    avatar: String(pick('avatar') || '').trim(),
    color: String(pick('color') || '#b6e04d').trim(),
    title: String(pick('title') || ''),
    footer: String(pick('footer') || ''),
    content: String(pick('content') || ''),
    roles: roles.map(r => String(r).trim()).filter(r => /^\d{15,25}$/.test(r)).slice(0, 10)
  };
}

function botMessageSettings(block) {
  return resolveBotMessage(block, CONFIG);
}

function botColor(value) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
  return m ? parseInt(m[1], 16) : 0xb6e04d;
}

/* В content сначала пинги, затем дополнительный текст из админки. */
function botMessageContent(ui) {
  const mentions = ui.roles.map(id => `<@&${id}>`).join(' ');
  return [mentions, ui.content].filter(Boolean).join('\n');
}

function botMessageFooter(ui) {
  if (!ui.footer) return undefined;
  return { text: ui.footer, ...(ui.avatar ? { icon_url: ui.avatar } : {}) };
}

function buildPromotionMessage(report) {
  const ui = botMessageSettings('promotion');
  const ACCENT = botColor(ui.color);
  const esc = s => String(s == null ? '' : s).replace(/([\\_*~`|])/g, '\\$1');

  const lines = [];
  lines.push('**Имя фамилия**');
  lines.push(`> ${esc(report.fullName) || '—'}`);
  lines.push('');
  lines.push('**С какого на какой ранг**');
  lines.push(`> ${esc(report.rank) || '—'}`);
  lines.push('');
  if (report.testLink) {
    lines.push('**Ссылка на успешную сдачу теста**');
    lines.push(`> ${report.testLink}`);
    lines.push('');
  }
  if (report.rank === '5 → 6' && report.examMedLink) {
    lines.push('**Ссылка на экзамен Лицензию Мед.Карт**');
    lines.push(`> ${report.examMedLink}`);
    lines.push('');
  }
  if (report.rank === '4 → 5' && report.examAspLink) {
    lines.push('**Ссылка на экзамен Лицензии АСМП**');
    lines.push(`> ${report.examAspLink}`);
    lines.push('');
  }
  lines.push('**Пункты:**');
  const items = report.items.standard.concat(report.items.extra);
  items.forEach(i => {
    const pts = i.points != null ? i.points : round2((Number(i.count) || 0) * rateFor('promotion', i.name));
    lines.push(`**${esc(i.name)}**`);
    lines.push(`[${i.count}](${i.link}) | ${getDeclension(pts, 'балл', 'балла', 'баллов')}`);
    lines.push('');
  });
  if (!items.length) lines.push('_Пункты не добавлены_', '');
  lines.push(`**Общее кол-во баллов:** \`${report.totalPoints}\``);

  const head = {
    title: ui.title || 'Отчет на повышение',
    color: ACCENT,
    footer: botMessageFooter(ui),
    timestamp: report.createdAt
  };

  const embeds = [];
  let current = '';
  lines.forEach(line => {
    if ((current + '\n' + line).length > 3500) { embeds.push(current); current = line; }
    else current = current ? current + '\n' + line : line;
  });
  if (current) embeds.push(current);

  return {
    username: ui.username || PROMO_WEBHOOK_BRAND.username,
    avatar_url: ui.avatar || PROMO_WEBHOOK_BRAND.avatar_url,
    content: botMessageContent(ui),
    allowed_mentions: { parse: [], roles: ui.roles.slice() },
    embeds: embeds.map((chunk, i) => i === 0
      ? { ...head, description: chunk }
      : { ...head, title: (ui.title || 'Отчет на повышение') + ' (продолжение)', footer: undefined, description: chunk })
  };
}

function buildWeeklyMessage(report) {
  const ui = botMessageSettings('weekly');
  const ACCENT = botColor(ui.color);
  const esc = s => String(s == null ? '' : s).replace(/([\\_*~`|])/g, '\\$1');

  const lines = [];
  lines.push('**Имя фамилия**');
  lines.push(`> ${esc(report.fullName) || '—'}`);
  lines.push('');
  lines.push('**Период подачи отчёта**');
  lines.push(`> ${esc(report.period) || '—'}`);
  lines.push('');
  lines.push('**Пункты:**');
  const items = report.items.standard.concat(report.items.extra);
  items.forEach(i => {
    const pts = i.points != null ? i.points : round2((Number(i.count) || 0) * rateFor('weekly', i.name));
    lines.push(`**${esc(i.name)}**`);
    lines.push(`[${i.count}](${i.link}) | ${getDeclension(pts, 'балл', 'балла', 'баллов')}`);
    lines.push('');
  });
  if (!items.length) lines.push('_Пункты не добавлены_', '');
  lines.push(`**Общее кол-во баллов:** \`${report.totalPoints}\``);

  const head = {
    title: ui.title || 'Еженедельный отчёт',
    color: ACCENT,
    footer: botMessageFooter(ui),
    timestamp: report.createdAt
  };

  const embeds = [];
  let current = '';
  lines.forEach(line => {
    if ((current + '\n' + line).length > 3500) { embeds.push(current); current = line; }
    else current = current ? current + '\n' + line : line;
  });
  if (current) embeds.push(current);

  return {
    username: ui.username || WEEKLY_WEBHOOK_BRAND.username,
    avatar_url: ui.avatar || WEEKLY_WEBHOOK_BRAND.avatar_url,
    content: botMessageContent(ui),
    allowed_mentions: { parse: [], roles: ui.roles.slice() },
    embeds: embeds.map((chunk, i) => i === 0
      ? { ...head, description: chunk }
      : { ...head, title: (ui.title || 'Еженедельный отчёт') + ' (продолжение)', footer: undefined, description: chunk })
  };
}

function buildNightMessage(report) {
  const ui = botMessageSettings('night');
  const ACCENT = botColor(ui.color);
  const esc = s => String(s == null ? '' : s).replace(/([\\_*~`|])/g, '\\$1');

  const lines = [];
  lines.push('**Имя фамилия**');
  lines.push(`> ${esc(report.fullName) || '—'}`);
  lines.push('');
  lines.push('**Период активности**');
  lines.push(`> ${esc(report.period) || '—'}`);
  lines.push('');
  lines.push('**Пункты:**');
  const items = report.items.standard.concat(report.items.extra);
  const maxShots = 10;
  const shotEmbeds = [];
  items.forEach(i => {
    const pts = i.points != null ? i.points : round2((Number(i.count) || 0) * rateFor('night', i.name));
    lines.push(`**${esc(i.name)}**`);
    lines.push((i.link ? `[${i.count}](${i.link})` : `\`${i.count}\``) + ` | ${getDeclension(pts, 'балл', 'балла', 'баллов')}`);
    lines.push('');
    if (i.imageData && shotEmbeds.length < maxShots) {
      i.imageName = 'night-img-' + (shotEmbeds.length + 1) + '.jpg';
      shotEmbeds.push({ color: ACCENT, image: { url: 'attachment://' + i.imageName } });
    } else {
      i.imageName = '';
    }
  });
  if (!items.length) lines.push('_Пункты не добавлены_', '');
  lines.push(`**Общее кол-во баллов:** \`${report.totalPoints}\``);

  const head = {
    title: ui.title || 'Ночная активность',
    color: ACCENT,
    footer: botMessageFooter(ui),
    timestamp: report.createdAt
  };
  const embeds = [];
  let current = '';
  lines.forEach(line => {
    if ((current + '\n' + line).length > 3500) { embeds.push(current); current = line; }
    else current = current ? current + '\n' + line : line;
  });
  if (current) embeds.push(current);

  return {
    username: ui.username || NIGHT_WEBHOOK_BRAND.username,
    avatar_url: ui.avatar || NIGHT_WEBHOOK_BRAND.avatar_url,
    content: botMessageContent(ui),
    allowed_mentions: { parse: [], roles: ui.roles.slice() },
    embeds: embeds.map((chunk, i) => {
      const base = { ...head, description: chunk };
      if (i > 0) { base.title = (ui.title || 'Ночная активность') + ' (продолжение)'; base.footer = undefined; }
      return base;
    }).concat(shotEmbeds)
  };
}

function buildStatMessage(report) {
  const ui = botMessageSettings('stat');
  const ACCENT = botColor(ui.color);
  const esc = s => String(s == null ? '' : s).replace(/([\\_*~`|])/g, '\\$1');

  const lines = [];
  lines.push('**Имя фамилия**');
  lines.push(`> ${esc(report.fullName) || '—'}`);
  lines.push('');
  lines.push('**ID пользователя (Discord)**');
  lines.push(`> ${esc(report.userId) || '—'}`);
  lines.push('');
  lines.push('**Ссылка на присутствие в наборе в EMS**');
  lines.push(`> ${report.attendanceLink || '—'}`);
  lines.push('');
  lines.push('**Удобное для вас время прохождения стажировки**');
  lines.push(`> ${esc(report.prefTime) || '—'}`);

  const head = {
    title: ui.title || 'Запись на стажировку',
    color: ACCENT,
    footer: botMessageFooter(ui),
    timestamp: report.createdAt
  };

  const embeds = [];
  let current = '';
  lines.forEach(line => {
    if ((current + '\n' + line).length > 3500) { embeds.push(current); current = line; }
    else current = current ? current + '\n' + line : line;
  });
  if (current) embeds.push(current);

  return {
    username: ui.username || STAT_WEBHOOK_BRAND.username,
    avatar_url: ui.avatar || STAT_WEBHOOK_BRAND.avatar_url,
    content: botMessageContent(ui),
    allowed_mentions: { parse: [], roles: ui.roles.slice() },
    embeds: embeds.map((chunk, i) => i === 0
      ? { ...head, description: chunk }
      : { ...head, title: (ui.title || 'Запись на стажировку') + ' (продолжение)', footer: undefined, description: chunk })
  };
}

function buildInternMessage(report) {
  const ui = botMessageSettings('intern');
  const ACCENT = botColor(ui.color);
  const esc = s => String(s == null ? '' : s).replace(/([\\_*~`|])/g, '\\$1');

  const lines = [];
  const hostOk = /^\d{15,25}$/.test(String(report.hostId || ''));
  const takerOk = /^\d{15,25}$/.test(String(report.takerId || ''));

  lines.push('Принимал:');
  lines.push(hostOk ? `<@${report.hostId}>` : '—');
  lines.push('');
  lines.push('Сдавал:');
  lines.push(takerOk ? `<@${report.takerId}>` : '—');
  lines.push('');
  lines.push(`Результат: ${esc(report.result) || '—'}`);

  const head = {
    title: ui.title || 'Отчёт о стажировке',
    color: ACCENT,
    footer: botMessageFooter(ui),
    timestamp: report.createdAt
  };

  return {
    username: ui.username || INTERN_WEBHOOK_BRAND.username,
    avatar_url: ui.avatar || INTERN_WEBHOOK_BRAND.avatar_url,
    content: botMessageContent(ui),
    allowed_mentions: { parse: [], roles: ui.roles.slice() },
    embeds: [{ ...head, description: lines.join('\n') }]
  };
}

function buildUnfitMessage(report) {
  const ui = botMessageSettings('unfit');
  const ACCENT = botColor(ui.color);
  const esc = s => String(s == null ? '' : s).replace(/([\\_*~`|])/g, '\\$1');

  const idOk = /^\d{15,25}$/.test(String(report.employeeId || ''));
  const reporterOk = /^\d{15,25}$/.test(String(report.reporterId || ''));
  const lines = [];
  lines.push('Отправил');
  lines.push(reporterOk ? `<@${report.reporterId}>` : (report.reporterId ? esc(report.reporterId) : '—'));
  lines.push('');
  lines.push('Сотрудник');
  lines.push(idOk ? `<@${report.employeeId}>` : (report.employeeId ? esc(report.employeeId) : '—'));
  lines.push('');
  lines.push('ФИ сотрудника:');
  lines.push(esc(report.fullName) || '—');
  lines.push('Паспорт Сотрудника:');
  lines.push(esc(report.passport) || '—');
  lines.push('Дата последнего повышения:');
  lines.push(ruDate(report.lastPromo) || '—');
  lines.push('Ранг Сотрудника:');
  lines.push(esc(report.rank) || '—');
  lines.push(`Фото: ${report.photoData ? 'во вложении' : (report.photo ? report.photo : '—')}`);

  const head = {
    title: ui.title || 'Профнепригодность',
    color: ACCENT,
    footer: botMessageFooter(ui),
    timestamp: report.createdAt
  };

  /* Фото из буфера (Ctrl+V) уходит вложением этого же сообщения и Discord
     показывает его под текстом отчёта, перед подписью. Ссылка — как есть. */
  if (report.photoData) head.image = { url: 'attachment://' + UNFIT_PHOTO_NAME };
  else if (report.photo) head.image = { url: report.photo };

  const allowedMentions = { parse: [], roles: ui.roles.slice() };
  if (reporterOk) allowedMentions.users = [report.reporterId];

  return {
    username: ui.username || UNFIT_WEBHOOK_BRAND.username,
    avatar_url: ui.avatar || UNFIT_WEBHOOK_BRAND.avatar_url,
    content: botMessageContent(ui),
    allowed_mentions: allowedMentions,
    embeds: [{ ...head, description: lines.join('\n') }]
  };
}

/* ---- Фото: ссылка или вставка из буфера (Ctrl+V) / файл ---- */
let unfitPhotoData = null;

function unfitPhotoPreview(url) {
  const preview = $('unfitPhotoPreview');
  const img = $('unfitPhotoImg');
  if (!preview || !img) return;
  if (url) { img.src = url; preview.classList.remove('hidden'); }
  else { img.removeAttribute('src'); preview.classList.add('hidden'); }
}

function setUnfitPhoto(urlValue, fileData) {
  unfitPhotoData = fileData || null;
  const urlInput = $('unfitPhotoUrl');
  if (urlInput) urlInput.value = urlValue || '';
  unfitPhotoPreview(fileData ? fileData.dataUrl : (urlValue || ''));
}

function clearUnfitPhoto() {
  setUnfitPhoto('', null);
}

function compressImage(file, name) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        /* 1400 px и q=0.8: скриншот остаётся читаемым, а вес запроса
           падает в разы — на слабом канале отправка успевает пройти. */
        const MAX = 1400;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const k = Math.min(MAX / width, MAX / height);
          width = Math.round(width * k);
          height = Math.round(height * k);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.8), name: name || UNFIT_PHOTO_NAME, type: 'image/jpeg' });
      };
      img.onerror = () => resolve(null);
      img.src = reader.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function handleUnfitPhotoFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { toast('Не изображение', 'Можно вставить только картинку.', 'error'); return; }
  const data = await compressImage(file);
  if (!data) { toast('Не удалось обработать фото', 'Попробуйте другой файл.', 'error'); return; }
  setUnfitPhoto('', data);
  toast('Фото добавлено', 'Будет прикреплено к отчёту.');
}

function initUnfitPhoto() {
  const urlInput = $('unfitPhotoUrl');
  const drop = $('unfitPhotoDrop');
  const fileInput = $('unfitPhotoFile');
  const clearBtn = $('unfitPhotoClear');
  if (!urlInput) return;

  urlInput.addEventListener('input', () => {
    if (unfitPhotoData) { unfitPhotoData = null; }
    unfitPhotoPreview(urlInput.value.trim());
  });

  const onPaste = e => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.indexOf('image') === 0) {
        e.preventDefault();
        const file = it.getAsFile();
        if (file) handleUnfitPhotoFile(file);
        return;
      }
    }
  };
  urlInput.addEventListener('paste', onPaste);
  if (drop) drop.addEventListener('paste', onPaste);

  if (drop) {
    drop.addEventListener('click', () => { if (fileInput) fileInput.click(); });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('drag');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleUnfitPhotoFile(f);
    });
  }
  if (fileInput) fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleUnfitPhotoFile(fileInput.files[0]);
    fileInput.value = '';
  });
  if (clearBtn) clearBtn.addEventListener('click', e => { e.preventDefault(); clearUnfitPhoto(); });
}

/* ---- Скриншот из буфера в поле «Ссылка» пункта ---- */
async function handleActionShot(formType, isStandard, name, id, file) {
  if (!file || !/^image\//.test(file.type)) { toast('Не изображение', 'Можно вставить только картинку.', 'error'); return; }
  const data = await compressImage(file, 'item.jpg');
  if (!data) { toast('Не удалось обработать', 'Попробуйте другой файл.', 'error'); return; }
  let target;
  if (isStandard) {
    const store = stdValues(formType);
    store[name] = store[name] || { link: '', count: 0, points: 0 };
    target = store[name];
  } else {
    target = extras(formType).find(i => i.id === id);
  }
  if (!target) return;
  target.imageData = data.dataUrl;
  renderActions(formType);
  toast('Скриншот добавлен', 'Будет прикреплён к отчёту.');
}

/* ---- Дата последнего повышения: календарь ---- */
let unfitDate = null;
let unfitCalMonth = new Date();

function formatRuDate(date) {
  if (!date) return '';
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}

function setUnfitDate(date) {
  unfitDate = date ? new Date(date.getFullYear(), date.getMonth(), date.getDate()) : null;
  const input = $('unfitLastPromo');
  if (input) input.value = unfitDate ? formatRuDate(unfitDate) : '';
  if (unfitDate) unfitCalMonth = new Date(unfitDate.getFullYear(), unfitDate.getMonth(), 1);
  renderUnfitCalendar();
}

function openUnfitPicker(open) {
  const picker = $('unfitDatePicker');
  if (!picker) return;
  picker.classList.toggle('active', open);
  if (!open) { picker.classList.remove('up'); return; }
  renderUnfitCalendar();
  picker.classList.remove('up');
  const fr = $('unfitLastPromo').getBoundingClientRect();
  if (fr.bottom + 12 + picker.offsetHeight > window.innerHeight - 8) picker.classList.add('up');
}

function renderUnfitCalendar() {
  const cal = $('unfitCalendar');
  if (!cal) return;
  const year = unfitCalMonth.getFullYear();
  const month = unfitCalMonth.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const monthLabel = first.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  const selKey = unfitDate ? formatDate(unfitDate) : '';

  let html = `<div class="cal-head">
      <button type="button" class="cal-nav" data-nav="-1">←</button>
      <span class="cal-title">${monthLabel}</span>
      <button type="button" class="cal-nav" data-nav="1">→</button>
    </div>
    <div class="cal-status">${unfitDate ? `Выбрано: <b>${formatRuDate(unfitDate)}</b>` : 'Выберите дату последнего повышения'}</div>
    <div class="cal-grid">`;

  ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].forEach(d => html += `<div class="cal-wd">${d}</div>`);

  const offset = first.getDay() === 0 ? 6 : first.getDay() - 1;
  const prevDays = new Date(year, month, 0).getDate();
  for (let i = offset; i > 0; i--) html += unfitDayCell(prevDays - i + 1, year, month - 1, selKey);
  for (let d = 1; d <= last.getDate(); d++) html += unfitDayCell(d, year, month, selKey);
  const rest = 42 - (offset + last.getDate());
  for (let i = 1; i <= rest; i++) html += unfitDayCell(i, year, month + 1, selKey);

  html += '</div>';
  cal.innerHTML = html;

  cal.querySelectorAll('.cal-nav').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      unfitCalMonth.setMonth(unfitCalMonth.getMonth() + Number(btn.dataset.nav));
      renderUnfitCalendar();
    };
  });
  cal.querySelectorAll('.cal-day').forEach(cell => {
    cell.onclick = e => {
      e.stopPropagation();
      setUnfitDate(new Date(Number(cell.dataset.year), Number(cell.dataset.month), Number(cell.dataset.day)));
      openUnfitPicker(false);
    };
  });
}

function unfitDayCell(day, year, month, selKey) {
  const date = new Date(year, month, day);
  const cls = selKey && formatDate(date) === selKey ? 'single' : '';
  return `<div class="cal-day ${cls}" data-year="${year}" data-month="${month}" data-day="${day}">${day}</div>`;
}

function initUnfitDate() {
  const input = $('unfitLastPromo');
  if (!input) return;
  input.addEventListener('click', e => {
    e.stopPropagation();
    openUnfitPicker(!$('unfitDatePicker').classList.contains('active'));
  });
  document.addEventListener('click', e => {
    const picker = $('unfitDatePicker');
    if (picker && !picker.contains(e.target) && e.target !== input) openUnfitPicker(false);
  });
  const clearBtn = $('clearUnfitDateBtn');
  if (clearBtn) clearBtn.addEventListener('click', e => { e.stopPropagation(); setUnfitDate(null); openUnfitPicker(false); });
}

/* ---- Ранг: кастомный выпадающий список ---- */
const UNFIT_RANKS = ['Студент [1]', 'Интерн [2]', 'Медицинский работник [3]'];
let unfitRank = '';

function renderUnfitRankMenu() {
  const menu = $('unfitRankMenu');
  if (!menu) return;
  menu.innerHTML = UNFIT_RANKS.map(r =>
    `<button type="button" class="select-option${r === unfitRank ? ' active' : ''}" role="option" data-value="${escapeHtml(r)}">${escapeHtml(r)}</button>`
  ).join('');
  menu.querySelectorAll('.select-option').forEach(btn => {
    btn.onclick = e => { e.stopPropagation(); setUnfitRank(btn.dataset.value); openUnfitRankMenu(false); };
  });
}

function setUnfitRank(value) {
  unfitRank = value || '';
  const hidden = $('unfitRank');
  if (hidden) hidden.value = unfitRank;
  const label = $('unfitRankValue');
  if (label) { label.textContent = unfitRank || 'Выберите ранг'; label.classList.toggle('placeholder', !unfitRank); }
}

function openUnfitRankMenu(open) {
  const menu = $('unfitRankMenu');
  const trigger = $('unfitRankTrigger');
  if (!menu || !trigger) return;
  if (open) renderUnfitRankMenu();
  menu.classList.toggle('active', open);
  trigger.classList.toggle('open', open);
  trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function initUnfitRank() {
  const trigger = $('unfitRankTrigger');
  if (!trigger) return;
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    openUnfitRankMenu(!$('unfitRankMenu').classList.contains('active'));
  });
  document.addEventListener('click', e => {
    const field = $('unfitRankField');
    if (field && !field.contains(e.target)) openUnfitRankMenu(false);
  });
}

function buildEmbeds(report) {
  const ACCENT = 0xb6e04d;
  const isWeekly = report.type === 'weekly';
  const dateStr = new Date(report.createdAt).toLocaleString('ru-RU');

  const head = {
    title: isWeekly ? (CONFIG.weeklyTitle || 'Еженедельный отчёт') : (CONFIG.promotionTitle || 'Отчёт на повышение'),
    color: ACCENT,
    fields: [{ name: 'Имя', value: report.fullName || '—', inline: true }],
    footer: { text: 'EMS · Отчётная система ИП' },
    timestamp: report.createdAt
  };

  if (isWeekly) {
    head.fields.push({ name: 'Период', value: report.period || '—', inline: true });
  } else {
    head.fields.push({ name: 'Ранг', value: report.rank || '—', inline: true });
    if (report.testLink) head.fields.push({ name: 'Тест', value: report.testLink, inline: false });
    if (report.rank === '5 → 6' && report.examMedLink) head.fields.push({ name: 'Экзамен Мед.Карт', value: report.examMedLink, inline: false });
    if (report.rank === '4 → 5' && report.examAspLink) head.fields.push({ name: 'Экзамен АСМП', value: report.examAspLink, inline: false });
  }
  head.fields.push({ name: 'Итого баллов', value: String(report.totalPoints), inline: true });

  const lines = [];
  report.items.standard.forEach(i => lines.push(`**${i.name}** — ${i.count} шт. · +${i.points}\n${i.link}`));
  report.items.extra.forEach(i => lines.push(`**${i.name}** — ${i.count} шт. · +${i.points}\n${i.link}`));
  if (!lines.length) lines.push('_Пункты не добавлены_');

  const chunks = [];
  let current = '';
  lines.forEach(line => {
    if ((current + '\n\n' + line).length > 1500) { chunks.push(current); current = line; }
    else current = current ? current + '\n\n' + line : line;
  });
  if (current) chunks.push(current);

  const embeds = [];
  chunks.forEach((chunk, i) => {
    const embed = i === 0 ? head : { color: ACCENT, description: '' };
    embed.description = chunk;
    if (i > 0) embed.title = `Пункты отчёта (продолжение ${i + 1}/${chunks.length})`;
    embeds.push(embed);
    if (embeds.length >= 10) return;
  });

  return embeds.slice(0, 10);
}

function resetForm(formType) {
  if (formType === 'weekly') {
    $('fullNameWeekly').value = '';
    state.std.weekly = {};
    state.extras.weekly = [];
    renderActions('weekly');
    setCurrentWeek('weekly');
    renderCalendar('weekly');
    updatePoints('weekly');
    $('errorMsgWeekly').classList.remove('show');
  } else if (formType === 'night') {
    $('fullNameNight').value = '';
    state.std.night = {};
    state.extras.night = [];
    renderActions('night');
    setCurrentWeek('night');
    renderCalendar('night');
    updatePoints('night');
    $('errorMsgNight').classList.remove('show');
  } else if (formType === 'stat') {
    $('fullNameStat').value = '';
    $('userIdStat').value = '';
    $('attendanceLinkStat').value = '';
    $('prefTimeStat').value = '';
    $('errorMsgStat').classList.remove('show');
  } else if (formType === 'intern') {
    $('internHostId').value = '';
    $('internTakerId').value = '';
    $('internResult').value = '';
    setInternResult('');
    $('errorMsgIntern').classList.remove('show');
  } else if (formType === 'unfit') {
    $('unfitReporterId').value = '';
    $('unfitEmployeeId').value = '';
    $('unfitFullName').value = '';
    $('unfitPassport').value = '';
    setUnfitDate(null);
    setUnfitRank('');
    clearUnfitPhoto();
    $('errorMsgUnfit').classList.remove('show');
  } else {
    $('fullNamePromotion').value = '';
    $('testLinkPromotion').value = '';
    $('examMedLink').value = '';
    $('examAspLink').value = '';
    state.rank = '';
    $('rankSelect').value = '';
    state.std.promotion = {};
    state.extras.promotion = [];
    renderRanks();
    renderActions('promotion');
    updatePoints('promotion');
    $('errorMsgPromotion').classList.remove('show');
    toggleConditionalFields();
  }
  document.querySelectorAll('.err-field').forEach(el => el.classList.remove('err-field'));
}

/* ================= Админ-панель ================= */

function openAdmin() {
  $('adminPassword').value = '';
  $('adminError').classList.add('hidden');
  $('adminLogin').classList.toggle('hidden', adminUnlocked);
  $('adminPanel').classList.toggle('hidden', !adminUnlocked);
  if (adminUnlocked) {
    editedConfig = deepClone(CONFIG);
    renderAdminEditor();
    /* Возвращаемся на ту вкладку, где остановились: у «Наборов» своя кнопка сохранения. */
    const activeTab = document.querySelector('.admin-tab.active');
    const saveBtn = $('saveAdminBtn');
    if (saveBtn) saveBtn.classList.toggle('hidden', !!activeTab && activeTab.dataset.tab === 'announce');
  }
  document.querySelector('#adminModal .modal').classList.toggle('tall', adminUnlocked);
  $('adminModal').classList.add('active');
  document.body.classList.add('modal-open');
  if (!adminUnlocked) setTimeout(() => $('adminPassword').focus(), 60);
}

function closeAdmin() {
  $('adminModal').classList.remove('active');
  document.body.classList.remove('modal-open');
}

/* ================= Ассистент ================= */

function openEditor() {
  if (editorUnlocked) {
    openConfirm({
      title: 'Выйти из режима ассистента?',
      text: 'Выйти из режима ассистента? Разделы 05–06 будут скрыты.',
      okText: 'Выйти',
      danger: true,
      onOk: () => {
        editorUnlocked = false;
        revokeAuth(EDITOR_AUTH_KEY);
        updateMenuVisibility();
        if (state.form === 'quiz' || state.form === 'intern' || state.form === 'unfit') showScreen('menu');
        toast('Режим ассистента выключен', 'Разделы 05–06 скрыты.');
      }
    });
    return;
  }
  $('editorPassword').value = '';
  $('editorError').classList.add('hidden');
  $('editorModal').classList.add('active');
  document.body.classList.add('modal-open');
  setTimeout(() => $('editorPassword').focus(), 60);
}

function closeEditor() {
  $('editorModal').classList.remove('active');
  document.body.classList.remove('modal-open');
}

/* ================= Стилизованное подтверждение ================= */

let confirmAction = null;

function openConfirm(opts) {
  const o = opts || {};
  $('confirmTitle').textContent = o.title || 'Подтверждение';
  $('confirmText').textContent = o.text || '';
  const ok = $('confirmOkBtn');
  ok.textContent = o.okText || 'Подтвердить';
  ok.classList.toggle('danger', o.danger !== false);
  confirmAction = typeof o.onOk === 'function' ? o.onOk : null;
  $('confirmModal').classList.add('active');
  document.body.classList.add('modal-open');
  setTimeout(() => ok.focus(), 60);
}

function closeConfirm() {
  $('confirmModal').classList.remove('active');
  document.body.classList.remove('modal-open');
  confirmAction = null;
}

/* ================= Чек-лист вопросов (раздел 05) ================= */

function loadQuizChecked() {
  try { return JSON.parse(localStorage.getItem(QUIZ_KEY) || '{}') || {}; } catch (e) { return {}; }
}

function saveQuizChecked(obj) {
  try { localStorage.setItem(QUIZ_KEY, JSON.stringify(obj)); } catch (e) {}
}

function quizItemKey(gi, ii) {
  return 'g' + gi + 'i' + ii;
}

function clampPct(v) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return '';
  return Math.max(0, Math.min(100, n));
}

function quizRec(store, key) {
  const prev = store[key];
  if (prev && typeof prev === 'object') return Object.assign({ on: prev.on ? 1 : 0, ans: prev.ans != null ? prev.ans : '', open: prev.open != null ? prev.open : '' }, prev);
  return { on: prev ? 1 : 0, ans: '', open: '' };
}

function patchQuizRec(key, patch) {
  const store = loadQuizChecked();
  const prev = quizRec(store, key);
  store[key] = Object.assign(prev, patch);
  saveQuizChecked(store);
}

function renderQuiz() {
  const title = CONFIG.quizTitle || 'Вопросы для стажировки';
  $('quizTitleHeading').innerHTML = svgIcon('book') + `<span>${escapeHtml(title)}</span>`;

  const intro = $('quizIntro');
  if (CONFIG.quizIntro && String(CONFIG.quizIntro).trim()) {
    intro.innerHTML = String(CONFIG.quizIntro).split('\n').map(l => `<p>${escapeHtml(l)}</p>`).join('');
  } else {
    intro.innerHTML = '';
  }

  const sections = Array.isArray(CONFIG.quizSections) ? CONFIG.quizSections : [];
  const checked = loadQuizChecked();
  let html = '';
  sections.forEach((sec, gi) => {
    html += `<div class="quiz-section"><div class="quiz-section-title">${escapeHtml(sec.name || '')}</div>`;
    const items = Array.isArray(sec.items) ? sec.items : [];
    if (!items.length) html += '<div class="a-empty">Вопросов нет</div>';
    items.forEach((it, ii) => {
      const key = quizItemKey(gi, ii);
      const rec = quizRec(checked, key);
      const on = !!rec.on;
      html += `<div class="quiz-item${on ? ' checked' : ''}" data-key="${key}">
        <label class="quiz-check"><input type="checkbox" ${on ? 'checked' : ''}><span class="quiz-box" data-icon="check"></span></label>
        <div class="quiz-text">
          <div class="quiz-q">${escapeHtml(it.q || '')}</div>
          <div class="quiz-meter">
            <label>Ответил <input class="quiz-p" data-field="ans" type="number" min="0" max="100" step="5" inputmode="numeric" value="${escapeHtml(String(rec.ans))}" placeholder="0"><span>%</span></label>
            <label>Раскрыл <input class="quiz-p" data-field="open" type="number" min="0" max="100" step="5" inputmode="numeric" value="${escapeHtml(String(rec.open))}" placeholder="0"><span>%</span></label>
          </div>
          <div class="quiz-a">${escapeHtml(it.a || '')}</div>
        </div>
      </div>`;
    });
    html += '</div>';
  });
  $('quizBody').innerHTML = html;

  const practice = $('quizPractice');
  if (CONFIG.quizPractice && String(CONFIG.quizPractice).trim()) {
    practice.innerHTML = '<div class="quiz-practice-title">Практическая часть</div>' +
      String(CONFIG.quizPractice).split('\n').map(l => `<p>${escapeHtml(l)}</p>`).join('');
  } else {
    practice.innerHTML = '';
  }

  $('quizBody').querySelectorAll('.quiz-item').forEach(item => {
    const cb = item.querySelector('input');
    cb.onchange = () => {
      patchQuizRec(item.dataset.key, { on: cb.checked ? 1 : 0 });
      item.classList.toggle('checked', cb.checked);
      updateQuizTotal();
    };
    item.querySelectorAll('.quiz-p').forEach(inp => {
      inp.oninput = () => {
        const v = clampPct(inp.value);
        if (String(v) !== inp.value) inp.value = v;
        patchQuizRec(item.dataset.key, { [inp.dataset.field]: v });
      };
    });
  });

  hydrateIcons($('quizBody'));
  updateQuizTotal();
}

function updateQuizTotal() {
  const body = $('quizBody');
  const total = body ? body.querySelectorAll('.quiz-item').length : 0;
  const done = body ? body.querySelectorAll('.quiz-item.checked').length : 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  if ($('quizTotalPercent')) $('quizTotalPercent').textContent = pct + '%';
  if ($('quizTotalLabel')) $('quizTotalLabel').textContent = 'Отмечено ' + done + ' из ' + total;
}

function switchTab(tabId) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab' + tabId.charAt(0).toUpperCase() + tabId.slice(1)));
  /* На вкладке «Наборы» — только настройки анонса, сам блок 09 остался в меню. */
  if (tabId === 'announce') renderAnnounceSettings();
  /* На вкладке «Наборы» своя кнопка сохранения — общий «Сохранить изменения» не нужен. */
  const saveBtn = $('saveAdminBtn');
  if (saveBtn) saveBtn.classList.toggle('hidden', tabId === 'announce');
  const active = document.querySelector('.admin-tab-content.active .admin-scroll');
  if (active) {
    if (typeof active.scrollTo === 'function') active.scrollTo({ top: 0, behavior: 'smooth' });
    else active.scrollTop = 0;
  }
}

function renderAdminEditor() {
  if (!editedConfig) editedConfig = deepClone(CONFIG);
  const c = editedConfig;
  c.points = c.points || {};
  c.categories = c.categories || {};
  c.categoryColors = c.categoryColors || {};
  c.categoryOrder = c.categoryOrder && c.categoryOrder.length ? c.categoryOrder : Object.keys(c.categories);
  ensureAlwaysForm(c);
  c.photoHosts = c.photoHosts || [];
  c.bannerWeekly = c.bannerWeekly || { url: '', visible: false, type: 'auto' };
  c.bannerPromotion = c.bannerPromotion || { url: '', visible: false, type: 'auto' };
  c.bannerNight = c.bannerNight || { url: '', visible: false, type: 'auto' };
  c.bannerStat = c.bannerStat || { url: '', visible: false, type: 'auto' };
  c.bannerIntern = c.bannerIntern || { url: '', visible: false, type: 'auto' };
  c.bannerUnfit = c.bannerUnfit || { url: '', visible: false, type: 'auto' };
  c.weeklyRules = c.weeklyRules || [];
  c.promotionRules = c.promotionRules || [];
  c.quizSections = Array.isArray(c.quizSections) ? c.quizSections : [];
  c.quizSections.forEach(sec => { if (!Array.isArray(sec.items)) sec.items = []; });

  renderAdminPoints();
  renderAdminCategories();
  renderAdminItems();
  renderAdminAlways();
  renderAdminPhoto();
  renderAdminBanner();
  renderAdminTitles();
  renderAdminQuiz();
  renderAdminPremium();
  renderAdminSend();
  renderAdminMessages();
  renderAdminReports();
  renderAdminData();

  /* Если админка открыта на вкладке «Наборы», обновляем и её. */
  const activeTab = document.querySelector('.admin-tab.active');
  if (activeTab && activeTab.dataset.tab === 'announce') renderAnnounceSettings();
}

/* --- пункты --- */
function moveItemToCategory(name, targetCat) {
  if (!name) return;
  Object.keys(editedConfig.categories).forEach(cat => {
    editedConfig.categories[cat] = editedConfig.categories[cat].filter(i => i !== name);
  });
  if (targetCat && targetCat.indexOf('__always_') === 0) {
    const f = targetCat.slice(9);
    if (ALWAYS_FORM_KEYS.includes(f)) {
      const list = alwaysVisibleFor(editedConfig, f);
      if (!list.includes(name)) list.push(name);
    }
    toast('Пункт перемещён', 'во «Всегда видимые · ' + ALWAYS_FORM_LABEL[f] + '»');
  } else if (targetCat === '__loose__') {
    removeAlwaysFromAll(editedConfig, name);
    toast('Пункт перемещён', 'в «Без отдела»');
  } else {
    removeAlwaysFromAll(editedConfig, name);
    if (editedConfig.categories[targetCat] && !editedConfig.categories[targetCat].includes(name)) editedConfig.categories[targetCat].push(name);
    toast('Пункт перемещён', 'в отдел «' + targetCat + '»');
  }
  renderAdminPoints();
  renderAdminItems();
  renderAdminCategories();
  renderAdminAlways();
}

function renderAdminPoints() {
  const c = editedConfig;
  const all = Object.keys(c.points);
  const order = (c.categoryOrder || []).filter(cat => c.categories[cat]);
  Object.keys(c.categories).forEach(cat => { if (!order.includes(cat)) order.push(cat); });

  const catsOf = {};
  order.forEach(cat => (c.categories[cat] || []).forEach(i => {
    if (!catsOf[i]) catsOf[i] = [];
    catsOf[i].push(cat);
  }));
  const catOf = name => (catsOf[name] || [])[0] || '';

  const byCat = {};
  order.forEach(cat => byCat[cat] = []);
  all.forEach(name => { if (catOf(name)) byCat[catOf(name)].push(name); });
  const pinnedW = all.filter(name => alwaysVisibleFor(c, 'weekly').includes(name));
  const pinnedP = all.filter(name => alwaysVisibleFor(c, 'promotion').includes(name));
  const pinnedN = all.filter(name => alwaysVisibleFor(c, 'night').includes(name));
  const loose = all.filter(name => !isAlwaysVisibleAnywhere(c, name) && !catOf(name));

  let html = `<div class="a-section"><h4>Пункты по отделам (${all.length})</h4>
    <div class="a-hint">Пункты сгруппированы по отделам так же, как их видит пользователь при добавлении. Добавляйте пункты прямо в нужный отдел кнопкой «+ Добавить» под его списком — или через форму ниже, выбрав отдел. Пункт можно создать только внутри отдела. Перетаскивайте пункты за ручку ⋮⋮ в другой отдел. Отделы можно переименовывать, менять цвет и удалять прямо здесь.</div>
    <div class="a-add a-add-top">
      <input type="text" id="newPointName" placeholder="Название нового пункта">
      <input type="number" id="newPointValue" placeholder="Баллы" step="0.1" style="max-width:120px">
      <select id="newPointCat" style="max-width:220px">${order.length
        ? `<option value="">Выберите отдел…</option>${order.map(cat => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join('')}`
        : `<option value="">Сначала создайте отдел</option>`}</select>
      <button type="button" class="a-btn" id="addPointBtn">+ Добавить пункт</button>
    </div>
    <div class="a-add a-add-top" style="margin-top:10px">
      <input type="text" id="newCatName" placeholder="Название нового отдела">
      <button type="button" class="a-btn" id="addCatBtn" style="white-space:nowrap">+ Добавить отдел</button>
    </div>`;

  const block = (title, color, items, emptyText, catKey, editable) => {
    html += `<div class="act-category drop-zone" data-cat="${escapeHtml(catKey)}">
      <div class="act-category-title${editable ? ' a-cat-head' : ''}" style="color:${color};border-color:${color}">${editable
        ? `<input type="text" class="a-cat-rename cat-name" data-cat="${escapeHtml(catKey)}" value="${escapeHtml(title)}" title="Название отдела">
          <span class="swatch" style="background:${color}" title="Цвет отдела"><input type="color" class="cat-color" data-cat="${escapeHtml(catKey)}" value="${color}"></span>
          <span class="a-card-meta">${getDeclension(items.length, 'пункт', 'пункта', 'пунктов')}</span>
          <button type="button" class="a-del cat-del" data-cat="${escapeHtml(catKey)}" title="Удалить отдел" data-icon="trash"></button>`
        : `<span>${escapeHtml(title)} · ${getDeclension(items.length, 'пункт', 'пункта', 'пунктов')}</span>`}
      </div>
      <div class="act-items">`;
    html += items.length
      ? items.map(name => `<div class="a-row" data-orig="${escapeHtml(name)}" style="grid-column:1/-1">
          <span class="drag-handle" draggable="true" title="Перетащить в отдел" data-icon="grip"></span>
          <input type="text" class="grow a-pt-name" value="${escapeHtml(name)}">
          <input type="number" class="narrow a-pt-value" step="0.1" value="${c.points[name]}">
          <button type="button" class="a-del a-pt-del" title="Удалить" data-icon="close"></button>
        </div>`).join('')
      : `<div class="a-empty">${emptyText}</div>`;
    if (editable) {
      html += `<div class="a-add a-inline" data-cat="${escapeHtml(catKey)}">
        <input type="text" class="grow a-cat-new-name" data-cat="${escapeHtml(catKey)}" placeholder="Новый пункт в «${escapeHtml(title)}»">
        <input type="number" class="narrow a-cat-new-value" data-cat="${escapeHtml(catKey)}" step="0.1" placeholder="Баллы">
        <button type="button" class="a-btn a-cat-add" data-cat="${escapeHtml(catKey)}">+ Добавить</button>
      </div>`;
    }
    html += `</div></div>`;
  };

  order.forEach(cat => block(cat, c.categoryColors[cat] || '#b6e04d', byCat[cat] || [], 'Пунктов пока нет', cat, true));
  block('Всегда видимые · еженедельный отчёт', ALWAYS_FORM_COLOR.weekly, pinnedW, 'Нет таких пунктов', '__always_weekly');
  block('Всегда видимые · повышение', ALWAYS_FORM_COLOR.promotion, pinnedP, 'Нет таких пунктов', '__always_promotion');
  block('Всегда видимые · ночная активность', ALWAYS_FORM_COLOR.night, pinnedN, 'Нет таких пунктов', '__always_night');
  block('Без отдела (пользователи их не видят)', '#8a90a0', loose, 'Нет таких пунктов', '__loose__');

  $('tabPoints').querySelector('.admin-scroll').innerHTML = html;

  /* --- перетаскивание пунктов между отделами --- */
  let dragFrom = null;
  $('tabPoints').querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('dragstart', e => {
      dragFrom = handle.closest('.a-row').dataset.orig;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragFrom || '');
      handle.closest('.a-row').classList.add('dragging');
    });
    handle.addEventListener('dragend', () => {
      handle.closest('.a-row').classList.remove('dragging');
      $('tabPoints').querySelectorAll('.drop-zone').forEach(z => z.classList.remove('drag-over'));
      dragFrom = null;
    });
  });

  $('tabPoints').querySelectorAll('.drop-zone').forEach(zone => {
    zone.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => {
      zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const name = e.dataTransfer.getData('text/plain') || dragFrom;
      moveItemToCategory(name, zone.dataset.cat);
    });
  });

  const addPoint = () => {
    const name = $('newPointName').value.trim();
    const val = parseFloat($('newPointValue').value);
    if (!name) return toast('Укажите название', '', 'error');
    if (editedConfig.points[name] !== undefined) return toast('Пункт уже существует', name, 'error');
    const cat = $('newPointCat').value;
    if (!cat || editedConfig.categories[cat] === undefined) {
      return toast('Выберите отдел', 'Пункт можно добавить только в существующий отдел. Сначала создайте отдел.', 'error');
    }
    editedConfig.points[name] = isNaN(val) ? 0 : val;
    Object.keys(editedConfig.categories).forEach(k => {
      editedConfig.categories[k] = editedConfig.categories[k].filter(i => i !== name);
    });
    if (!editedConfig.categories[cat].includes(name)) editedConfig.categories[cat].push(name);
    renderAdminPoints();
    renderAdminItems();
    renderAdminCategories();
    renderAdminAlways();
    toast('Пункт добавлен', cat + ' · ' + name);
    const el = $('newPointName');
    if (el) el.focus();
  };
  $('addPointBtn').onclick = addPoint;
  ['newPointName', 'newPointValue'].forEach(id => {
    $(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addPoint(); }
    });
  });

  const addPointToCat = (cat, nameInput, valInput) => {
    const name = nameInput.value.trim();
    const val = parseFloat(valInput.value);
    if (!name) { toast('Укажите название', '', 'error'); nameInput.focus(); return; }
    if (editedConfig.points[name] !== undefined) { toast('Пункт уже существует', name, 'error'); return; }
    if (editedConfig.categories[cat] === undefined) { toast('Отдел не найден', cat, 'error'); return; }
    editedConfig.points[name] = isNaN(val) ? 0 : val;
    Object.keys(editedConfig.categories).forEach(k => {
      editedConfig.categories[k] = editedConfig.categories[k].filter(i => i !== name);
    });
    editedConfig.categories[cat].push(name);
    renderAdminPoints();
    renderAdminItems();
    renderAdminCategories();
    renderAdminAlways();
    toast('Пункт добавлен', cat + ' · ' + name);
  };
  $('tabPoints').querySelectorAll('.a-cat-add').forEach(btn => {
    btn.onclick = () => {
      const wrap = btn.closest('.a-inline');
      addPointToCat(btn.dataset.cat, wrap.querySelector('.a-cat-new-name'), wrap.querySelector('.a-cat-new-value'));
    };
  });
  $('tabPoints').querySelectorAll('.a-cat-new-name').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.closest('.a-inline').querySelector('.a-cat-add').click(); }
    });
  });

  const addCat = () => {
    const name = $('newCatName').value.trim();
    if (!name) return toast('Укажите название', '', 'error');
    if (editedConfig.categories[name] !== undefined) return toast('Отдел уже существует', name, 'error');
    editedConfig.categories[name] = [];
    editedConfig.categoryOrder.push(name);
    editedConfig.categoryColors[name] = '#b6e04d';
    renderAdminPoints();
    renderAdminItems();
    renderAdminCategories();
    toast('Отдел добавлен', name);
    const el = $('newCatName');
    if (el) el.focus();
  };
  $('addCatBtn').onclick = addCat;
  $('newCatName').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addCat(); }
  });

  $('tabPoints').querySelectorAll('.cat-del').forEach(btn => {
    btn.onclick = () => {
      const cat = btn.dataset.cat;
      if (!cat) return;
      delete editedConfig.categories[cat];
      delete editedConfig.categoryColors[cat];
      editedConfig.categoryOrder = editedConfig.categoryOrder.filter(x => x !== cat);
      renderAdminPoints();
      renderAdminItems();
      renderAdminCategories();
      toast('Отдел удалён', cat);
    };
  });

  $('tabPoints').querySelectorAll('.a-cat-rename').forEach(input => {
    input.onchange = () => {
      const oldCat = input.dataset.cat;
      const newCat = input.value.trim();
      if (!oldCat || !newCat || oldCat === newCat) return;
      if (editedConfig.categories[newCat] !== undefined) {
        input.value = oldCat;
        return toast('Отдел с таким именем уже есть', '', 'error');
      }
      editedConfig.categories[newCat] = editedConfig.categories[oldCat];
      editedConfig.categoryColors[newCat] = editedConfig.categoryColors[oldCat];
      delete editedConfig.categories[oldCat];
      delete editedConfig.categoryColors[oldCat];
      editedConfig.categoryOrder = editedConfig.categoryOrder.map(x => x === oldCat ? newCat : x);
      renderAdminPoints();
      renderAdminItems();
      renderAdminCategories();
      toast('Отдел переименован', newCat);
    };
  });

  $('tabPoints').querySelectorAll('.cat-color').forEach(input => {
    input.oninput = () => {
      editedConfig.categoryColors[input.dataset.cat] = input.value;
      input.closest('.swatch').style.background = input.value;
    };
  });

  $('tabPoints').querySelectorAll('.a-pt-del').forEach(btn => {
    btn.onclick = () => {
      const row = btn.closest('.a-row');
      const name = row.dataset.orig;
      delete editedConfig.points[name];
      Object.keys(editedConfig.categories).forEach(cat => {
        editedConfig.categories[cat] = editedConfig.categories[cat].filter(i => i !== name);
      });
      removeAlwaysFromAll(editedConfig, name);
      renderAdminPoints();
      renderAdminItems();
      renderAdminAlways();
    };
  });

  $('tabPoints').querySelectorAll('.a-pt-name').forEach(input => {
    input.onchange = () => {
      const oldName = input.closest('.a-row').dataset.orig;
      const newName = input.value.trim();
      if (!oldName || !newName || oldName === newName) return;
      const val = editedConfig.points[oldName];
      delete editedConfig.points[oldName];
      editedConfig.points[newName] = val;
      Object.keys(editedConfig.categories).forEach(cat => {
        editedConfig.categories[cat] = editedConfig.categories[cat].map(i => i === oldName ? newName : i);
      });
      ensureAlwaysForm(editedConfig);
      ALWAYS_FORM_KEYS.forEach(f => {
        editedConfig.alwaysVisibleForm[f] = editedConfig.alwaysVisibleForm[f].map(i => i === oldName ? newName : i);
      });
      renderAdminPoints();
      renderAdminItems();
      renderAdminAlways();
    };
  });

  $('tabPoints').querySelectorAll('.a-pt-value').forEach(input => {
    input.onchange = () => {
      const name = input.closest('.a-row').dataset.orig;
      editedConfig.points[name] = parseFloat(input.value) || 0;
    };
  });
}

/* --- категории --- */
function renderAdminCategories() {
  const c = editedConfig;
  let html = '<div class="a-section"><h4>Категории</h4><div class="a-hint">Порядок категорий влияет на окно выбора пункта. Цвет подсвечивает заголовок в модалке.</div>';

  c.categoryOrder.forEach((cat, i) => {
    const count = (c.categories[cat] || []).length;
    const color = c.categoryColors[cat] || '#b6e04d';
    html += `<div class="a-card" data-cat="${escapeHtml(cat)}" data-index="${i}">
      <div class="a-card-head">
        <input type="text" class="cat-name" value="${escapeHtml(cat)}">
        <span class="swatch" style="background:${color}" title="Цвет категории">
          <input type="color" class="cat-color" value="${color}">
        </span>
        <span class="a-card-meta">${getDeclension(count, 'пункт', 'пункта', 'пунктов')}</span>
        <button type="button" class="a-move cat-up" ${i === 0 ? 'disabled style="opacity:.3"' : ''}>↑</button>
        <button type="button" class="a-move cat-down" ${i === c.categoryOrder.length - 1 ? 'disabled style="opacity:.3"' : ''}>↓</button>
        <button type="button" class="a-del cat-del" data-icon="trash"></button>
      </div>
    </div>`;
  });

  html += `</div><div class="a-add">
      <input type="text" id="newCategoryName" placeholder="Новая категория">
      <button type="button" class="a-btn" id="addCategoryBtn">+ Добавить</button>
    </div>`;
  $('tabCategories').querySelector('.admin-scroll').innerHTML = html;

  $('addCategoryBtn').onclick = () => {
    const name = $('newCategoryName').value.trim();
    if (!name) return toast('Укажите название', '', 'error');
    if (editedConfig.categories[name] !== undefined) return toast('Категория уже существует', name, 'error');
    editedConfig.categories[name] = [];
    editedConfig.categoryOrder.push(name);
    editedConfig.categoryColors[name] = '#b6e04d';
    renderAdminCategories();
    renderAdminItems();
    renderAdminPoints();
  };

  $('tabCategories').querySelectorAll('.cat-del').forEach(btn => {
    btn.onclick = () => {
      const card = btn.closest('.a-card');
      const cat = card.dataset.cat;
      delete editedConfig.categories[cat];
      delete editedConfig.categoryColors[cat];
      editedConfig.categoryOrder = editedConfig.categoryOrder.filter(x => x !== cat);
      renderAdminCategories();
      renderAdminItems();
      renderAdminPoints();
    };
  });

  $('tabCategories').querySelectorAll('.cat-name').forEach(input => {
    input.onchange = () => {
      const card = input.closest('.a-card');
      const oldCat = card.dataset.cat;
      const newCat = input.value.trim();
      if (!oldCat || !newCat || oldCat === newCat) return;
      if (editedConfig.categories[newCat] !== undefined) {
        input.value = oldCat;
        return toast('Категория с таким именем уже есть', '', 'error');
      }
      editedConfig.categories[newCat] = editedConfig.categories[oldCat];
      editedConfig.categoryColors[newCat] = editedConfig.categoryColors[oldCat];
      delete editedConfig.categories[oldCat];
      delete editedConfig.categoryColors[oldCat];
      editedConfig.categoryOrder = editedConfig.categoryOrder.map(x => x === oldCat ? newCat : x);
      renderAdminCategories();
      renderAdminItems();
      renderAdminPoints();
    };
  });

  $('tabCategories').querySelectorAll('.cat-color').forEach(input => {
    input.oninput = () => {
      const card = input.closest('.a-card');
      editedConfig.categoryColors[card.dataset.cat] = input.value;
      input.closest('.swatch').style.background = input.value;
    };
  });

  $('tabCategories').querySelectorAll('.cat-up').forEach(btn => {
    btn.onclick = () => {
      const cat = btn.closest('.a-card').dataset.cat;
      const i = editedConfig.categoryOrder.indexOf(cat);
      if (i > 0) {
        [editedConfig.categoryOrder[i - 1], editedConfig.categoryOrder[i]] = [editedConfig.categoryOrder[i], editedConfig.categoryOrder[i - 1]];
        renderAdminCategories();
        renderAdminItems();
        renderAdminPoints();
      }
    };
  });

  $('tabCategories').querySelectorAll('.cat-down').forEach(btn => {
    btn.onclick = () => {
      const cat = btn.closest('.a-card').dataset.cat;
      const i = editedConfig.categoryOrder.indexOf(cat);
      if (i < editedConfig.categoryOrder.length - 1) {
        [editedConfig.categoryOrder[i + 1], editedConfig.categoryOrder[i]] = [editedConfig.categoryOrder[i], editedConfig.categoryOrder[i + 1]];
        renderAdminCategories();
        renderAdminItems();
        renderAdminPoints();
      }
    };
  });
}

/* --- состав категорий --- */
function renderAdminItems() {
  const c = editedConfig;

  const order = (c.categoryOrder || []).filter(cat => c.categories[cat]);
  Object.keys(c.categories).forEach(cat => { if (!order.includes(cat)) order.push(cat); });

  const all = Object.keys(c.points);
  const catsOf = {};
  order.forEach(cat => (c.categories[cat] || []).forEach(i => {
    if (!catsOf[i]) catsOf[i] = [];
    catsOf[i].push(cat);
  }));

  const pinnedCount = all.filter(p => isAlwaysVisibleAnywhere(c, p)).length;
  const looseCount = all.filter(p => !isAlwaysVisibleAnywhere(c, p) && !(catsOf[p] || []).length).length;

  /* --- полный список всех пунктов --- */
  let html = `<div class="a-section"><h4>Все пункты (${all.length})</h4>
    <div class="a-hint">Полный список из вкладки «Баллы». Видно каждый пункт, его баллы и куда он отнесён: категория, «всегда видимый» (в какой форме) или «не распределён». Всего: ${all.length} · всегда видимых: ${pinnedCount} · без категории: ${looseCount}.</div>
    <div class="a-flat-list">`;
  html += all.length
    ? all.map(p => {
        const cats = catsOf[p] || [];
        const pinnedForms = ALWAYS_FORM_KEYS.filter(f => alwaysVisibleFor(c, f).includes(p));
        const tags = pinnedForms.length
          ? pinnedForms.map(f => `<span class="a-tag pinned">всегда · ${ALWAYS_FORM_SHORT[f]}</span>`).join('')
          : cats.length
            ? cats.map(x => `<span class="a-tag">${escapeHtml(x)}</span>`).join('')
            : '<span class="a-tag warn">не распределён</span>';
        return `<div class="a-item a-flat">
          <span class="a-flat-name">${escapeHtml(p)}</span>
          <span class="a-flat-tags">${tags}</span>
          <span class="a-flat-score">+${fmtPoints(c.points[p])}</span>
        </div>`;
      }).join('')
    : '<div class="a-empty">Пунктов пока нет — добавьте их во вкладке «Баллы».</div>';
  html += '</div></div>';

  /* --- состав категорий --- */
  html += '<div class="a-section"><h4>Состав категорий</h4><div class="a-hint">Пункты, которые пользователь сможет выбрать в модалке «Добавить пункт». В списке для добавления — все пункты; уже добавленные в эту категорию помечены как «в категории».</div>';

  order.forEach(cat => {
    const items = c.categories[cat] || [];
    const free = all.filter(p => !items.includes(p));
    const busy = all.filter(p => items.includes(p));
    const options = all.length
      ? free.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
          .concat(busy.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)} — в категории</option>`)).join('')
      : '<option value="">Нет пунктов — добавьте их во вкладке «Баллы»</option>';

    html += `<div class="a-card" data-cat="${escapeHtml(cat)}">
      <div class="a-card-head">
        <span style="font-weight:800">${escapeHtml(cat)}</span>
        <span class="a-card-meta" style="margin-left:auto">${getDeclension(items.length, 'пункт', 'пункта', 'пунктов')}</span>
      </div>
      <div class="a-card-body">`;
    html += items.length
      ? items.map(item => `<div class="a-item"><span>${escapeHtml(item)}</span><button type="button" class="a-del item-del" data-item="${escapeHtml(item)}" data-icon="close"></button></div>`).join('')
      : '<div class="a-empty">Пунктов пока нет</div>';
    html += `</div><div class="a-card-foot">
        <select class="item-pick">${options}</select>
        <button type="button" class="a-btn item-add">+ Добавить</button>
      </div></div>`;
  });

  html += '</div>';
  $('tabItems').querySelector('.admin-scroll').innerHTML = html;

  $('tabItems').querySelectorAll('.item-del').forEach(btn => {
    btn.onclick = () => {
      const cat = btn.closest('.a-card').dataset.cat;
      editedConfig.categories[cat] = editedConfig.categories[cat].filter(i => i !== btn.dataset.item);
      renderAdminItems();
      renderAdminCategories();
      renderAdminPoints();
    };
  });

  $('tabItems').querySelectorAll('.item-add').forEach(btn => {
    btn.onclick = () => {
      const card = btn.closest('.a-card');
      const cat = card.dataset.cat;
      const value = card.querySelector('.item-pick').value;
      if (!value) return;
      if (!editedConfig.categories[cat].includes(value)) editedConfig.categories[cat].push(value);
      renderAdminItems();
      renderAdminCategories();
      renderAdminPoints();
    };
  });
}

/* --- всегда видимые --- */
function renderAdminAlways() {
  const c = editedConfig;
  ensureAlwaysForm(c);

  let html = '<div class="a-section"><h4>Всегда видимые пункты по формам</h4><div class="a-hint">Каждый блок — свой набор фиксированных пунктов для своей формы (еженедельный отчёт / повышение / ночная активность). Эти пункты показываются в форме сразу, без кнопки «Добавить пункт»; для них ссылка и количество обязательны. Дублируются с перетаскиванием во вкладке «Пункты».</div>';

  const pinnedAny = new Set();
  ALWAYS_FORM_KEYS.forEach(f => alwaysVisibleFor(c, f).forEach(i => pinnedAny.add(i)));
  const available = Object.keys(c.points).filter(p => !pinnedAny.has(p));

  ALWAYS_FORM_KEYS.forEach(f => {
    const list = alwaysVisibleFor(c, f);
    const color = ALWAYS_FORM_COLOR[f];
    html += `<div class="av-group" style="--grp:${color}">
      <div class="av-head">
        <span class="av-dot"></span>
        <span class="av-name">${escapeHtml(formKindName(f))}</span>
        <span class="av-count">${list.length} ${getDeclension(list.length, 'пункт', 'пункта', 'пунктов')}</span>
      </div>
      <div class="av-chips">`;
    html += list.length
      ? list.map(item => `<span class="av-chip"><span class="pin-ico" data-icon="pin"></span><span class="av-chip-name">${escapeHtml(item)}</span><button type="button" class="av-chip-del always-del" data-form="${f}" data-item="${escapeHtml(item)}" data-icon="close" title="Убрать пункт"></button></span>`).join('')
      : '<span class="av-empty">Нет таких пунктов</span>';
    html += `</div>
      <div class="av-add">
        <select id="alwaysPick_${f}">${available.length ? available.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('') : '<option value="">Нет свободных пунктов</option>'}</select>
        <button type="button" class="a-btn addAlwaysBtn" data-form="${f}">+ Добавить</button>
      </div>
    </div>`;
  });

  html += '</div>';
  $('tabAlways').querySelector('.admin-scroll').innerHTML = html;

  $('tabAlways').querySelectorAll('.always-del').forEach(btn => {
    btn.onclick = () => {
      const f = btn.dataset.form;
      ensureAlwaysForm(editedConfig);
      editedConfig.alwaysVisibleForm[f] = editedConfig.alwaysVisibleForm[f].filter(i => i !== btn.dataset.item);
      renderAdminAlways();
    };
  });

  $('tabAlways').querySelectorAll('.addAlwaysBtn').forEach(btn => {
    btn.onclick = () => {
      const f = btn.dataset.form;
      ensureAlwaysForm(editedConfig);
      const value = $('alwaysPick_' + f).value;
      if (value && !editedConfig.alwaysVisibleForm[f].includes(value)) {
        editedConfig.alwaysVisibleForm[f].push(value);
      }
      renderAdminAlways();
    };
  });
}

/* --- фотохостинги --- */
function renderAdminPhoto() {
  const c = editedConfig;
  let html = '<div class="a-section"><h4>Фотохостинги</h4><div class="a-hint">Ссылки в шапке формы, куда пользователь может загрузить скриншот.</div>';

  c.photoHosts.forEach((h, i) => {
    html += `<div class="a-row" data-index="${i}">
      <input type="text" class="grow photo-name" value="${escapeHtml(h.name)}" placeholder="Название">
      <input type="text" class="grow photo-url" value="${escapeHtml(h.url)}" placeholder="https://">
      <button type="button" class="a-del photo-del" data-icon="close"></button>
    </div>`;
  });

  html += `</div><div class="a-add">
      <input type="text" id="newPhotoName" placeholder="Название хостинга">
      <input type="text" id="newPhotoUrl" placeholder="https://">
      <button type="button" class="a-btn" id="addPhotoBtn">+ Добавить</button>
    </div>`;
  $('tabPhoto').querySelector('.admin-scroll').innerHTML = html;

  $('tabPhoto').querySelectorAll('.photo-name').forEach((input, i) => {
    input.onchange = () => { editedConfig.photoHosts[i].name = input.value; };
  });
  $('tabPhoto').querySelectorAll('.photo-url').forEach((input, i) => {
    input.onchange = () => { editedConfig.photoHosts[i].url = input.value; };
  });
  $('tabPhoto').querySelectorAll('.photo-del').forEach((btn, i) => {
    btn.onclick = () => { editedConfig.photoHosts.splice(i, 1); renderAdminPhoto(); };
  });
  $('addPhotoBtn').onclick = () => {
    const name = $('newPhotoName').value.trim();
    const url = $('newPhotoUrl').value.trim();
    if (!name || !url) return toast('Заполните название и URL', '', 'error');
    editedConfig.photoHosts.push({ name, url });
    renderAdminPhoto();
  };
}

/* --- баннеры --- */
function renderAdminBanner() {
  const c = editedConfig;
  const block = (key, label) => {
    const b = c[key] || { url: '', visible: false, type: 'auto' };
    const type = b.type || 'auto';
    const isFile = String(b.url || '').startsWith('data:');
    const opt = (v, t) => `<option value="${v}"${type === v ? ' selected' : ''}>${t}</option>`;
    return `<div class="a-section">
      <h4>${label}</h4>
      <div class="a-preview" id="${key}Preview">${b.url ? bannerMarkup(b, { controls: true }) : 'Нет баннера'}</div>
      <div class="a-hint" id="${key}Meta" style="margin:6px 0 10px"></div>
      <input type="text" id="${key}Url" value="${escapeHtml(b.url)}" placeholder="https://... изображение, GIF, mp4/webm или ссылка YouTube">
      <div class="a-banner-row">
        <label class="a-banner-type">Тип контента
          <select id="${key}Type">
            ${opt('auto', 'Автоопределение')}
            ${opt('image', 'Изображение')}
            ${opt('gif', 'GIF')}
            ${opt('video', 'Видео (файл mp4/webm)')}
            ${opt('youtube', 'YouTube')}
          </select>
        </label>
        <label class="switch"><input type="checkbox" id="${key}Visible" ${b.visible ? 'checked' : ''}><span class="track"></span><span>Показывать баннер</span></label>
      </div>
      <div class="a-add">
        <button type="button" class="a-btn sec" id="${key}UploadBtn">Загрузить с устройства…</button>
        <input type="file" id="${key}File" accept="image/*,video/mp4,video/webm,video/ogg" class="hidden">
        ${isFile ? `<button type="button" class="a-btn danger" id="${key}ClearFileBtn">Убрать файл</button>` : ''}
      </div>
      <div class="a-hint" style="margin-top:10px">GIF отображается анимированным автоматически. «Видео» — прямая ссылка на файл (mp4/webm). «YouTube» — ссылка вида youtube.com/watch?v=… , youtu.be/… или /shorts/… — вставляется встроенный плеер.<br>Картинку, GIF или небольшое видео (mp4/webm до ~3 МБ) можно загрузить с этого устройства — файл сохранится в настройках браузера. Для больших видео используйте прямую ссылку.</div>
    </div>`;
  };

  $('tabBanner').querySelector('.admin-scroll').innerHTML =
    block('bannerWeekly', 'Баннер еженедельного отчёта') + block('bannerPromotion', 'Баннер отчёта на повышение') + block('bannerNight', 'Баннер ночной активности') + block('bannerStat', 'Баннер записи на стажировку') + block('bannerIntern', 'Баннер отчёта о стажировке') + block('bannerUnfit', 'Баннер профнепригодности');

  ['bannerWeekly', 'bannerPromotion', 'bannerNight', 'bannerStat', 'bannerIntern', 'bannerUnfit'].forEach(key => {
    const input = $(key + 'Url');
    const preview = $(key + 'Preview');
    const typeSel = $(key + 'Type');
    const meta = $(key + 'Meta');
    let metaTimer = null;
    const updateMeta = () => {
      clearTimeout(metaTimer);
      metaTimer = setTimeout(() => {
        const url = input.value.trim();
        if (!meta) return;
        if (!url) { meta.textContent = ''; return; }
        const t = bannerType({ url: url, type: typeSel.value });
        if (t === 'youtube') { meta.textContent = 'YouTube — встроенный плеер 16:9.'; return; }
        if (t === 'video') { meta.textContent = 'Видео — размер изображения не определяется.'; return; }
        const probe = new Image();
        probe.onload = () => {
          if (!meta || input.value.trim() !== url) return;
          const kb = url.startsWith('data:') ? ` · ${Math.round(url.length / 1024)} КБ` : '';
          meta.textContent = `Размер изображения: ${probe.naturalWidth}×${probe.naturalHeight} px${kb}`;
        };
        probe.onerror = () => {
          if (meta && input.value.trim() === url) meta.textContent = 'Не удалось определить размер изображения.';
        };
        probe.src = url;
      }, 350);
    };
    const refresh = () => {
      const url = input.value.trim();
      editedConfig[key] = editedConfig[key] || { url: '', visible: false, type: 'auto' };
      editedConfig[key].url = url;
      editedConfig[key].type = typeSel.value;
      preview.innerHTML = url ? bannerMarkup(editedConfig[key], { controls: true }) : 'Нет баннера';
      updateMeta();
    };
    input.oninput = refresh;
    typeSel.onchange = refresh;
    updateMeta();
    $(key + 'Visible').onchange = e => {
      editedConfig[key] = editedConfig[key] || { url: '', visible: false, type: 'auto' };
      editedConfig[key].visible = e.target.checked;
    };
    $(key + 'UploadBtn').onclick = () => $(key + 'File').click();
    $(key + 'File').onchange = e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) handleBannerFile(key, file);
    };
    const clearFile = $(key + 'ClearFileBtn');
    if (clearFile) clearFile.onclick = () => {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      renderAdminBanner();
    };
  });
}

const BANNER_FILE_MAX_LEN = 3500000;

function handleBannerFile(key, file) {
  if (!file) return;
  const isVideo = /^video\/(?:mp4|webm|ogg)$/.test(file.type || '');
  if (!/^image\//.test(file.type || '') && !isVideo) {
    toast('Файл не подходит', 'Нужно изображение (JPG, PNG, WebP, GIF, SVG) или видео mp4/webm.', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => toast('Не удалось прочитать файл', file.name, 'error');
  reader.onload = () => {
    const original = String(reader.result || '');
    const keepAsIs = isVideo || file.type === 'image/gif' || file.type === 'image/svg+xml' || original.length < 900000;
    const finish = url => {
      if (!url || url.length > BANNER_FILE_MAX_LEN) {
        toast('Файл слишком большой', 'В хранилище браузера помещается до ~3 МБ. Уменьшите файл или используйте прямую ссылку.', 'error');
        return;
      }
      const input = $(key + 'Url');
      const typeSel = $(key + 'Type');
      input.value = url;
      if (typeSel) typeSel.value = isVideo ? 'video' : (file.type === 'image/gif' ? 'gif' : 'image');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      renderAdminBanner();
      toast('Баннер загружен', `${file.name} (${Math.round(url.length / 1024)} КБ). Не забудьте нажать «Сохранить изменения».`);
    };
    if (keepAsIs) return finish(original);
    const img = new Image();
    img.onload = () => {
      try {
        const maxSide = 1600;
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(w * scale));
        cv.height = Math.max(1, Math.round(h * scale));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        let out = '';
        try { out = cv.toDataURL('image/webp', 0.85); } catch (e) { out = ''; }
        if (out.indexOf('data:image/webp') !== 0) out = cv.toDataURL('image/jpeg', 0.85);
        finish(out.indexOf('data:image/') === 0 ? out : original);
      } catch (e) {
        finish(original);
      }
    };
    img.onerror = () => finish(original);
    img.src = original;
  };
  reader.readAsDataURL(file);
}

/* --- заголовки и правила --- */
function renderAdminTitles() {
  const c = editedConfig;
  const rulesBlock = (key, list) => `
    <div class="admin-rules">
      ${list.map((r, i) => `<div class="a-row" data-i="${i}">
        <input type="text" class="grow rule-input" value="${escapeHtml(r)}">
        <button type="button" class="a-del rule-del" data-icon="close"></button>
      </div>`).join('') || '<div class="a-empty">Правил пока нет</div>'}
    </div>
    <div class="a-add">
      <input type="text" class="rule-new" placeholder="Новое правило">
      <button type="button" class="a-btn rule-add" data-key="${key}">+ Добавить</button>
    </div>`;

  $('tabTitles').querySelector('.admin-scroll').innerHTML = `
    <div class="a-section">
      <h4>Еженедельный отчёт</h4>
      <input type="text" id="weeklyTitleInput" value="${escapeHtml(c.weeklyTitle || '')}" placeholder="Заголовок отчёта" style="margin-bottom:14px">
      <div class="a-hint">Правила заполнения</div>
      ${rulesBlock('weeklyRules', c.weeklyRules)}
    </div>
    <div class="a-section">
      <h4>Отчёт на повышение</h4>
      <input type="text" id="promotionTitleInput" value="${escapeHtml(c.promotionTitle || '')}" placeholder="Заголовок отчёта" style="margin-bottom:14px">
      <div class="a-hint">Правила заполнения</div>
      ${rulesBlock('promotionRules', c.promotionRules)}
    </div>
    <div class="a-section">
      <h4>Ночная активность</h4>
      <input type="text" id="nightTitleInput" value="${escapeHtml(c.nightTitle || '')}" placeholder="Заголовок отчёта" style="margin-bottom:14px">
      <div class="a-hint">Правила заполнения</div>
      ${rulesBlock('nightRules', c.nightRules)}
    </div>
    <div class="a-section">
      <h4>Запись на стажировку</h4>
      <input type="text" id="statTitleInput" value="${escapeHtml(c.statTitle || '')}" placeholder="Заголовок формы" style="margin-bottom:14px">
      <div class="a-hint">Правила заполнения</div>
      ${rulesBlock('statRules', c.statRules)}
    </div>
    <div class="a-section">
      <h4>Отчёт о стажировке</h4>
      <input type="text" id="internTitleInput" value="${escapeHtml(c.internTitle || '')}" placeholder="Заголовок формы" style="margin-bottom:14px">
      <div class="a-hint">Правила заполнения</div>
      ${rulesBlock('internRules', c.internRules)}
    </div>
    <div class="a-section">
      <h4>Профнепригодность</h4>
      <input type="text" id="unfitTitleInput" value="${escapeHtml(c.unfitTitle || '')}" placeholder="Заголовок формы" style="margin-bottom:14px">
      <div class="a-hint">Правила заполнения</div>
      ${rulesBlock('unfitRules', c.unfitRules)}
    </div>`;

  $('weeklyTitleInput').oninput = e => { editedConfig.weeklyTitle = e.target.value; };
  $('promotionTitleInput').oninput = e => { editedConfig.promotionTitle = e.target.value; };
  $('nightTitleInput').oninput = e => { editedConfig.nightTitle = e.target.value; };
  $('statTitleInput').oninput = e => { editedConfig.statTitle = e.target.value; };
  $('internTitleInput').oninput = e => { editedConfig.internTitle = e.target.value; };
  $('unfitTitleInput').oninput = e => { editedConfig.unfitTitle = e.target.value; };

  $('tabTitles').querySelectorAll('.rule-input').forEach(input => {
    input.oninput = () => {
      const key = input.closest('.a-section').querySelector('.rule-add').dataset.key;
      const idx = Number(input.closest('.a-row').dataset.i);
      editedConfig[key][idx] = input.value;
    };
  });
  $('tabTitles').querySelectorAll('.rule-del').forEach(btn => {
    btn.onclick = () => {
      const key = btn.closest('.a-section').querySelector('.rule-add').dataset.key;
      const idx = Number(btn.closest('.a-row').dataset.i);
      editedConfig[key].splice(idx, 1);
      renderAdminTitles();
    };
  });
  $('tabTitles').querySelectorAll('.rule-add').forEach(btn => {
    btn.onclick = () => {
      const input = btn.previousElementSibling;
      const value = input.value.trim();
      if (!value) return;
      editedConfig[btn.dataset.key].push(value);
      renderAdminTitles();
    };
  });
}

/* --- стажировка: вопросы для стажёра --- */
function renderAdminQuiz() {
  const c = editedConfig;
  c.quizSections = Array.isArray(c.quizSections) ? c.quizSections : [];
  c.quizSections.forEach(sec => { if (!Array.isArray(sec.items)) sec.items = []; });

  let html = `<div class="a-section">
    <h4>Раздел «Вопросы для стажировки»</h4>
    <div class="a-hint">Заголовок, вступление, практика и список вопросов показываются в разделе 05. Меняйте текст, добавляйте и удаляйте вопросы — изменения применятся после «Сохранить изменения».</div>
    <input type="text" id="quizTitleInput" value="${escapeHtml(c.quizTitle || '')}" placeholder="Заголовок раздела" style="margin:10px 0">
    <div class="a-hint">Вступление (каждая строка — отдельный абзац)</div>
    <textarea id="quizIntroInput" class="a-textarea" rows="6">${escapeHtml(c.quizIntro || '')}</textarea>
    <div class="a-hint">Практическая часть</div>
    <textarea id="quizPracticeInput" class="a-textarea" rows="6">${escapeHtml(c.quizPractice || '')}</textarea>
  </div>`;

  c.quizSections.forEach((sec, gi) => {
    html += `<div class="a-section" data-g="${gi}">
      <div class="a-add">
        <input type="text" class="grow quiz-sec-name" data-g="${gi}" value="${escapeHtml(sec.name || '')}" placeholder="Название группы вопросов">
        <button type="button" class="a-btn danger quiz-sec-del" data-g="${gi}">Удалить группу</button>
      </div>`;
    (sec.items || []).forEach((it, ii) => {
      html += `<div class="a-row quiz-edit-row" data-g="${gi}" data-i="${ii}" style="grid-column:1/-1;align-items:flex-start">
        <div class="quiz-edit-fields">
          <input type="text" class="grow quiz-q" data-g="${gi}" data-i="${ii}" value="${escapeHtml(it.q || '')}" placeholder="Вопрос">
          <textarea class="a-textarea quiz-a" data-g="${gi}" data-i="${ii}" rows="2" placeholder="Ответ">${escapeHtml(it.a || '')}</textarea>
        </div>
        <button type="button" class="a-del quiz-item-del" data-g="${gi}" data-i="${ii}" data-icon="close" title="Удалить вопрос"></button>
      </div>`;
    });
    html += `<div class="a-add"><button type="button" class="a-btn quiz-item-add" data-g="${gi}">+ Добавить вопрос</button></div></div>`;
  });
  html += `<div class="a-section"><button type="button" class="a-btn quiz-sec-add">+ Добавить группу вопросов</button></div>`;

  $('tabQuiz').querySelector('.admin-scroll').innerHTML = html;

  const titleEl = $('quizTitleInput');
  if (titleEl) titleEl.oninput = () => { editedConfig.quizTitle = titleEl.value; };
  const introEl = $('quizIntroInput');
  if (introEl) introEl.oninput = () => { editedConfig.quizIntro = introEl.value; };
  const pracEl = $('quizPracticeInput');
  if (pracEl) pracEl.oninput = () => { editedConfig.quizPractice = pracEl.value; };

  $('tabQuiz').querySelectorAll('.quiz-sec-name').forEach(inp => {
    inp.oninput = () => { editedConfig.quizSections[+inp.dataset.g].name = inp.value; };
  });
  $('tabQuiz').querySelectorAll('.quiz-q').forEach(inp => {
    inp.oninput = () => { editedConfig.quizSections[+inp.dataset.g].items[+inp.dataset.i].q = inp.value; };
  });
  $('tabQuiz').querySelectorAll('.quiz-a').forEach(inp => {
    inp.oninput = () => { editedConfig.quizSections[+inp.dataset.g].items[+inp.dataset.i].a = inp.value; };
  });
  $('tabQuiz').querySelectorAll('.quiz-item-del').forEach(btn => {
    btn.onclick = () => {
      editedConfig.quizSections[+btn.dataset.g].items.splice(+btn.dataset.i, 1);
      renderAdminQuiz();
    };
  });
  $('tabQuiz').querySelectorAll('.quiz-item-add').forEach(btn => {
    btn.onclick = () => {
      editedConfig.quizSections[+btn.dataset.g].items.push({ q: '', a: '' });
      renderAdminQuiz();
    };
  });
  $('tabQuiz').querySelectorAll('.quiz-sec-del').forEach(btn => {
    btn.onclick = () => {
      editedConfig.quizSections.splice(+btn.dataset.g, 1);
      renderAdminQuiz();
    };
  });
  const addSec = $('tabQuiz').querySelector('.quiz-sec-add');
  if (addSec) addSec.onclick = () => {
    editedConfig.quizSections.push({ name: 'Новая группа', items: [{ q: '', a: '' }] });
    renderAdminQuiz();
  };
}

/* --- блок 08 «Списки на премию»: вид сообщения --- */
function renderAdminPremium() {
  const c = editedConfig;
  c.premiumTemplate = Object.assign({}, DEFAULT_CONFIG.premiumTemplate, c.premiumTemplate || {});
  const t = c.premiumTemplate;

  const field = (id, label, hint, value) => `
    <div class="a-hint" style="margin-top:14px;color:var(--text)">${label}</div>
    <input type="text" id="${id}" value="${escapeHtml(value || '')}" style="margin-bottom:5px">
    <div class="a-hint" style="margin-top:0">${hint}</div>`;

  $('tabPremium').querySelector('.admin-scroll').innerHTML = `
    <div class="a-section">
      <h4>Списки на премию — вид сообщения</h4>
      <div class="a-hint">
        Меняйте текст и оформление готового сообщения для раздела 08. Изменения сохраняются на сервере
        и применяются у всех, кто откроет раздел (после «Сохранить изменения»).<br>
        Плейсхолдеры в фигурных скобках подставляются автоматически — их можно переставлять, дублировать и убирать.
      </div>
      ${field('premiumHeaderInput', 'Заголовок', 'Доступно: {role} — упоминание роли, {week} — период недели.', t.header)}
      ${field('premiumDividerInput', 'Разделитель', 'Строка-разделитель между блоками.', t.divider)}
      ${field('premiumSeniorInput', 'Строка старшего состава', 'Доступно: {id} — сотрудник, {emoji} — эмодзи, {sp} — отступ для выравнивания (у 3-й строки больше).', t.senior)}
      ${field('premiumPersonInput', 'Строка сотрудника', 'Доступно: {id} — сотрудник, {points} — баллы, {link} — ссылка на отчёт, {d} — участие в наборах.', t.person)}
      ${field('premiumKingInput', 'Строка доски почёта и унижений', 'Доступно: {kingIcon} — эмодзи короны, {id} — сотрудник с максимумом баллов, {points} — баллы.', t.king)}
      <div class="a-add" style="margin-top:16px">
        <button type="button" class="a-btn danger" id="premiumResetBtn">Сбросить к стандартному</button>
      </div>
      <div class="a-hint" style="margin-top:16px;color:var(--text)">Предпросмотр (пример данных)</div>
      <textarea id="premiumPreviewOut" class="premium-text" style="min-height:320px;height:320px" readonly spellcheck="false"></textarea>
    </div>`;

  const preview = () => {
    const sample = {
      week: '05.10.2026 - 11.10.2026',
      seniors: ['<@1112382276752375829>', '<@1247600511058841726>', '<@1079772664496918629>'],
      people: [
        { id: '<@951191743678783628>', points: 18510, link: 'https://discord.com/channels/0/0', d: 1234 },
        { id: '<@880123154297675796>', points: 1250, link: 'https://discord.com/channels/0/0', d: 99 }
      ],
      top: { id: '<@951191743678783628>', points: 18510 }
    };
    $('premiumPreviewOut').value = buildPremiumText(sample, editedConfig.premiumTemplate);
  };

  const bind = (id, key) => {
    const el = $(id);
    if (el) el.oninput = () => { editedConfig.premiumTemplate[key] = el.value; preview(); };
  };
  bind('premiumHeaderInput', 'header');
  bind('premiumDividerInput', 'divider');
  bind('premiumSeniorInput', 'senior');
  bind('premiumPersonInput', 'person');
  bind('premiumKingInput', 'king');

  const rs = $('premiumResetBtn');
  if (rs) rs.onclick = () => {
    editedConfig.premiumTemplate = Object.assign({}, DEFAULT_CONFIG.premiumTemplate);
    renderAdminPremium();
  };
  preview();
}

/* --- отправка --- */
const WEBHOOK_SLOTS = [
  { slot: 'promotion', name: 'Отчёт на повышение', desc: 'В этот канал уходят отчёты из раздела «Отчёт на повышение» с упоминанием ролей.' },
  { slot: 'weekly', name: 'Еженедельный отчёт', desc: 'В этот канал уходят еженедельные отчёты с упоминанием ролей.' },
  { slot: 'night', name: 'Ночная активность', desc: 'В этот канал уходят отчёты о ночной активности с упоминанием ролей.' },
  { slot: 'stat', name: 'Запись на стажировку', desc: 'В этот канал уходят заявки на стажировку с упоминанием ролей.' },
  { slot: 'intern', name: 'Отчёт о стажировке', desc: 'В этот канал уходят отчёты о проведённых стажировках с упоминанием ролей.' },
  { slot: 'unfit', name: 'Профнепригодность', desc: 'В этот канал уходят отчёты о профнепригодности с фото и упоминанием ролей.' },
  { slot: 'announce', name: 'Анонсы наборов', desc: 'В этот канал уходят анонсы наборов из вкладки «Наборы»: пинги ролей, дата и список времени.' },
  { slot: 'sets', name: 'Результаты наборов', desc: 'В этот канал уходят итоги наборов из блока 10: тип набора, время, количество принятых и пинги составов.' }
];

function renderAdminSend() {
  $('tabSend').querySelector('.admin-scroll').innerHTML =
    `<div class="a-section">
      <h4>Вебхуки Discord</h4>
      <div class="a-hint">
        Ссылки на вебхуки хранятся на сервере (Vercel) и на сайт не передаются — их нельзя подсмотреть в исходном коде.<br>
        Чтобы изменить вебхук, вставьте ссылку в поле нужного раздела и нажмите «Сохранить». Ранее сохранённые ссылки сервер не показывает в целях безопасности.
      </div>
      <div class="a-hint" style="margin-top:14px">Секрет сервера (выдаётся владельцем сайта). Вводится один раз — доступ действует 24 часа, сам секрет в браузере не сохраняется.</div>
      <input type="password" id="adminSecretInput" placeholder="секрет сервера" autocomplete="off" style="margin-bottom:10px">
      <div class="a-add">
        <button type="button" class="a-btn sec" id="saveAdminSecretBtn">Подтвердить доступ</button>
      </div>
      <div id="adminSecretStatus" class="a-hint" style="margin-top:10px"></div>
    </div>` +
    WEBHOOK_SLOTS.map(s => `
    <div class="a-section">
      <h4>Discord вебхук — ${s.name}</h4>
      <div class="a-hint">${s.desc}</div>
      <input type="text" id="whUrl_${s.slot}" placeholder="https://discord.com/api/webhooks/..." style="margin:10px 0">
      <div class="a-add">
        <button type="button" class="a-btn" id="saveWebhookBtn_${s.slot}">Сохранить</button>
        <button type="button" class="a-btn danger" id="clearWebhookBtn_${s.slot}">Отключить</button>
        <button type="button" class="a-btn sec" id="testWebhookBtn_${s.slot}">Тестовое сообщение</button>
        <button type="button" class="a-btn" id="refreshWebhookBtn_${s.slot}">Проверить статус</button>
      </div>
      <div id="statusWebhook_${s.slot}" class="a-hint" style="margin-top:12px"></div>
    </div>`).join('') +
    `<div class="a-section">
      <h4>Google Таблица — Еженедельки</h4>
      <div class="a-hint">
        Ссылка на веб-приложение Apps Script, которое по каждому еженедельному отчёту создаёт лист недели
        («дд.мм.гггг - дд.мм.гггг») и записывает строку: Имя, Баллы, участие в наборах, осмотры, ПМП, уколы,
        мед. карты и ссылку на сообщение Discord. Колонка «Еженеделька» (Сдал / Не сдал / Отпуск / Освобождён)
        остаётся для ручного заполнения. Готовый код скрипта и инструкция — у владельца сайта.
      </div>
      <input type="text" id="gsheetUrlInput" placeholder="https://script.google.com/macros/s/.../exec" style="margin:10px 0">
      <div class="a-add">
        <button type="button" class="a-btn" id="saveGSheetBtn">Сохранить</button>
        <button type="button" class="a-btn danger" id="clearGSheetBtn">Отключить</button>
        <button type="button" class="a-btn" id="refreshGSheetBtn">Проверить статус</button>
      </div>
      <div id="statusGSheet" class="a-hint" style="margin-top:12px"></div>
    </div>`;

  $('saveAdminSecretBtn').onclick = saveAdminSecret;
  WEBHOOK_SLOTS.forEach(s => {
    $('testWebhookBtn_' + s.slot).onclick = () => testWebhook(s.slot);
    $('refreshWebhookBtn_' + s.slot).onclick = () => refreshWebhookStatus(s.slot);
    $('saveWebhookBtn_' + s.slot).onclick = () => saveWebhookConfig(s.slot);
    $('clearWebhookBtn_' + s.slot).onclick = () => clearWebhookConfig(s.slot, $('clearWebhookBtn_' + s.slot));
  });
  $('saveGSheetBtn').onclick = saveGSheet;
  $('clearGSheetBtn').onclick = () => clearGSheet($('clearGSheetBtn'));
  $('refreshGSheetBtn').onclick = refreshGSheetStatus;
  refreshAllWebhookStatus();
}

/* ---- Оформление сообщений ботов: вкладка «Сообщения» ---- */
const BOT_MESSAGE_BLOCKS = [
  { id: 'weekly', label: '01 · Еженедельный отчёт' },
  { id: 'promotion', label: '02 · Отчёт на повышение' },
  { id: 'night', label: '03 · Ночная активность' },
  { id: 'stat', label: '04 · Запись на стажировку' },
  { id: 'intern', label: '06 · Отчёт о стажировке' },
  { id: 'unfit', label: '07 · Профнепригодность' },
  { id: 'sets', label: '10 · Результаты наборов' }
];

/* Палитра для кастомного выбора цвета полосы (в стиле сайта). */
const BOT_COLOR_PRESETS = [
  '#b6e04d', '#7be495', '#5ad1ff', '#a0b4ff',
  '#c78bff', '#ff8fb1', '#ffc454', '#ffb86b',
  '#ff6a6a', '#f6f1e9'
];
const BOT_COLOR_DEFAULT = '#b6e04d';

function botNormalizeHex(value) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
  return m ? '#' + m[1].toLowerCase() : '';
}


/* Примерные строки для предпросмотра — реальные данные подставятся при отправке. */
const BOT_PREVIEW_SAMPLES = {
  weekly: [
    '**Имя фамилия**', '> Sokrat Celleste', '',
    '**Период подачи отчёта**', '> 03.11 – 09.11', '',
    '**Пункты:**', '**Провести осмотр**', '[10](ссылка) | 10 баллов', '',
    '**Общее кол-во баллов:** `42`'
  ],
  promotion: [
    '**Имя фамилия**', '> Sokrat Celleste', '',
    '**С какого на какой ранг**', '> 3 → 4', '',
    '**Пункты:**', '**Участие в наборах граждан в ряды EMS**', '[2](ссылка) | 30 баллов', '',
    '**Общее кол-во баллов:** `30`'
  ],
  night: [
    '**Имя фамилия**', '> Sokrat Celleste', '',
    '**Период активности**', '> 03.11 – 09.11', '',
    '**Пункты:**', '**Участие в ночных наборах граждан в ряды EMS**', '[1](ссылка) | 20 баллов', '',
    '**Общее кол-во баллов:** `20`'
  ],
  stat: [
    '**Имя фамилия**', '> Sokrat Celleste', '',
    '**ID пользователя (Discord)**', '> 512137319088783360', '',
    '**Ссылка на присутствие в наборе в EMS**', '> ссылка', '',
    '**Удобное для вас время прохождения стажировки**', '> после 18:00'
  ],
  intern: [
    'Принимал:', '@Sokrat Celleste', '',
    'Сдавал:', '@Sokrat Celleste', '',
    'Результат: Сдал'
  ],
  unfit: [
    'Отправил', '@Sokrat Celleste', '',
    'Сотрудник', '@Sokrat Celleste', '',
    'ФИ сотрудника:', 'Sokrat Celleste',
    'Паспорт Сотрудника:', '123456',
    'Дата последнего повышения:', '01.11.2026',
    'Ранг Сотрудника:', '3',
    'Фото: во вложении'
  ],
  sets: [
    '1. EMS LS',
    '2. 15:00 – 15:40',
    '3. 0',
    '4. @Artemy Sakurai',
    '5. @Iza Dias',
    '6. @Стажёр ИП'
  ]
};

function ensureBotMessages(c) {
  c.botMessages = c.botMessages && typeof c.botMessages === 'object' ? c.botMessages : {};
  BOT_MESSAGE_BLOCKS.forEach(m => {
    const def = (DEFAULT_CONFIG.botMessages && DEFAULT_CONFIG.botMessages[m.id]) || {};
    const cur = c.botMessages[m.id] && typeof c.botMessages[m.id] === 'object' ? c.botMessages[m.id] : {};
    c.botMessages[m.id] = Object.assign(deepClone(def), cur);
    if (!Array.isArray(c.botMessages[m.id].roles)) {
      c.botMessages[m.id].roles = Array.isArray(def.roles) ? def.roles.slice() : [];
    }
  });
}

function botPreviewHtml(block, ui) {
  const rolePills = ui.roles
    .map(id => `<span class="ann-pv-role">@${escapeHtml(announceRoleName(id))}</span>`)
    .join('');
  const cta = ui.content ? `<div class="ann-pv-cta">${announceMdInline(ui.content)}</div>` : '';
  const title = ui.title ? `<div class="ann-pv-title">${announceMdInline(ui.title)}</div>` : '';
  const foot = ui.footer ? `<div class="ann-pv-foot"><span>${announceMdInline(ui.footer)}</span></div>` : '';
  const body = (BOT_PREVIEW_SAMPLES[block] || [])
    .map(line => `<div class="bot-pv-line">${announceMdInline(line) || '&nbsp;'}</div>`)
    .join('');
  const avatar = ui.avatar
    ? `<img src="${escapeHtml(ui.avatar)}" alt="">`
    : '';
  return `
    <div class="ann-pv-head">
      <span class="ann-pv-avatar">${avatar}</span>
      <span class="ann-pv-name">${escapeHtml(ui.username || 'Бот')}</span>
      <span class="ann-pv-app">APP</span>
      <span class="ann-pv-time">сегодня</span>
    </div>
    <div class="ann-pv-body">
      <div class="ann-pv-roles">${rolePills}</div>
      ${cta}
      <div class="ann-pv-embed" style="border-left-color:${escapeHtml(ui.color)}">
        <div class="ann-pv-embed-in">
          ${title}
          <div class="ann-pv-list">${body}</div>
          ${foot}
        </div>
      </div>
    </div>`;
}

function botColorFieldHtml(meta, rawColor) {
  const color = botNormalizeHex(rawColor) || BOT_COLOR_DEFAULT;
  const swatches = BOT_COLOR_PRESETS.map(c => {
    const active = c.toLowerCase() === color ? ' active' : '';
    return `<button type="button" class="bot-color-opt${active}" data-bot-color="${c}" style="background:${c}" title="${c}" aria-label="${c}"></button>`;
  }).join('');
  return `
    <div class="bot-msg-field">
      <span class="bot-msg-label">Цвет полосы</span>
      <div class="bot-color-field">
        <button type="button" class="bot-color-btn" id="botColorBtn_${meta.id}" aria-haspopup="true" aria-expanded="false">
          <span class="bot-color-swatch" id="botColorSwatch_${meta.id}" style="background:${color}"></span>
          <span class="bot-color-value" id="botColorValue_${meta.id}">${color}</span>
          <span class="bot-color-caret" aria-hidden="true">▾</span>
        </button>
        <div class="bot-color-pop" id="botColorPop_${meta.id}" hidden>
          <div class="bot-color-grid">${swatches}</div>
          <div class="bot-color-custom">
            <input type="text" id="botColorInput_${meta.id}" value="${color}" maxlength="7"
                   spellcheck="false" autocomplete="off" placeholder="${BOT_COLOR_DEFAULT}">
            <button type="button" class="a-btn sec" id="botColorApply_${meta.id}">ОК</button>
          </div>
          <div class="bot-color-error" id="botColorError_${meta.id}"></div>
        </div>
      </div>
    </div>`;
}

function botMessageSectionHtml(meta) {
  const ui = resolveBotMessage(meta.id, editedConfig);
  const roles = ui.roles.map(id =>
    `<span class="bot-role-chip">@${escapeHtml(announceRoleName(id))}<button type="button" data-bot-role-remove="${id}" title="Убрать пинг">×</button></span>`
  ).join('');
  return `
    <div class="a-section" data-bot-block="${meta.id}">
      <h4>${escapeHtml(meta.label)}</h4>
      <div class="a-hint">Имя бота, аватар, цвет полосы, заголовок, подпись, дополнительный текст и пинги ролей. Пустое поле — значение по умолчанию.</div>
      <div class="bot-msg-grid">
        <label>Имя бота<input type="text" id="botName_${meta.id}" value="${escapeHtml(ui.username)}"></label>
        <label>Аватар (URL)<input type="text" id="botAvatar_${meta.id}" value="${escapeHtml(ui.avatar)}"></label>
        ${botColorFieldHtml(meta, ui.color)}
        <label>Заголовок embed<input type="text" id="botTitle_${meta.id}" value="${escapeHtml(ui.title)}"></label>
        <label>Подпись (footer)<input type="text" id="botFooter_${meta.id}" value="${escapeHtml(ui.footer)}"></label>
        <label>Доп. текст сообщения<input type="text" id="botContent_${meta.id}" value="${escapeHtml(ui.content)}"></label>
      </div>
      <div class="a-hint" style="margin-top:12px">Пинги ролей</div>
      <div class="bot-role-list" id="botRoles_${meta.id}">${roles || '<span class="a-hint">Пингов нет</span>'}</div>
      <div class="bot-role-add">
        <input type="text" id="botRoleAdd_${meta.id}" placeholder="ID роли или <@&512137319088783360>">
        <button type="button" class="a-btn sec" id="botRoleAddBtn_${meta.id}">Добавить роль</button>
        <button type="button" class="a-btn danger" id="botReset_${meta.id}">Сбросить</button>
      </div>
      <div class="a-hint" style="margin-top:14px">Предпросмотр сообщения</div>
      <div class="ann-preview" id="botPreview_${meta.id}" style="margin-top:8px"></div>
    </div>`;
}

function renderBotPreview(block) {
  const el = $('botPreview_' + block);
  if (!el) return;
  el.innerHTML = botPreviewHtml(block, resolveBotMessage(block, editedConfig));
}

function renderAdminMessages() {
  const root = document.querySelector('#tabMessages .admin-scroll');
  if (!root) return;
  ensureBotMessages(editedConfig);

  /* Клик вне палитры закрывает открытое меню цвета. */
  if (!renderAdminMessages.outsideBound) {
    renderAdminMessages.outsideBound = true;
    document.addEventListener('click', () => {
      document.querySelectorAll('.bot-color-pop.open').forEach(p => {
        p.classList.remove('open', 'up');
        p.hidden = true;
        const id = String(p.id || '').replace('botColorPop_', '');
        const btn = id ? $('botColorBtn_' + id) : null;
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });
    });
  }

  root.innerHTML =
    `<div class="a-section">
      <h4>Сообщения ботов</h4>
      <div class="a-hint">
        У каждого блока своё оформление: имя и аватар бота, цвет карточки, заголовок, подпись,
        дополнительный текст и роли для пинга. Изменения применяются после «Сохранить изменения»
        и публикуются для всех пользователей.
      </div>
    </div>` +
    BOT_MESSAGE_BLOCKS.map(botMessageSectionHtml).join('');

  BOT_MESSAGE_BLOCKS.forEach(meta => {
    const block = meta.id;
    const fields = { Name: 'username', Avatar: 'avatar', Title: 'title', Footer: 'footer', Content: 'content' };
    Object.keys(fields).forEach(suffix => {
      const el = $('bot' + suffix + '_' + block);
      if (!el) return;
      el.addEventListener('input', () => {
        editedConfig.botMessages[block][fields[suffix]] = el.value;
        renderBotPreview(block);
      });
    });

    const colorBtn = $('botColorBtn_' + block);
    const colorPop = $('botColorPop_' + block);
    const colorSwatch = $('botColorSwatch_' + block);
    const colorValue = $('botColorValue_' + block);
    const colorInput = $('botColorInput_' + block);
    const colorError = $('botColorError_' + block);

    const closeColorPop = () => {
      if (!colorPop) return;
      colorPop.classList.remove('open', 'up');
      colorPop.hidden = true;
      if (colorBtn) colorBtn.setAttribute('aria-expanded', 'false');
    };

    const applyBotColor = (raw, silent) => {
      const hex = botNormalizeHex(raw);
      if (!hex) {
        if (colorError && !silent) colorError.textContent = 'Формат: #b6e04d';
        return false;
      }
      editedConfig.botMessages[block].color = hex;
      if (colorSwatch) colorSwatch.style.background = hex;
      if (colorValue) colorValue.textContent = hex;
      if (colorInput && colorInput.value.toLowerCase() !== hex) colorInput.value = hex;
      if (colorError) colorError.textContent = '';
      if (colorPop) {
        colorPop.querySelectorAll('.bot-color-opt').forEach(opt => {
          opt.classList.toggle('active',
            String(opt.getAttribute('data-bot-color') || '').toLowerCase() === hex);
        });
      }
      renderBotPreview(block);
      return true;
    };

    if (colorBtn && colorPop) {
      colorBtn.onclick = e => {
        e.stopPropagation();
        const willOpen = colorPop.hidden;
        document.querySelectorAll('.bot-color-pop.open').forEach(p => {
          p.classList.remove('open', 'up');
          p.hidden = true;
        });
        document.querySelectorAll('.bot-color-btn[aria-expanded="true"]').forEach(b => {
          b.setAttribute('aria-expanded', 'false');
        });
        if (willOpen) {
          colorPop.hidden = false;
          colorPop.classList.add('open');
          colorBtn.setAttribute('aria-expanded', 'true');
          /* Если снизу мало места — раскрываем палитру вверх. */
          const scroller = colorPop.closest('.admin-scroll');
          const bounds = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
          const rect = colorBtn.getBoundingClientRect();
          const below = bounds.bottom - rect.bottom;
          const above = rect.top - bounds.top;
          colorPop.classList.toggle('up', below < 240 && above > below);
          if (colorInput) { colorInput.focus(); colorInput.select(); }
        }
      };
      colorPop.addEventListener('click', e => e.stopPropagation());
      colorPop.querySelectorAll('.bot-color-opt').forEach(opt => {
        opt.onclick = () => {
          applyBotColor(opt.getAttribute('data-bot-color'));
          closeColorPop();
        };
      });
    }

    if (colorInput) {
      colorInput.addEventListener('input', () => applyBotColor(colorInput.value, true));
      colorInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (applyBotColor(colorInput.value)) closeColorPop();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeColorPop();
        }
      });
    }

    const colorApply = $('botColorApply_' + block);
    if (colorApply) {
      colorApply.onclick = () => {
        if (applyBotColor(colorInput ? colorInput.value : '')) closeColorPop();
      };
    }

    const addInput = $('botRoleAdd_' + block);
    const addBtn = $('botRoleAddBtn_' + block);
    const addRoles = () => {
      const found = [];
      const re = /<@&?(\d{15,25})>|(\d{15,25})/g;
      let m;
      while ((m = re.exec(addInput.value || ''))) {
        const id = m[1] || m[2];
        if (found.indexOf(id) === -1) found.push(id);
      }
      if (!found.length) {
        toast('Не добавлено', 'Вставьте ID роли или упоминание <@&…>.', 'error');
        return;
      }
      const list = editedConfig.botMessages[block].roles || [];
      found.forEach(id => { if (list.indexOf(id) === -1) list.push(id); });
      editedConfig.botMessages[block].roles = list;
      addInput.value = '';
      renderAdminMessages();
      toast('Роль добавлена', found.length + ' шт.');
    };
    if (addBtn) addBtn.onclick = addRoles;
    if (addInput) addInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addRoles(); }
    });

    const listEl = $('botRoles_' + block);
    if (listEl) {
      listEl.onclick = e => {
        const btn = e.target.closest('[data-bot-role-remove]');
        if (!btn) return;
        const id = btn.getAttribute('data-bot-role-remove');
        editedConfig.botMessages[block].roles =
          (editedConfig.botMessages[block].roles || []).filter(r => r !== id);
        renderAdminMessages();
      };
    }

    const resetBtn = $('botReset_' + block);
    if (resetBtn) {
      resetBtn.onclick = () => {
        editedConfig.botMessages[block] = deepClone(DEFAULT_CONFIG.botMessages[block]);
        renderAdminMessages();
        toast('Сброшено', 'Блок вернулся к стандартному оформлению.');
      };
    }
  });

  BOT_MESSAGE_BLOCKS.forEach(meta => renderBotPreview(meta.id));
}

/* ---- Анонс наборов: собрать сообщение и отправить в Discord ---- */
const ANNOUNCE_PRESETS_DEFAULT = ['13:00 – 13:40', '15:00 – 15:40', '17:00 – 17:40'];
const ANNOUNCE_PRESETS_KEY = 'ems.announce.presets';
const ANNOUNCE_LAST_KEY = 'ems.announce.last';
const ANNOUNCE_SETS_KEY = 'ems.announce.sets';
const ANNOUNCE_DEFAULT_ROLES = ['784494588051193906', '784777068521062410', '745319702183804951'];
const ANNOUNCE_ROLE_NAMES = {
  '745515563333189632': 'Зав. ИП',
  '745515556873961552': 'Зам. Зав. ИП',
  '1199645295760388118': 'Ассистент ИП',
  '784494588051193906': 'Отдел ИП',
  '784777068521062410': 'Стажёр ИП',
  '745319702183804951': 'Министерство Здравоохранения'
};
const ANNOUNCE_POLL_MAX = 10;
const ANNOUNCE_DEFAULT_HEADER = '**📅 Наборы — {date}**';
const ANNOUNCE_DEFAULT_FOOTER = 'Ждём всех за 10 минут до начала.';
const ANNOUNCE_POLL_FOOTER = 'Жмяк на опрос, на каких наборах будете';

let announceDate = '';
let announceTimes = [];
let announceRoles = [];
let announceRolesLoaded = false;
let announceHeader = ANNOUNCE_DEFAULT_HEADER;
let announceFooter = ANNOUNCE_DEFAULT_FOOTER;
let announcePoll = false;
let announceCalMonth = null;
let announceDateOpen = false;
let announceOutsideBound = false;
let announcePresets = announceLoadPresets();

function announcePad2(n) { return String(n).padStart(2, '0'); }

function announceIsoFromDate(d) {
  return d.getFullYear() + '-' + announcePad2(d.getMonth() + 1) + '-' + announcePad2(d.getDate());
}

function announceIsoTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return announceIsoFromDate(d);
}

function announceDateLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? m[3] + '.' + m[2] + '.' + m[1] : '';
}

function announceDateFromIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
}

function announceWeekday(iso) {
  if (!iso) return '';
  return announceDateFromIso(iso).toLocaleDateString('ru-RU', { weekday: 'short' });
}

/* Последний анонс: основное сообщение и (в режиме опроса) сообщение с опросом. */
function announceLast() {
  try {
    const raw = localStorage.getItem(ANNOUNCE_LAST_KEY) || '';
    if (!raw) return { id: '', pollId: '' };
    if (/^\d{15,25}$/.test(raw)) return { id: raw, pollId: '' };
    const data = JSON.parse(raw);
    return {
      id: /^\d{15,25}$/.test(String(data.id || '')) ? String(data.id) : '',
      pollId: /^\d{15,25}$/.test(String(data.pollId || '')) ? String(data.pollId) : ''
    };
  } catch (e) {
    return { id: '', pollId: '' };
  }
}

function announceLastId() {
  return announceLast().id;
}

function setAnnounceLast(id, pollId) {
  try {
    if (!id) localStorage.removeItem(ANNOUNCE_LAST_KEY);
    else localStorage.setItem(ANNOUNCE_LAST_KEY, JSON.stringify({ id, pollId: pollId || '' }));
  } catch (e) {}
}

/* Запоминаем, какие наборы были анонсированы на конкретную дату:
   блок 10 берёт отсюда список времени для сегодняшнего дня. */
function announceRememberSets(iso, times) {
  if (!iso || !Array.isArray(times) || !times.length) return;
  try {
    const raw = JSON.parse(localStorage.getItem(ANNOUNCE_SETS_KEY) || '{}');
    const map = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    map[iso] = times.slice(0, 50);
    const keys = Object.keys(map).sort();
    while (keys.length > 60) delete map[keys.shift()];
    localStorage.setItem(ANNOUNCE_SETS_KEY, JSON.stringify(map));
  } catch (e) {}
}

function announceSetsForDate(iso) {
  try {
    const raw = JSON.parse(localStorage.getItem(ANNOUNCE_SETS_KEY) || '{}');
    const list = raw && typeof raw === 'object' ? raw[iso] : null;
    if (!Array.isArray(list)) return [];
    const out = [];
    list.forEach(value => {
      const parsed = announceParseTime(value);
      if (parsed && out.indexOf(parsed) < 0) out.push(parsed);
    });
    return out;
  } catch (e) {
    return [];
  }
}

function announceRoleName(id) {
  const key = String(id || '');
  return ANNOUNCE_ROLE_NAMES[key] || key;
}

/* Разбор ручного ввода: «13:00 – 13:40», «13:00-13:40», «1300-1340», «13:00», «1300». */
function announceNormalizeClock(h, m) {
  const hh = Number(h);
  const mm = Number(m || 0);
  if (!(hh >= 0 && hh <= 23) || !(mm >= 0 && mm <= 59)) return '';
  return announcePad2(hh) + ':' + announcePad2(mm);
}

function announceParseTime(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/[.,]/g, ':').replace(/[—−–]/g, '-').replace(/\s+/g, ' ');

  const range = /^(\d{1,2})(?::?(\d{2}))?\s*(?:-|до)\s*(\d{1,2})(?::?(\d{2}))?$/.exec(s);
  if (range) {
    const from = announceNormalizeClock(range[1], range[2]);
    const to = announceNormalizeClock(range[3], range[4]);
    return from && to ? from + ' – ' + to : '';
  }

  const single = /^(\d{1,2})(?::?(\d{2}))?$/.exec(s);
  if (single) return announceNormalizeClock(single[1], single[2]);

  return '';
}

function announceAddTime(raw, silent) {
  const parsed = announceParseTime(raw);
  if (!parsed) return { ok: false };
  if (announceTimes.indexOf(parsed) >= 0) return { ok: true, duplicate: true };
  announceTimes.push(parsed);
  announceSync();
  if (!silent) toast('Набор добавлен', parsed);
  return { ok: true };
}

/* ---------- Предпросмотр в стиле Discord ---------- */

function announcePlural(n, forms) {
  const num = Math.abs(Number(n) || 0);
  const tail = num % 100;
  if (tail >= 11 && tail <= 14) return forms[2];
  const last = tail % 10;
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}

/* ---------- Быстрый ввод времени ---------- */

function announceMaskTime(value) {
  const s = String(value || '').replace(/[^\d:]/g, '');
  if (/^\d{4}$/.test(s)) return s.slice(0, 2) + ':' + s.slice(2);
  return s;
}

function announceTimePair() {
  return { from: $('announceTimeFrom'), to: $('announceTimeTo') };
}

let announceAutoAddTimer = null;

function announceLoadPresets() {
  try {
    const raw = JSON.parse(localStorage.getItem(ANNOUNCE_PRESETS_KEY) || 'null');
    if (Array.isArray(raw) && raw.length) {
      const out = raw.map(v => announceParseTime(v)).filter(Boolean).slice(0, 6);
      if (out.length) return out;
    }
  } catch (e) {}
  return ANNOUNCE_PRESETS_DEFAULT.slice();
}

function announceSavePresets() {
  try { localStorage.setItem(ANNOUNCE_PRESETS_KEY, JSON.stringify(announcePresets)); } catch (e) {}
}

function announceSyncPresetActive() {
  document.querySelectorAll('.ann-preset-wrap').forEach(wrap => {
    const btn = wrap.querySelector('.announce-preset');
    wrap.classList.toggle('active', !!btn && announceTimes.indexOf(btn.dataset.range) >= 0);
  });
}

function announceRenderPresets() {
  const box = $('announcePresets');
  if (!box) return;
  box.innerHTML = announcePresets.map((p, i) => `
    <span class="ann-preset-wrap" data-preset-wrap="${i}">
      <button type="button" class="announce-preset" data-range="${escapeHtml(p)}">${escapeHtml(p)}</button>
      <button type="button" class="ann-preset-edit" data-preset-edit="${i}" aria-label="Изменить время" title="Изменить время">${svgIcon('pencil')}</button>
    </span>`).join('');
  box.querySelectorAll('.announce-preset').forEach(btn => {
    btn.onclick = () => {
      const range = btn.dataset.range;
      const at = announceTimes.indexOf(range);
      if (at >= 0) announceTimes.splice(at, 1);
      else announceTimes.push(range);
      announceSync();
    };
  });
  box.querySelectorAll('[data-preset-edit]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      announceEditPreset(Number(btn.dataset.presetEdit));
    };
  });
  announceSyncPresetActive();
}

function announceEditPreset(index) {
  const wrap = document.querySelector('[data-preset-wrap="' + index + '"]');
  if (!wrap) return;
  const parts = String(announcePresets[index] || '').split(' – ');
  wrap.classList.remove('active');
  wrap.classList.add('editing');
  wrap.innerHTML = `
    <span class="ann-preset-editor">
      <input type="text" class="ann-input ann-preset-from" value="${escapeHtml(parts[0] || '')}" maxlength="5" inputmode="numeric" autocomplete="off" spellcheck="false">
      <span class="ann-preset-dash">–</span>
      <input type="text" class="ann-input ann-preset-to" value="${escapeHtml(parts[1] || '')}" maxlength="5" inputmode="numeric" autocomplete="off" spellcheck="false">
      <button type="button" class="ann-preset-ok" data-preset-save="${index}" title="Сохранить">✓</button>
      <button type="button" class="ann-preset-cancel" data-preset-cancel="${index}" title="Отмена">×</button>
    </span>`;
  const from = wrap.querySelector('.ann-preset-from');
  const to = wrap.querySelector('.ann-preset-to');
  const save = () => {
    const a = announceParseTime(from.value);
    const b = announceParseTime(to.value);
    from.classList.toggle('err-field', !a);
    to.classList.toggle('err-field', !b);
    if (!a || !b) return;
    announcePresets[index] = a + ' – ' + b;
    announceSavePresets();
    announceRenderPresets();
  };
  [from, to].forEach(inp => {
    inp.oninput = () => { inp.value = announceMaskTime(inp.value); };
    inp.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); announceRenderPresets(); }
    };
  });
  wrap.querySelector('[data-preset-save]').onclick = save;
  wrap.querySelector('[data-preset-cancel]').onclick = () => announceRenderPresets();
  from.focus();
  from.select();
}

function announceScheduleAutoAdd() {
  clearTimeout(announceAutoAddTimer);
  const { from, to } = announceTimePair();
  if (!from || !to) return;
  if (!announceParseTime(from.value) || !announceParseTime(to.value)) return;
  announceAutoAddTimer = setTimeout(() => announceCommitTime(), 450);
}

function announceCommitTime() {
  const { from, to } = announceTimePair();
  if (!from || !to) return false;
  const rawFrom = String(from.value || '').trim();
  const rawTo = String(to.value || '').trim();
  /* Набор добавляется только когда заполнены и начало, и конец. */
  if (!rawFrom || !rawTo) {
    announceUpdateTimeHint();
    return false;
  }
  const pFrom = announceParseTime(rawFrom);
  const pTo = announceParseTime(rawTo);
  if (!pFrom || !pTo) {
    announceUpdateTimeHint();
    return false;
  }
  const out = announceAddTime(pFrom + ' – ' + pTo, true);
  if (!out.ok) return false;
  from.value = '';
  to.value = '';
  from.focus();
  announceUpdateTimeHint();
  if (out.duplicate) {
    const hint = $('announceTimeHint');
    if (hint) {
      hint.textContent = 'Этот набор уже в списке.';
      hint.classList.remove('err');
      hint.classList.add('ok');
    }
  }
  return true;
}

function announceOnTimeInput(which) {
  const { from, to } = announceTimePair();
  const input = which === 'from' ? from : to;
  if (!input) return;
  const raw = String(input.value || '');
  if (which === 'from' && /[-–—]|до/i.test(raw)) {
    const parsed = announceParseTime(raw);
    if (parsed && parsed.indexOf(' – ') >= 0) {
      const parts = parsed.split(' – ');
      from.value = parts[0];
      to.value = parts[1];
      announceUpdateTimeHint();
      announceScheduleAutoAdd();
      return;
    }
    announceUpdateTimeHint();
    return;
  }
  input.value = announceMaskTime(raw);
  announceUpdateTimeHint();
  announceScheduleAutoAdd();
}

/* Подсказка под полями времени. */
function announceUpdateTimeHint() {
  const hint = $('announceTimeHint');
  if (!hint) return;
  const { from, to } = announceTimePair();
  const rawFrom = from ? String(from.value || '').trim() : '';
  const rawTo = to ? String(to.value || '').trim() : '';
  hint.classList.remove('ok', 'err');
  if (!rawFrom && !rawTo) {
    hint.textContent = 'Введите начало и конец: 1400, пробел, затем 1440 — добавится 14:00 – 14:40.';
    return;
  }
  if (/[-–—]\s*$/.test(rawFrom)) {
    hint.textContent = 'Теперь введите конец, например 1440.';
    return;
  }
  if (rawFrom && !rawTo) {
    const pFromOnly = announceParseTime(rawFrom);
    hint.textContent = pFromOnly
      ? 'Это только начало. Введите конец, например 1440, чтобы набор добавился.'
      : 'Начало: введите время, например 1400.';
    hint.classList.add('err');
    return;
  }
  if (!rawFrom && rawTo) {
    hint.textContent = 'Сначала введите начало, например 1400.';
    hint.classList.add('err');
    return;
  }
  const pFrom = announceParseTime(rawFrom);
  const pTo = announceParseTime(rawTo);
  if (!pFrom) {
    hint.textContent = 'Начало: введите время, например 1400.';
    hint.classList.add('err');
    return;
  }
  if (!pTo) {
    hint.textContent = 'Конец: введите время, например 1440.';
    hint.classList.add('err');
    return;
  }
  hint.textContent = 'Получится: ' + pFrom + ' – ' + pTo;
  hint.classList.add('ok');
}

/* Мини-разметка для предпросмотра: **жирный**, __подчёркнутый__, `код`. */
function announceMdInline(text) {
  return escapeHtml(String(text == null ? '' : text))
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<u>$1</u>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function announcePreviewHtml() {
  const date = announceDateLabel(announceDate) || 'дд.мм.гггг';
  const times = announceTimes.length ? announceTimes : ['13:00 – 13:40'];
  const roles = announceRoles.length ? announceRoles : ANNOUNCE_DEFAULT_ROLES;

  const rolePills = roles
    .map(id => `<span class="ann-pv-role">@${escapeHtml(announceRoleName(id))}</span>`)
    .join('');

  const items = times.map((t, i) =>
    `<div class="ann-pv-item"><span class="ann-pv-num">${i + 1}</span><span class="ann-pv-slot">${escapeHtml(t)}</span></div>`
  ).join('');

  const title = announceMdInline((announceHeader || ANNOUNCE_DEFAULT_HEADER).replace(/\{date\}/g, date));
  const foot = announceMdInline(announceFooter || ANNOUNCE_DEFAULT_FOOTER);
  const footer = `<span>${foot}</span>`;
  const cta = `<div class="ann-pv-cta"><b>${escapeHtml(ANNOUNCE_POLL_FOOTER)}</b></div>`;

  let poll = '';
  if (announcePoll) {
    const answers = times.map(t => `
      <div class="ann-pv-answer">
        <span class="ann-pv-check"></span>
        <span class="ann-pv-answer-text">${escapeHtml(t)}</span>
        <span class="ann-pv-answer-count">0</span>
      </div>`).join('');
    poll = `
      <div class="ann-pv-poll">
        <div class="ann-pv-poll-head">
          <span class="ann-pv-poll-title">Опрос</span>
          <span class="ann-pv-poll-anon">анонимный</span>
        </div>
        <div class="ann-pv-poll-q">На каких наборах будете?</div>
        <div class="ann-pv-answers">${answers}</div>
        <div class="ann-pv-poll-meta">Можно выбрать несколько · 24 часа</div>
      </div>`;
  }

  /* Основное сообщение — всегда карточка-embed, как в обычном режиме.
     Опрос Discord уходит отдельным сообщением ниже, поэтому в предпросмотре
     призыв и опрос стоят под карточкой. */
  const message = `<div class="ann-pv-embed">
         <div class="ann-pv-embed-in">
           <div class="ann-pv-title">${title}</div>
           <div class="ann-pv-list">${items}</div>
           <div class="ann-pv-foot">${footer}</div>
         </div>
       </div>`;

  return `
    <div class="ann-pv-head">
      <span class="ann-pv-avatar"><img src="avatar.jpg" alt=""></span>
      <span class="ann-pv-name">Наборы</span>
      <span class="ann-pv-app">APP</span>
      <span class="ann-pv-time">сегодня</span>
    </div>
    <div class="ann-pv-body">
      <div class="ann-pv-roles">${rolePills}</div>
      ${message}
      ${announcePoll ? cta : ''}
      ${poll}
    </div>`;
}


/* ---------- Календарь ---------- */

function renderAnnounceCalendar() {
  const box = $('announceDatePop');
  if (!box) return;
  if (!announceCalMonth) announceCalMonth = announceDateFromIso(announceDate || announceIsoTomorrow());
  const year = announceCalMonth.getFullYear();
  const month = announceCalMonth.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const monthLabel = first.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  const selected = announceDate;

  let html = `<div class="cal-head">
      <button type="button" class="cal-nav" data-ann-nav="-1">←</button>
      <span class="cal-title">${monthLabel}</span>
      <button type="button" class="cal-nav" data-ann-nav="1">→</button>
    </div>
    <div class="cal-grid">`;

  ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].forEach(d => html += `<div class="cal-wd">${d}</div>`);

  const offset = first.getDay() === 0 ? 6 : first.getDay() - 1;
  const prevDays = new Date(year, month, 0).getDate();
  const cell = (d, y, m) => {
    const iso = y + '-' + announcePad2(m + 1) + '-' + announcePad2(d);
    const cls = iso === selected ? 'cal-day single' : 'cal-day';
    return `<div class="${cls}" data-ann-date="${iso}">${d}</div>`;
  };
  for (let i = offset; i > 0; i--) html += cell(prevDays - i + 1, year, month - 1);
  for (let d = 1; d <= last.getDate(); d++) html += cell(d, year, month);
  const rest = 42 - (offset + last.getDate());
  for (let i = 1; i <= rest; i++) html += cell(i, year, month + 1);
  html += '</div>';

  box.innerHTML = html;

  box.querySelectorAll('[data-ann-nav]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      announceCalMonth.setMonth(announceCalMonth.getMonth() + Number(btn.dataset.annNav));
      renderAnnounceCalendar();
    };
  });
  box.querySelectorAll('[data-ann-date]').forEach(el => {
    el.onclick = e => {
      e.stopPropagation();
      announceDate = el.dataset.annDate;
      announceDateOpen = false;
      box.classList.remove('active');
      announceSync();
    };
  });
}

function announceToggleCalendar(open) {
  const box = $('announceDatePop');
  if (!box) return;
  announceDateOpen = typeof open === 'boolean' ? open : !announceDateOpen;
  box.classList.toggle('active', announceDateOpen);
  if (announceDateOpen) {
    announceCalMonth = announceDateFromIso(announceDate || announceIsoTomorrow());
    renderAnnounceCalendar();
  }
}

/* ---------- Отрисовка ---------- */

function announceSync() {
  const list = $('announceTimesList');
  if (list) {
    list.innerHTML = announceTimes.length
      ? announceTimes.map((t, i) =>
        '<span class="ann-chip">' +
          '<span class="ann-chip-num">' + (i + 1) + '</span>' +
          '<span class="ann-chip-time">' + escapeHtml(t) + '</span>' +
          '<button type="button" data-announce-remove="' + i + '" aria-label="Убрать">×</button>' +
        '</span>'
      ).join('')
      : '<span class="ann-empty">Пока пусто — нажмите готовое время или впишите своё.</span>';
    list.querySelectorAll('[data-announce-remove]').forEach(btn => {
      btn.onclick = () => {
        announceTimes.splice(Number(btn.dataset.announceRemove), 1);
        announceSync();
      };
    });
  }

  const preview = $('announcePreview');
  if (preview) {
    preview.innerHTML = announcePreviewHtml();
    hydrateIcons(preview);
  }
  const settingsPreview = $('announceSettingsPreview');
  if (settingsPreview) {
    settingsPreview.innerHTML = announcePreviewHtml();
    hydrateIcons(settingsPreview);
  }

  announceSyncPresetActive();

  const dateBtn = $('announceDateBtn');
  if (dateBtn) {
    const label = announceDateLabel(announceDate);
    const wd = announceWeekday(announceDate);
    dateBtn.innerHTML = '<span class="ann-date-ico" data-icon="clip"></span>' +
      '<span class="ann-date-value">' + (label || 'Выберите дату') + '</span>' +
      (wd ? '<span class="ann-date-wd">' + escapeHtml(wd) + '</span>' : '');
    hydrateIcons(dateBtn);
  }

  const count = $('announceCount');
  if (count) {
    count.textContent = announceTimes.length
      ? announceTimes.length + ' ' + announcePlural(announceTimes.length, ['набор', 'набора', 'наборов'])
      : 'наборов нет';
  }

  const sendBtn = $('announceSendBtn');
  if (sendBtn) sendBtn.disabled = !announceTimes.length;
  const delBtn = $('announceDeleteBtn');
  if (delBtn) delBtn.disabled = !announceLastId();

  const pollInput = $('announcePoll');
  if (pollInput && pollInput.checked !== announcePoll) pollInput.checked = announcePoll;

  const pollNote = $('announcePollNote');
  if (pollNote) {
    if (announceTimes.length > ANNOUNCE_POLL_MAX) {
      pollNote.textContent = 'В опрос Discord влезает максимум ' + ANNOUNCE_POLL_MAX +
        ' наборов — сейчас ' + announceTimes.length + '. Уберите лишние, чтобы отправить опросом.';
    } else if (announcePoll) {
      pollNote.textContent = 'Сообщение уйдёт с опросом: можно отметить несколько наборов, голосование идёт 24 часа.';
    } else {
      pollNote.textContent = 'Без опроса сообщение уйдёт обычным списком — собрать голоса не получится: реакции к сообщению добавить нельзя.';
    }
  }
  const pollLabel = $('announcePollLabel');
  if (pollLabel) pollLabel.classList.toggle('disabled', announceTimes.length > ANNOUNCE_POLL_MAX);

  announceUpdateTimeHint();
}

function announceApi(body) {
  return apiFetch('/api/announce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(body)
  }).then(res => res.json().catch(() => ({ ok: false, code: 'bad_response', status: res.status })))
    .catch(e => ({ ok: false, code: 'network', detail: String((e && e.message) || e) }));
}

/* ---------- Настройки анонса: роли, заголовок, подпись ---------- */

function announceFillSettingsInputs() {
  const h = $('announceHeaderInput');
  if (h && document.activeElement !== h) h.value = announceHeader;
  const f = $('announceFooterInput');
  if (f && document.activeElement !== f) f.value = announceFooter;
}

function announceRenderRoleChips() {
  const box = $('announceRoleChips');
  if (!box) return;
  box.innerHTML = announceRoles.length
    ? announceRoles.map((id, i) =>
      '<span class="ann-chip ann-role-chip">' +
        '<span class="ann-chip-time">@' + escapeHtml(announceRoleName(id)) + '</span>' +
        '<button type="button" data-announce-role-remove="' + i + '" aria-label="Убрать">×</button>' +
      '</span>'
    ).join('')
    : '<span class="ann-empty">Ролей нет — добавьте ID роли или её название.</span>';
  box.querySelectorAll('[data-announce-role-remove]').forEach(btn => {
    btn.onclick = () => {
      announceRoles.splice(Number(btn.dataset.announceRoleRemove), 1);
      announceRenderRoleChips();
      announceSync();
    };
  });
}

/* Роль можно добавить ID (числом) или названием: «Отдел ИП», «@Стажёр ИП». */
function announceRoleIdFromInput(raw) {
  const s = String(raw || '').trim();
  const digits = /(\d{15,25})/.exec(s);
  if (digits) return digits[1];
  const name = s.replace(/^@/, '').trim().toLowerCase();
  if (!name) return '';
  return Object.keys(ANNOUNCE_ROLE_NAMES)
    .find(id => ANNOUNCE_ROLE_NAMES[id].toLowerCase() === name) || '';
}

function announceAddRole() {
  const input = $('announceRoleInput');
  const status = $('announceSettingsStatus');
  const id = announceRoleIdFromInput(input && input.value);
  if (!id) {
    if (status) status.textContent = 'Не понял роль: вставьте ID (число) или название, например «Отдел ИП».';
    return;
  }
  if (announceRoles.indexOf(id) >= 0) {
    if (status) status.textContent = 'Такая роль уже в списке.';
    return;
  }
  if (announceRoles.length >= 5) {
    if (status) status.textContent = 'Больше 5 ролей Discord не упомянет.';
    return;
  }
  announceRoles.push(id);
  if (input) input.value = '';
  if (status) status.textContent = '';
  announceRenderRoleChips();
  announceSync();
}

async function announceSaveSettings() {
  const status = $('announceSettingsStatus');
  const headerInput = $('announceHeaderInput');
  const footerInput = $('announceFooterInput');
  const header = (headerInput ? headerInput.value : '').trim();
  const footer = (footerInput ? footerInput.value : '').trim();
  if (!header) { if (status) status.textContent = 'Заголовок не может быть пустым.'; return; }
  if (!announceRoles.length) { if (status) status.textContent = 'Добавьте хотя бы одну роль для пинга.'; return; }
  if (status) status.textContent = 'Сохранение…';
  const out = await syncSettingsPost('/api/announce', { action: 'settings', roles: announceRoles.slice(), header, footer });
  if (out.ok) {
    announceHeader = header;
    announceFooter = footer;
    announceFillSettingsInputs();
    announceSync();
    if (status) {
      status.textContent = out.partial
        ? 'Сохранено не на всех зеркалах: ' + (out.failed || []).join(', ')
        : 'Сохранено — новые анонсы уйдут с этим текстом.';
    }
    if (out.partial) {
      toast('Настройки анонса', 'Не удалось обновить: ' + (out.failed || []).join(', '), 'error');
    } else {
      toast('Настройки анонса', 'Роли и текст сохранены.');
    }
  } else {
    const messages = {
      bad_roles: 'Нужна хотя бы одна роль.',
      bad_header: 'Заголовок пустой или слишком длинный (до 200 символов).',
      bad_footer: 'Подпись слишком длинная (до 300 символов).',
      unauthorized: 'Нужен секрет сервера — подтвердите доступ.',
      storage: 'Не удалось сохранить на сервере.',
      network: 'Нет связи с сервером.'
    };
    if (status) status.textContent = messages[out.code] || ('Не удалось: ' + (out.code || 'ошибка'));
  }
}

/* Настройки анонса грузим один раз: их читают и блок 09, и админка. */
let announceRolesLoading = false;

function announceEnsureSettings() {
  if (announceRolesLoaded || announceRolesLoading || !getAuthToken()) return;
  announceRolesLoading = true;
  announceApi({ action: 'status' }).then(out => {
    announceRolesLoading = false;
    if (!out || !out.ok) return;
    announceRolesLoaded = true;
    if (Array.isArray(out.roles) && out.roles.length) {
      const next = out.roles.map(String);
      if (next.join(',') !== announceRoles.join(',')) announceRoles = next;
    }
    if (typeof out.header === 'string' && out.header.trim()) announceHeader = out.header.trim();
    if (typeof out.footer === 'string') announceFooter = out.footer.trim();
    announceFillSettingsInputs();
    announceRenderRoleChips();
    announceSync();
    const pv = $('announceSettingsPreview');
    if (pv) { pv.innerHTML = announcePreviewHtml(); hydrateIcons(pv); }
  });
}

function renderAdminAnnounce() {
  const root = $('announceRoot');
  if (!root) return;
  clearTimeout(announceAutoAddTimer);
  if (!announceDate) announceDate = announceIsoTomorrow();
  const authed = !!getAuthToken();
  announceEnsureSettings();

  const authBlock = authed ? '' : `
    <div class="ann-login">
      <h4>Доступ</h4>
      <div class="a-hint">Раздел только для старшего состава. Введите секрет сервера — доступ действует 24 часа.</div>
      <div class="ann-time-row">
        <input type="password" id="announceSecret" class="ann-input" placeholder="секрет сервера" autocomplete="off">
        <button type="button" class="a-btn sec" id="announceLoginBtn">Подтвердить</button>
      </div>
      <div id="announceLoginStatus" class="a-hint" style="margin:10px 0 0"></div>
    </div>`;

  const form = authed ? `
    <div class="ann-layout">
      <div class="ann-main">

        <section class="ann-block">
          <div class="ann-block-head">
            <h4>Дата и время</h4>
            <span class="ann-count" id="announceCount"></span>
          </div>

          <div class="ann-date-row">
            <button type="button" class="ann-input ann-date-btn" id="announceDateBtn"></button>
            <button type="button" class="ann-quick" id="announceTodayBtn">Сегодня</button>
            <button type="button" class="ann-quick" id="announceTomorrowBtn">Завтра</button>
            <div class="date-picker ann-date-pop" id="announceDatePop"></div>
          </div>

          <div class="ann-sub">Быстрый выбор <span class="ann-sub-note">— карандаш меняет время</span></div>
          <div class="announce-presets" id="announcePresets"></div>

          <div class="ann-time-row ann-time-pair">
            <label class="ann-time-field">
              <span class="ann-time-label">Начало</span>
              <input type="text" id="announceTimeFrom" class="ann-input" inputmode="numeric" maxlength="5"
                     autocomplete="off" spellcheck="false" placeholder="1400">
            </label>
            <span class="ann-time-dash">–</span>
            <label class="ann-time-field">
              <span class="ann-time-label">Конец</span>
              <input type="text" id="announceTimeTo" class="ann-input" inputmode="numeric" maxlength="5"
                     autocomplete="off" spellcheck="false" placeholder="1440">
            </label>
            <button type="button" class="a-btn sec ann-time-add" id="announceAddTime">Добавить</button>
          </div>
          <div class="ann-time-hint" id="announceTimeHint"></div>

          <div class="announce-chips" id="announceTimesList"></div>
        </section>

        <section class="ann-block">
          <div class="ann-block-head"><h4>Отправка</h4></div>
          <div class="ann-send-row">
            <button type="button" class="a-btn ann-send" id="announceSendBtn">Отправить в Discord</button>
            <button type="button" class="a-btn danger" id="announceDeleteBtn">Удалить последнее</button>
          </div>
          <div id="announceStatus" class="a-hint" style="margin:12px 0 0"></div>
        </section>

        <section class="ann-block">
          <div class="ann-block-head"><h4>Голосование</h4></div>
          <label class="ann-switch" id="announcePollLabel">
            <input type="checkbox" id="announcePoll">
            <span class="ann-switch-track"><span class="ann-switch-dot"></span></span>
            <span class="ann-switch-text">Собрать голоса опросом Discord</span>
          </label>
          <div class="a-hint" id="announcePollNote" style="margin:10px 0 0"></div>
        </section>

      </div>

      <aside class="ann-side">
        <div class="ann-block ann-preview-block">
          <div class="ann-block-head">
            <h4>Предпросмотр</h4>
            <span class="ann-pv-badge">Discord</span>
          </div>
          <div class="ann-preview" id="announcePreview"></div>
        </div>
      </aside>
    </div>` : '';

  root.innerHTML = authBlock + form;

  const loginBtn = $('announceLoginBtn');
  if (loginBtn) {
    loginBtn.onclick = async () => {
      const input = $('announceSecret');
      const status = $('announceLoginStatus');
      const password = (input && input.value ? input.value : '').trim();
      if (!password) { if (status) status.textContent = 'Введите секрет сервера.'; return; }
      if (status) status.textContent = 'Проверка…';
      const outcome = await acquireAuthToken(password);
      if (outcome.ok) {
        announceRolesLoaded = false;
        renderAdminAnnounce();
        toast('Доступ подтверждён', 'Можно отправлять анонсы.');
      } else {
        const messages = {
          unauthorized: 'Неверный секрет сервера.',
          no_server_secret: 'На сервере не задан ADMIN_SECRET.',
          rate_limited: 'Слишком много попыток. Подождите минуту.',
          network: 'Нет связи с сервером.'
        };
        if (status) status.textContent = messages[outcome.code] || ('Ошибка: ' + outcome.code);
      }
    };
  }

  if (!authed) return;

  const dateBtn = $('announceDateBtn');
  if (dateBtn) {
    dateBtn.onclick = e => {
      e.stopPropagation();
      announceToggleCalendar();
    };
  }
  const datePop = $('announceDatePop');
  if (datePop) datePop.addEventListener('click', e => e.stopPropagation());
  if (!announceOutsideBound) {
    announceOutsideBound = true;
    document.addEventListener('click', () => {
      if (announceDateOpen) announceToggleCalendar(false);
    });
  }

  if ($('announceTodayBtn')) {
    $('announceTodayBtn').onclick = () => {
      announceDate = announceIsoFromDate(new Date());
      announceSync();
    };
  }
  if ($('announceTomorrowBtn')) {
    $('announceTomorrowBtn').onclick = () => {
      announceDate = announceIsoTomorrow();
      announceSync();
    };
  }

  const from = $('announceTimeFrom');
  const to = $('announceTimeTo');
  const addTime = () => {
    clearTimeout(announceAutoAddTimer);
    announceCommitTime();
  };
  if ($('announceAddTime')) $('announceAddTime').onclick = addTime;
  [[from, 'from'], [to, 'to']].forEach(pair => {
    const input = pair[0];
    const which = pair[1];
    if (!input) return;
    input.oninput = () => announceOnTimeInput(which);
    input.onblur = () => {
      const parsed = announceParseTime(input.value);
      if (parsed && parsed.indexOf(' – ') < 0) input.value = parsed;
      announceUpdateTimeHint();
      if (which === 'to') {
        clearTimeout(announceAutoAddTimer);
        announceCommitTime();
      }
    };
    input.onkeydown = e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(announceAutoAddTimer);
        announceCommitTime();
      }
      /* Пробел после начала переносит ввод в поле «Конец». */
      if ((e.key === ' ' || e.code === 'Space') && which === 'from') {
        const parsed = announceParseTime(input.value);
        if (parsed && parsed.indexOf(' – ') < 0) {
          e.preventDefault();
          input.value = parsed;
          announceUpdateTimeHint();
          if (to) {
            to.focus();
            to.select();
          }
          return;
        }
      }
      if (e.key === 'Escape') {
        input.value = '';
        announceUpdateTimeHint();
      }
    };
  });

  if ($('announcePoll')) {
    $('announcePoll').onchange = () => {
      announcePoll = !!$('announcePoll').checked;
      announceSync();
    };
  }

  if ($('announceSendBtn')) $('announceSendBtn').onclick = announceSendNow;
  if ($('announceDeleteBtn')) $('announceDeleteBtn').onclick = announceDeleteLast;

  announceRenderPresets();

  announceSync();
}


/* Настройки анонса живут только в админке (шестерёнка → «Наборы»),
   чтобы не засорять рабочий блок 09. */
function renderAnnounceSettings() {
  const root = $('announceSettingsRoot');
  if (!root) return;
  const authed = !!getAuthToken();

  const authBlock = authed ? '' : `
    <div class="ann-login">
      <h4>Доступ</h4>
      <div class="a-hint">Настройки меняются по секрету сервера — он же нужен, чтобы отправлять анонсы.</div>
      <div class="ann-time-row">
        <input type="password" id="announceSettingsSecret" class="ann-input" placeholder="секрет сервера" autocomplete="off">
        <button type="button" class="a-btn sec" id="announceSettingsLoginBtn">Подтвердить</button>
      </div>
      <div id="announceSettingsLoginStatus" class="a-hint" style="margin:10px 0 0"></div>
    </div>`;

  const form = authed ? `
    <div class="ann-layout">
      <div class="ann-main">
        <section class="ann-block">
          <div class="ann-block-head">
            <h4>Пинги и текст</h4>
            <span class="ann-count">для всех анонсов</span>
          </div>

          <label class="ann-field">
            <span class="ann-field-label">Заголовок <span class="ann-sub-note">{date} подставит дату</span></span>
            <input type="text" id="announceHeaderInput" class="ann-input" maxlength="200"
                   autocomplete="off" spellcheck="false" placeholder="**📅 Наборы — {date}**">
          </label>

          <label class="ann-field">
            <span class="ann-field-label">Подпись <span class="ann-sub-note">мелким текстом под списком</span></span>
            <input type="text" id="announceFooterInput" class="ann-input" maxlength="300"
                   autocomplete="off" spellcheck="false" placeholder="Ждём всех за 10 минут до начала.">
          </label>

          <div class="ann-sub">Роли для пинга</div>
          <div class="announce-chips" id="announceRoleChips"></div>
          <div class="ann-time-row">
            <input type="text" id="announceRoleInput" class="ann-input"
                   placeholder="745515563333189632 или «Зав. ИП»"
                   autocomplete="off" spellcheck="false">
            <button type="button" class="a-btn sec" id="announceRoleAdd">Добавить</button>
          </div>

          <div class="ann-time-row">
            <button type="button" class="a-btn" id="announceSettingsSave">Сохранить</button>
            <span class="a-hint" id="announceSettingsStatus"></span>
          </div>

          <div class="a-hint" style="margin-top:12px">
            Эти настройки применяются ко всем анонсам. Сам блок «Наборы» остаётся чистым: там только дата,
            время, опрос и отправка.
          </div>
        </section>
      </div>

      <aside class="ann-side">
        <div class="ann-block ann-preview-block">
          <div class="ann-block-head">
            <h4>Как придёт в Discord</h4>
            <span class="ann-pv-badge">Discord</span>
          </div>
          <div class="ann-preview" id="announceSettingsPreview"></div>
        </div>
      </aside>
    </div>` : '';

  root.innerHTML = authBlock + form;

  const loginBtn = $('announceSettingsLoginBtn');
  if (loginBtn) {
    loginBtn.onclick = async () => {
      const input = $('announceSettingsSecret');
      const status = $('announceSettingsLoginStatus');
      const password = (input && input.value ? input.value : '').trim();
      if (!password) { if (status) status.textContent = 'Введите секрет сервера.'; return; }
      if (status) status.textContent = 'Проверка…';
      const outcome = await acquireAuthToken(password);
      if (outcome.ok) {
        announceRolesLoaded = false;
        renderAnnounceSettings();
        toast('Доступ подтверждён', 'Настройки анонса открыты.');
      } else {
        const messages = {
          unauthorized: 'Неверный секрет сервера.',
          no_server_secret: 'На сервере не задан ADMIN_SECRET.',
          rate_limited: 'Слишком много попыток. Подождите минуту.',
          network: 'Нет связи с сервером.'
        };
        if (status) status.textContent = messages[outcome.code] || ('Ошибка: ' + outcome.code);
      }
    };
  }

  if (!authed) return;

  announceEnsureSettings();
  announceRenderRoleChips();
  announceFillSettingsInputs();

  const headerInput = $('announceHeaderInput');
  if (headerInput) {
    headerInput.oninput = () => {
      announceHeader = headerInput.value;
      announceSync();
    };
  }
  const footerInput = $('announceFooterInput');
  if (footerInput) {
    footerInput.oninput = () => {
      announceFooter = footerInput.value;
      announceSync();
    };
  }
  if ($('announceRoleAdd')) $('announceRoleAdd').onclick = announceAddRole;
  if ($('announceRoleInput')) {
    $('announceRoleInput').onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); announceAddRole(); }
    };
  }
  if ($('announceSettingsSave')) $('announceSettingsSave').onclick = announceSaveSettings;

  const pv = $('announceSettingsPreview');
  if (pv) { pv.innerHTML = announcePreviewHtml(); hydrateIcons(pv); }
}


async function announceSendNow() {
  const status = $('announceStatus');
  const date = announceDateLabel(announceDate);
  if (!date) { if (status) status.textContent = 'Выберите дату.'; return; }
  if (!announceTimes.length) { if (status) status.textContent = 'Добавьте хотя бы один набор.'; return; }
  if (announcePoll && announceTimes.length > ANNOUNCE_POLL_MAX) {
    if (status) status.textContent = 'Для опроса Discord нужно не больше ' + ANNOUNCE_POLL_MAX + ' наборов.';
    return;
  }
  if (status) status.textContent = 'Отправка…';
  const btn = $('announceSendBtn');
  if (btn) btn.disabled = true;
  const out = await announceApi({ date, times: announceTimes.slice(), poll: announcePoll });
  if (btn) btn.disabled = false;
  if (out.ok) {
    setAnnounceLast(out.messageId || '', out.pollMessageId || '');
    announceRememberSets(announceDate, announceTimes.slice());
    if (status) {
      status.innerHTML = 'Отправлено.' + (out.url
        ? ' <a href="' + escapeHtml(out.url) + '" target="_blank" rel="noopener">Открыть сообщение</a>'
        : '');
    }
    toast('Анонс отправлен', out.pollMessageId ? 'Сообщение и опрос уже в Discord.' : 'Сообщение уже в Discord.');
  } else {
    const messages = {
      unauthorized: 'Нужен секрет сервера — подтвердите доступ.',
      not_configured: 'Вебхук анонсов не настроен (вкладка «Отправка»).',
      rate_limited: 'Слишком часто. Подождите минуту.',
      bad_date: 'Дата в неверном формате.',
      bad_times: 'Время в неверном формате.',
      poll_limit: 'В опрос Discord влезает максимум ' + ANNOUNCE_POLL_MAX + ' наборов.',
      network: 'Нет связи с сервером.'
    };
    if (status) {
      status.textContent = messages[out.code] ||
        (out.code === 'upstream'
          ? 'Discord отклонил отправку (код ' + out.status + ').'
          : 'Не удалось: ' + (out.detail || out.code || 'ошибка'));
    }
  }
  announceSync();
}

async function announceDeleteLast() {
  const status = $('announceStatus');
  const last = announceLast();
  if (!last.id) { if (status) status.textContent = 'Нечего удалять — это браузер не отправлял анонс.'; return; }
  if (status) status.textContent = 'Удаление…';
  const out = await announceApi({ action: 'delete', messageId: last.id, pollMessageId: last.pollId });
  if (out.ok) {
    setAnnounceLast('', '');
    if (status) status.textContent = last.pollId ? 'Сообщение и опрос удалены.' : 'Сообщение удалено.';
    toast('Удалено', last.pollId ? 'Анонс и опрос убраны из Discord.' : 'Анонс убран из Discord.');
  } else {
    if (status) status.textContent = 'Не удалось удалить: ' + (out.code || 'ошибка');
  }
  announceSync();
}


/* ================= Блок 10: результаты наборов =================
   Доступен только СС. Данные составов читаются с сервера (/api/sets),
   время — из сегодняшних наборов блока 09 (или сохранённых пресетов). */

const SETS_TYPE_DEFAULT = 'EMS LS';
const SETS_TYPE_OPTIONS = ['EMS LS', 'EMS SS'];
const SETS_FALLBACK_TEXT = {
  seniors: 'на данный момент СС нет',
  staff: 'сотрудника нет',
  interns: 'сотрудника нет'
};
const SETS_GROUPS = [
  { id: 'seniors', title: 'Старший состав', empty: 'В таблице не найдено ни одного СС.' },
  { id: 'staff', title: 'Отдел ИП', empty: 'В таблице пока нет сотрудников отдела ИП.' },
  { id: 'interns', title: 'Стажёры ИП', empty: 'В таблице пока нет стажёров.' }
];

let setsType = SETS_TYPE_DEFAULT;
let setsTime = '';
let setsCount = '0';
let setsRoster = { staff: [], interns: [], seniors: [] };
let setsSelected = { staff: [], interns: [], seniors: [] };
let setsLoaded = false;
let setsLoading = false;
let setsLoadError = '';

function setsPersonKey(person) {
  /* JSON-ключ, а не \u0000: HTML-парсер заменяет NUL в атрибутах на U+FFFD,
     из-за чего выбранные люди «терялись» после перерисовки. */
  return JSON.stringify([
    String((person && person.name) || ''),
    String((person && person.discord) || '')
  ]);
}

function setsTodayIso() {
  return announceIsoFromDate(new Date());
}

function setsTimeOptions() {
  const today = announceSetsForDate(setsTodayIso());
  const list = (today.length ? today : announceLoadPresets()).filter(Boolean);
  return list.filter((value, index) => list.indexOf(value) === index);
}

function setsSelectedPeople(group) {
  const keys = setsSelected[group] || [];
  return (setsRoster[group] || []).filter(person => keys.indexOf(setsPersonKey(person)) >= 0);
}

function setsMention(person) {
  return person && person.discord ? '<@' + person.discord + '>' : String((person && person.name) || '');
}

function setsGroupContent(group) {
  const people = setsSelectedPeople(group);
  if (!people.length) return SETS_FALLBACK_TEXT[group] || 'сотрудника нет';
  return people.map(setsMention).join(', ');
}

function setsMessageContent() {
  const count = String(setsCount || '').trim() || '0';
  return [
    '1. ' + setsType,
    '2. ' + (setsTime || '—'),
    '3. ' + count,
    '4. ' + setsGroupContent('seniors'),
    '5. ' + setsGroupContent('staff'),
    '6. ' + setsGroupContent('interns')
  ].join('\n');
}

function setsPreviewGroupHtml(group) {
  const people = setsSelectedPeople(group);
  if (!people.length) {
    return '<span class="sets-preview-value empty">' + escapeHtml(SETS_FALLBACK_TEXT[group]) + '</span>';
  }
  const items = people.map(person => {
    const name = escapeHtml(person.name);
    return '<span class="sets-preview-mention">' + (person.discord ? '@' + name : name) + '</span>';
  });
  return '<span class="sets-preview-value">' + items.join(', ') + '</span>';
}

function setsPreviewHtml() {
  const ui = resolveBotMessage('sets', CONFIG);
  const avatar = ui.avatar ? '<img src="' + escapeHtml(ui.avatar) + '" alt="">' : '';
  const cta = ui.content ? '<div class="ann-pv-cta">' + announceMdInline(ui.content) + '</div>' : '';
  const values = [
    '<span class="sets-preview-value">' + escapeHtml(setsType) + '</span>',
    '<span class="sets-preview-value">' + escapeHtml(setsTime || '—') + '</span>',
    '<span class="sets-preview-value">' + escapeHtml(String(setsCount || '').trim() || '0') + '</span>',
    setsPreviewGroupHtml('seniors'),
    setsPreviewGroupHtml('staff'),
    setsPreviewGroupHtml('interns')
  ];
  return `
    <div class="ann-pv-head">
      <span class="ann-pv-avatar">${avatar}</span>
      <span class="ann-pv-name">${escapeHtml(ui.username || 'Результаты наборов')}</span>
      <span class="ann-pv-app">APP</span>
      <span class="ann-pv-time">сегодня</span>
    </div>
    <div class="ann-pv-body">
      ${cta}
      <div class="sets-preview-lines">
        ${values.map((value, index) =>
          '<div class="sets-preview-line"><span class="sets-preview-num">' + (index + 1) + '.</span>' + value + '</div>'
        ).join('')}
      </div>
    </div>`;
}

function setsUpdatePreview() {
  const preview = $('setsPreview');
  if (preview) {
    preview.innerHTML = setsPreviewHtml();
    hydrateIcons(preview);
  }
}

function setsSyncGroupCounts() {
  SETS_GROUPS.forEach(group => {
    const el = $('setsCount_' + group.id);
    if (el) el.textContent = setsSelectedPeople(group.id).length + ' выбрано';
  });
}

function setsStatusMessage(out) {
  const messages = {
    unauthorized: 'Нужен секрет сервера — подтвердите доступ.',
    not_configured: 'Вебхук результатов не настроен (вкладка «Отправка»).',
    rate_limited: 'Слишком часто. Подождите минуту.',
    sheet_unavailable: 'Не удалось прочитать таблицу. Попробуйте обновить.',
    network: 'Нет связи с сервером.'
  };
  if (out && out.code === 'upstream') return 'Discord отклонил отправку (код ' + out.status + ').';
  return messages[out && out.code] || ('Не удалось: ' + ((out && (out.detail || out.code)) || 'ошибка'));
}

function setsApi(force) {
  return apiFetch('/api/sets' + (force ? '?refresh=1' : ''), {
    method: 'GET',
    cache: 'no-store',
    headers: authHeader()
  }).then(res => res.json().catch(() => ({ ok: false, code: 'bad_response', status: res.status })))
    .catch(e => ({ ok: false, code: 'network', detail: String((e && e.message) || e) }));
}

async function setsLoadRoster(force) {
  if (setsLoading) return;
  setsLoading = true;
  setsLoadError = '';
  const status = $('setsStatus');
  if (status) status.textContent = 'Загрузка данных из таблицы…';

  const out = await setsApi(!!force);
  setsLoading = false;

  if (out && out.ok === true) {
    setsRoster = {
      staff: Array.isArray(out.staff) ? out.staff.filter(p => p && p.name) : [],
      interns: Array.isArray(out.interns) ? out.interns.filter(p => p && p.name) : [],
      seniors: Array.isArray(out.seniors) ? out.seniors.filter(p => p && p.name) : []
    };
    setsLoaded = true;
    /* Убираем выбранных, которых больше нет в таблице. */
    Object.keys(setsSelected).forEach(group => {
      const alive = {};
      (setsRoster[group] || []).forEach(person => { alive[setsPersonKey(person)] = true; });
      setsSelected[group] = setsSelected[group].filter(key => alive[key]);
    });
  } else {
    setsLoaded = false;
    setsLoadError = (out && out.code) || 'error';
  }
  renderSetsForm();
}

function renderSetsForm() {
  const root = $('setsRoot');
  if (!root) return;

  if (!getAuthToken()) {
    root.innerHTML = `
      <div class="ann-login">
        <h4>Доступ</h4>
        <div class="a-hint">Раздел только для старшего состава. Введите секрет сервера — доступ действует 24 часа.</div>
        <div class="ann-time-row">
          <input type="password" id="setsSecret" class="ann-input" placeholder="секрет сервера" autocomplete="off">
          <button type="button" class="a-btn sec" id="setsLoginBtn">Подтвердить</button>
        </div>
        <div id="setsLoginStatus" class="a-hint" style="margin:10px 0 0"></div>
      </div>`;
    const loginBtn = $('setsLoginBtn');
    if (loginBtn) {
      loginBtn.onclick = async () => {
        const input = $('setsSecret');
        const status = $('setsLoginStatus');
        const password = (input && input.value ? input.value : '').trim();
        if (!password) { if (status) status.textContent = 'Введите секрет сервера.'; return; }
        if (status) status.textContent = 'Проверка…';
        const outcome = await acquireAuthToken(password);
        if (outcome.ok) {
          setsLoaded = false;
          setsLoadError = '';
          renderSetsForm();
          toast('Доступ подтверждён', 'Можно отправлять результаты наборов.');
        } else {
          const messages = {
            unauthorized: 'Неверный секрет сервера.',
            no_server_secret: 'На сервере не задан ADMIN_SECRET.',
            rate_limited: 'Слишком много попыток. Подождите минуту.',
            network: 'Нет связи с сервером.'
          };
          if (status) status.textContent = messages[outcome.code] || ('Ошибка: ' + outcome.code);
        }
      };
    }
    return;
  }

  const times = setsTimeOptions();
  if (!setsTime || times.indexOf(setsTime) < 0) setsTime = times[0] || '';
  const todayTimes = announceSetsForDate(setsTodayIso());
  const timeSource = todayTimes.length ? 'сегодняшние наборы' : 'пресеты из блока 09';

  const typeButtons = SETS_TYPE_OPTIONS.map(type =>
    '<button type="button" class="sets-type-btn' + (type === setsType ? ' active' : '') +
    '" data-sets-type="' + escapeHtml(type) + '">' + escapeHtml(type) + '</button>'
  ).join('');

  const timeOptions = times.length
    ? times.map(value => '<option value="' + escapeHtml(value) + '"' +
        (value === setsTime ? ' selected' : '') + '>' + escapeHtml(value) + '</option>').join('')
    : '<option value="">Нет доступных наборов</option>';

  const groupsHtml = SETS_GROUPS.map(group => {
    const people = setsRoster[group.id] || [];
    const list = people.length
      ? people.map(person => {
        const key = setsPersonKey(person);
        const checked = (setsSelected[group.id] || []).indexOf(key) >= 0;
        return '<label class="sets-person' + (checked ? ' checked' : '') + '">' +
          '<input type="checkbox" data-sets-group="' + group.id + '" data-sets-key="' + escapeHtml(key) + '"' +
          (checked ? ' checked' : '') + '>' +
          '<span class="sets-person-name">' + escapeHtml(person.name) + '</span>' +
          (person.discord ? '<span class="sets-person-rank">@</span>' : '') +
          '</label>';
      }).join('')
      : '<div class="sets-empty">' + escapeHtml(group.empty) + '</div>';
    return `
      <div class="ann-field">
        <span class="ann-field-label">${escapeHtml(group.title)}<span class="ann-count" id="setsCount_${group.id}"></span></span>
        <div class="sets-people">${list}</div>
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="ann-layout">
      <div class="ann-main">
        <section class="ann-block">
          <div class="ann-block-head">
            <h4>Набор</h4>
            <span class="ann-count">${escapeHtml(timeSource)}</span>
          </div>

          <div class="ann-field">
            <span class="ann-field-label">Тип набора</span>
            <div class="sets-type-row">${typeButtons}</div>
          </div>

          <label class="ann-field">
            <span class="ann-field-label">Время набора <span class="ann-sub-note">из блока 09</span></span>
            <select id="setsTime" class="ann-input">${timeOptions}</select>
          </label>

          <label class="ann-field">
            <span class="ann-field-label">Сколько принято</span>
            <div class="sets-count-row">
              <input type="number" id="setsCount" class="ann-input" min="0" step="1" inputmode="numeric"
                     value="${escapeHtml(String(setsCount || '').trim() || '0')}">
              <span class="sets-count-note">человек</span>
            </div>
          </label>

          ${times.length ? '' : '<div class="sets-empty">Сегодня в блоке 09 ещё нет наборов и пресетов. Добавьте время в блоке 09 — оно появится здесь.</div>'}
        </section>

        <section class="ann-block">
          <div class="ann-block-head">
            <h4>Кто присутствовал</h4>
            <button type="button" class="a-btn sec" id="setsRefreshBtn">Обновить</button>
          </div>
          ${groupsHtml}
        </section>

        <section class="ann-block">
          <div class="ann-block-head"><h4>Отправка</h4></div>
          <div class="ann-send-row">
            <button type="button" class="a-btn ann-send" id="setsSendBtn">Отправить в Discord</button>
          </div>
          <div id="setsStatus" class="a-hint" style="margin:12px 0 0"></div>
        </section>
      </div>

      <aside class="ann-side">
        <div class="ann-block ann-preview-block">
          <div class="ann-block-head">
            <h4>Предпросмотр</h4>
            <span class="ann-pv-badge">Discord</span>
          </div>
          <div class="ann-preview" id="setsPreview"></div>
        </div>
      </aside>
    </div>`;

  root.querySelectorAll('[data-sets-type]').forEach(btn => {
    btn.onclick = () => {
      setsType = btn.dataset.setsType;
      root.querySelectorAll('[data-sets-type]').forEach(other => {
        other.classList.toggle('active', other === btn);
      });
      setsUpdatePreview();
    };
  });

  const timeSelect = $('setsTime');
  if (timeSelect) {
    timeSelect.onchange = () => {
      setsTime = timeSelect.value;
      setsUpdatePreview();
    };
  }

  const countInput = $('setsCount');
  if (countInput) {
    countInput.oninput = () => {
      setsCount = countInput.value;
      setsUpdatePreview();
    };
  }

  root.querySelectorAll('[data-sets-group]').forEach(input => {
    input.onchange = () => {
      const group = input.dataset.setsGroup;
      const key = input.dataset.setsKey;
      if (!setsSelected[group]) setsSelected[group] = [];
      const at = setsSelected[group].indexOf(key);
      if (input.checked) {
        if (at < 0) setsSelected[group].push(key);
      } else if (at >= 0) {
        setsSelected[group].splice(at, 1);
      }
      const label = input.closest('.sets-person');
      if (label) label.classList.toggle('checked', input.checked);
      setsSyncGroupCounts();
      setsUpdatePreview();
    };
  });

  const refreshBtn = $('setsRefreshBtn');
  if (refreshBtn) {
    refreshBtn.onclick = () => {
      setsLoaded = false;
      setsLoadError = '';
      setsLoadRoster(true);
    };
  }

  const sendBtn = $('setsSendBtn');
  if (sendBtn) sendBtn.onclick = setsSendNow;

  setsSyncGroupCounts();
  setsUpdatePreview();

  const status = $('setsStatus');
  if (status) {
    if (setsLoadError) status.textContent = setsStatusMessage({ code: setsLoadError });
    else if (!setsLoaded) status.textContent = 'Загрузка данных из таблицы…';
  }

  if (!setsLoaded && !setsLoading && !setsLoadError) setsLoadRoster(false);
}

async function setsSendNow() {
  const status = $('setsStatus');
  const countRaw = String(setsCount || '').trim();
  const count = Number(countRaw);
  if (!countRaw || !Number.isFinite(count) || count < 0 || Math.floor(count) !== count) {
    if (status) status.textContent = 'Укажите, сколько человек принято: целое число от 0.';
    return;
  }
  if (!setsTime) {
    if (status) status.textContent = 'Нет времени набора: добавьте его в блоке 09.';
    return;
  }

  const btn = $('setsSendBtn');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Отправка…';

  const ui = resolveBotMessage('sets', CONFIG);
  const users = [];
  ['seniors', 'staff', 'interns'].forEach(group => {
    setsSelectedPeople(group).forEach(person => {
      if (person.discord && users.indexOf(person.discord) < 0) users.push(person.discord);
    });
  });

  const content = (ui.content ? ui.content + '\n' : '') + setsMessageContent() +
    (ui.footer ? '\n-# ' + ui.footer : '');
  const payload = {
    username: ui.username || 'Результаты наборов',
    avatar_url: ui.avatar || 'https://ems.celleste.site/avatar.jpg',
    content,
    /* Пинги — только выбранным людям из составов.
       parse и users взаимоисключающие, поэтому передаём только users:
       упомянуты будут ровно те, кто есть в списке. */
    allowed_mentions: { users: users.slice(0, 100) }
  };

  const out = await postToProxy('sets', payload);
  if (btn) btn.disabled = false;

  if (out && out.ok) {
    if (status) {
      status.innerHTML = 'Отправлено.' + (out.data && out.data.url
        ? ' <a href="' + escapeHtml(out.data.url) + '" target="_blank" rel="noopener">Открыть сообщение</a>'
        : '');
    }
    toast('Результаты отправлены', 'Сообщение уже в Discord.');
  } else {
    if (status) status.textContent = setsStatusMessage(out);
  }
}

async function saveGSheet() {
  const el = $('statusGSheet');
  const input = $('gsheetUrlInput');
  const url = (input.value || '').trim();
  if (!url) { el.textContent = 'Вставьте ссылку на веб-приложение Apps Script.'; return; }
  el.textContent = 'Сохранение...';
  const outcome = await putWebhookConfig('gsheet', url);
  if (outcome.ok) {
    input.value = '';
    el.textContent = 'Ссылка сохранена — строки из еженедельных отчётов будут записываться в таблицу.';
    refreshGSheetStatus();
  } else if (outcome.code === 'unauthorized') {
    el.textContent = 'Неверный секрет сервера.';
  } else if (outcome.code === 'bad_url') {
    el.textContent = 'Ссылка не похожа на веб-приложение Apps Script (нужно https://script.google.com/macros/s/.../exec).';
  } else if (outcome.code === 'no_secret' || outcome.code === 'no_server_secret') {
    el.textContent = 'Не задан секрет сервера.';
  } else if (outcome.code === 'no_storage') {
    el.textContent = 'Хранилище на сервере недоступно.';
  } else {
    el.textContent = 'Не удалось сохранить: ' + (outcome.detail || outcome.code || outcome.status || 'ошибка');
  }
}

async function clearGSheet(btn) {
  const el = $('statusGSheet');
  if (btn && btn.dataset.busy === '1') return;
  if (gsheetConfigured && !confirm('Отключить запись в Google-таблицу? Еженедельные отчёты перестанут в неё попадать.')) return;
  if (btn) btn.dataset.busy = '1';
  el.textContent = 'Отключение...';
  const outcome = await putWebhookConfig('gsheet', '');
  if (btn) btn.dataset.busy = '';
  if (outcome.ok) {
    if ($('gsheetUrlInput')) $('gsheetUrlInput').value = '';
    el.textContent = 'Запись в таблицу отключена.';
    refreshGSheetStatus();
  } else if (outcome.code === 'unauthorized') {
    el.textContent = 'Неверный секрет сервера.';
  } else {
    el.textContent = 'Не удалось отключить: ' + (outcome.detail || outcome.code || outcome.status || 'ошибка');
  }
}

async function refreshGSheetStatus() {
  const el = $('statusGSheet');
  if (!el) return;
  await fetchWebhookStatus();
  el.textContent = gsheetConfigured
    ? 'Google-таблица подключена — строки записываются.'
    : 'Google-таблица не подключена.';
}

/* ---- Блок 08 «Списки на премию» (только админ) ---- */

const PREMIUM_ROLE_ID = '784494588051193906';
const PREMIUM_STAFF_EMOJI = [
  '<a:Eanimated:795490820785569822>',
  '<a:Mananimated:795490828356288523>',
  '<a:Sananimated:795490838373072917>'
];
const PREMIUM_KING = '<:king_crysip:920305407577182229>';

function premiumTemplate() {
  const saved = (CONFIG && CONFIG.premiumTemplate) || {};
  const def = DEFAULT_CONFIG.premiumTemplate || {};
  const t = Object.assign({}, def, saved);
  // force non-empty critical fields
  if (!t.header) t.header = def.header;
  if (!t.divider) t.divider = def.divider;
  if (!t.senior) t.senior = def.senior;
  if (!t.person) t.person = def.person;
  if (!t.king) t.king = def.king;
  return t;
}

function fillTemplate(tpl, vars) {
  return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

function premiumId(value, wrap) {
  const raw = String(value || '').replace(/<@|>/g, '').trim();
  return wrap ? '<@' + raw + '>' : raw;
}

function buildPremiumText(d, tplOverride) {
  const t = tplOverride ? Object.assign({}, DEFAULT_CONFIG.premiumTemplate, tplOverride) : premiumTemplate();
  const week = String((d && d.week) || '').trim();
  const seniors = (d && Array.isArray(d.seniors)) ? d.seniors : [];
  const people = (d && Array.isArray(d.people)) ? d.people : [];
  const top = (d && d.top) || null;

  const lines = [];
  lines.push(fillTemplate(t.header, { role: '<@&' + PREMIUM_ROLE_ID + '>', week: week }));
  lines.push(t.divider);
  for (let i = 0; i < 3; i++) {
    const sp = i === 2 ? '  ' : '';
    lines.push(fillTemplate(t.senior, {      id: premiumId(seniors[i], true),
      emoji: PREMIUM_STAFF_EMOJI[i],
      sp: sp,
      align: sp
    }));
  }
  lines.push(t.divider);
  people.forEach(p => {
    lines.push(fillTemplate(t.person, {
      id: premiumId(p.id, true),
      points: String(p.points != null ? p.points : 0),
      link: String(p.link || ''),
      d: String(p.d != null ? p.d : '')
    }));
  });
  lines.push(t.divider);
  lines.push('');
  if (top && top.id) {
    lines.push(fillTemplate(t.king, {
      kingIcon: PREMIUM_KING,
      id: premiumId(top.id, true),
      points: String(top.points != null ? top.points : 0)
    }));
  }
  return lines.join('\n');
}

async function renderPremium() {
  const text = premiumText;
  const copy = premiumCopyBtn;
  if (copy) copy.disabled = true;
  let data;
  try {
    const res = await apiFetch('/api/premium', { method: 'GET', cache: 'no-store', headers: authHeader() });
    data = await res.json().catch(() => null);
  } catch (e) {
    data = null;
  }
  if (!data || data.ok !== true) {
    const unauthorized = data && (data.code === 'unauthorized' || data.code === 'no_server_secret');
    text.value = unauthorized
      ? 'Нет доступа к данным. Откройте «Настройки» → «Подтвердить доступ» и введите секрет сервера (действует 24 часа).'
      : buildPremiumText({ week: '', seniors: ['<@>','<@>','<@>'], people: [], top: null });
    return;
  }
  text.value = buildPremiumText(data);
  if (copy) copy.disabled = false;
}

async function copyPremiumText() {
  const text = $('premiumText');
  if (!text || !text.value) return;
  try {
    await navigator.clipboard.writeText(text.value);
    toast('Скопировано', 'Текст списков на премию в буфере обмена');
  } catch (e) {
    toast('Не удалось скопировать', String(e.message || e), 'error');
  }
}

const AUTH_TOKEN_KEY = 'ems.auth.token';
const HOST_TOKEN_PREFIX = 'ems.auth.host.';

function getAuthToken() {
  try { return localStorage.getItem(AUTH_TOKEN_KEY) || ''; } catch (e) { return ''; }
}

function setAuthToken(token) {
  try {
    if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch (e) {}
}

/* На Vercel и Cloudflare могут быть разные ADMIN_SECRET, поэтому у каждого
   хоста держим собственный токен, полученный тем же паролем на месте. */
function hostTokenKey(host) {
  try { return HOST_TOKEN_PREFIX + new URL(host).host; }
  catch (e) { return HOST_TOKEN_PREFIX + String(host || ''); }
}

function getHostToken(host) {
  try { return localStorage.getItem(hostTokenKey(host)) || getAuthToken(); }
  catch (e) { return getAuthToken(); }
}

function setHostToken(host, token) {
  try {
    const key = hostTokenKey(host);
    if (token) localStorage.setItem(key, token);
    else localStorage.removeItem(key);
  } catch (e) {}
}

async function primeHostTokens(password) {
  if (!password) return { ok: false, code: 'no_secret', results: [] };
  const targets = settingsSyncTargets();
  const results = await Promise.all(targets.map(async host => {
    try {
      const res = await fetchWithTimeout(host + '/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      }, 10000);
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.ok && data.token) {
        setHostToken(host, data.token);
        return { host, ok: true };
      }
      /* Явный отказ — сбрасываем старый токен; при сетевой ошибке оставляем. */
      if (res.ok || res.status === 401 || res.status === 403 || res.status === 503) setHostToken(host, '');
      return { host, ok: false, code: (data && data.code) || ('http_' + res.status) };
    } catch (e) {
      return { host, ok: false, code: 'network', detail: String((e && e.message) || e) };
    }
  }));
  return { ok: results.some(r => r.ok), results };
}

function authHeader() {
  const token = getAuthToken();
  return token ? { Authorization: 'Bearer ' + token } : {};
}

/* Зеркало может не отвечать — не подвешиваем вход и сохранение настроек. */
async function fetchWithTimeout(url, options, timeoutMs) {
  if (typeof AbortController === 'undefined') return fetch(url, options);
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs || 10000);
  try {
    return await fetch(url, Object.assign({}, options || {}, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/* Меняем пароль на короткоживущий токен (24 ч). Сам пароль в браузере не сохраняется. */
async function acquireAuthToken(password) {
  try {
    const res = await apiFetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data && data.ok && data.token) { setAuthToken(data.token); return { ok: true }; }
    return { ok: false, code: (data && data.code) || ('http_' + res.status) };
  } catch (e) {
    return { ok: false, code: 'network', detail: String((e && e.message) || e) };
  }
}

async function saveAdminSecret() {
  const input = $('adminSecretInput');
  const status = $('adminSecretStatus');
  const password = (input && input.value ? input.value : '').trim();
  if (!password) { if (status) status.textContent = 'Введите секрет сервера.'; return; }
  if (status) status.textContent = 'Проверка…';
  const outcome = await acquireAuthToken(password);
  if (outcome.ok) {
    if (status) status.textContent = 'Проверка зеркал…';
    const primed = await primeHostTokens(password);
    if (input) input.value = '';
    const failedHosts = (primed.results || []).filter(r => !r.ok).map(r => {
      try { return new URL(r.host).host; } catch (e) { return r.host; }
    });
    if (status) {
      status.textContent = failedHosts.length
        ? 'Доступ подтверждён (24 часа), но зеркало не приняло пароль: ' + failedHosts.join(', ')
        : 'Доступ подтверждён (действует 24 часа).';
    }
    toast('Доступ подтверждён', failedHosts.length
      ? 'Основной сервер доступен, зеркало — нет.'
      : 'Токен действителен 24 часа, зеркала синхронизированы.');
  } else {
    const messages = {
      unauthorized: 'Неверный секрет сервера.',
      no_server_secret: 'На сервере не задан ADMIN_SECRET.',
      rate_limited: 'Слишком много попыток. Подождите минуту.',
      network: 'Нет связи с сервером.'
    };
    const msg = messages[outcome.code] || ('Ошибка: ' + outcome.code);
    if (status) status.textContent = msg;
    toast('Не удалось', msg, 'error');
  }
}

/* Общие настройки хранятся на сервере, чтобы их видели все пользователи.
   Локальная копия остаётся как кэш и мгновенно применяется при загрузке. */
async function syncRemoteConfig() {
  let data;
  try {
    const res = await apiFetch('/api/config', { cache: 'no-store' });
    if (!res || !res.ok) return false;
    data = await res.json();
  } catch (e) {
    return false;
  }
  if (!data || !data.ok || !data.config || typeof data.config !== 'object') return false;
  CONFIG = mergeConfig(CONFIG, data.config);
  try { persistConfig(CONFIG); } catch (e) {}
  return true;
}

/* ---- Автосинхронизация настроек: Vercel ↔ Cloudflare Pages ----
   Сохраняем настройки сразу в оба хранилища, чтобы зеркала не расходились.
   Секреты на хостах могут отличаться, поэтому при входе получаем токен
   для каждого домена отдельно (primeHostTokens). */
const SETTINGS_SYNC_HOSTS = ['https://ems.celleste.site', 'https://ems-ip.pages.dev'];

function settingsSyncTargets() {
  try {
    if (location.protocol === 'file:') return [];
  } catch (e) {}
  return SETTINGS_SYNC_HOSTS.slice();
}

function syncOutcome(results) {
  const list = Array.isArray(results) ? results : [];
  const ok = list.filter(r => r.ok);
  if (ok.length) {
    return {
      ok: true,
      synced: ok.map(r => r.host),
      failed: list.filter(r => !r.ok).map(r => r.host),
      partial: ok.length < list.length
    };
  }
  const first = list[0] || {};
  return {
    ok: false,
    code: first.code || 'network',
    detail: first.detail || '',
    status: first.status,
    failed: list.map(r => r.host)
  };
}

async function syncSettingsPost(path, body) {
  const token = getAuthToken();
  if (!token) return { ok: false, code: 'no_secret', failed: settingsSyncTargets() };
  const targets = settingsSyncTargets();
  const results = await Promise.all(targets.map(async host => {
    try {
      const hostToken = getHostToken(host) || token;
      const postWith = async (bearer) => {
        const res = await fetchWithTimeout(host + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
          body: JSON.stringify(body)
        }, 15000);
        const data = await res.json().catch(() => null);
        return { res, data };
      };
      let { res, data } = await postWith(hostToken);
      /* Токен зеркала мог устареть — пробуем основной, если он отличается. */
      if (res.status === 401 && hostToken !== token) {
        ({ res, data } = await postWith(token));
      }
      return {
        host,
        ok: !!(data && data.ok),
        code: data && data.code,
        status: res.status,
        data
      };
    } catch (e) {
      return { host, ok: false, code: 'network', detail: String((e && e.message) || e) };
    }
  }));
  const out = syncOutcome(results);
  out.results = results;
  return out;
}

async function publishRemoteConfig(config) {
  return syncSettingsPost('/api/config', { config });
}

async function putWebhookConfig(slot, url) {
  return syncSettingsPost('/api/webhook-config', { slot, url });
}


async function saveWebhookConfig(slot) {
  const el = $('statusWebhook_' + slot);
  const input = $('whUrl_' + slot);
  const url = (input.value || '').trim();
  if (!url) { el.textContent = 'Вставьте ссылку на вебхук.'; return; }
  el.textContent = 'Сохранение...';
  const outcome = await putWebhookConfig(slot, url);
  if (outcome.ok) {
    input.value = '';
    if (outcome.partial) {
      el.textContent = 'Сохранено не на всех зеркалах: ' + (outcome.failed || []).join(', ');
    } else {
      el.textContent = 'Вебхук сохранён на сервере — отправка работает.';
    }
    refreshWebhookStatus(slot);
  } else if (outcome.code === 'unauthorized') {
    el.textContent = 'Неверный секрет сервера.';
  } else if (outcome.code === 'bad_url') {
    el.textContent = 'Ссылка не похожа на вебхук Discord.';
  } else if (outcome.code === 'no_secret' || outcome.code === 'no_server_secret') {
    el.textContent = 'Не задан секрет сервера.';
  } else if (outcome.code === 'no_storage') {
    el.textContent = 'Хранилище на сервере недоступно.';
  } else {
    el.textContent = 'Не удалось сохранить: ' + (outcome.detail || outcome.code || outcome.status || 'ошибка');
  }
}

async function clearWebhookConfig(slot, btn) {
  const el = $('statusWebhook_' + slot);
  if (btn && btn.dataset.busy === '1') return;
  const hasConfig = webhookStatus.indexOf(slot) !== -1;
  if (hasConfig && !confirm('Отключить вебхук «' + slot + '»? Отчёты перестанут отправляться в Discord.')) return;
  if (btn) btn.dataset.busy = '1';
  el.textContent = 'Отключение...';
  const outcome = await putWebhookConfig(slot, '');
  if (btn) btn.dataset.busy = '';
  if (outcome.ok) {
    if ($('whUrl_' + slot)) $('whUrl_' + slot).value = '';
    if (outcome.partial) {
      el.textContent = 'Отключено не на всех зеркалах: ' + (outcome.failed || []).join(', ');
    } else {
      el.textContent = 'Вебхук отключён.';
    }
    refreshWebhookStatus(slot);
  } else if (outcome.code === 'unauthorized') {
    el.textContent = 'Неверный секрет сервера.';
  } else if (outcome.code === 'no_secret' || outcome.code === 'no_server_secret') {
    el.textContent = 'Не задан секрет сервера.';
  } else if (outcome.code === 'no_storage') {
    el.textContent = 'Хранилище на сервере недоступно.';
  } else {
    el.textContent = 'Не удалось отключить: ' + (outcome.detail || outcome.code || outcome.status || 'ошибка');
  }
}

async function refreshWebhookStatus(slot) {
  const el = $('statusWebhook_' + slot);
  if (!el) return;
  await fetchWebhookStatus();
  el.textContent = webhookStatus.indexOf(slot) !== -1
    ? 'Вебхук настроен — отправка работает.'
    : 'Вебхук не настроен — данные сохраняются локально.';
}

async function refreshAllWebhookStatus() {
  await fetchWebhookStatus();
  WEBHOOK_SLOTS.forEach(s => {
    const el = $('statusWebhook_' + s.slot);
    if (el) el.textContent = webhookStatus.indexOf(s.slot) !== -1
      ? 'Вебхук настроен — отправка работает.'
      : 'Вебхук не настроен — данные сохраняются локально.';
  });
}

async function testWebhook(slot) {
  const el = $('statusWebhook_' + slot);
  const meta = WEBHOOK_SLOTS.find(s => s.slot === slot);
  if (!el || !meta) return;
  el.textContent = 'Отправка теста...';
  const payload = {
    username: meta.name,
    avatar_url: PROMO_AVATAR,
    content: '',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: 'Тест EMS · ' + meta.name,
      description: 'Вебхук настроен правильно — сообщения будут приходить сюда.',
      color: 0xb6e04d,
      footer: PROMO_FOOTER,
      timestamp: new Date().toISOString()
    }]
  };
  let outcome;
  try {
    outcome = await postToProxy(slot, payload);
  } catch (e) {
    outcome = { ok: false, code: 'error', detail: String((e && e.message) || e) };
  }
  if (outcome.ok) {
    el.textContent = 'Тест отправлен — проверьте канал Discord.';
    refreshWebhookStatus(slot);
  } else if (outcome.code === 'not_configured') {
    el.textContent = 'Вебхук не настроен — данные сохраняются локально.';
  } else {
    el.textContent = 'Ошибка: ' + (outcome.detail || outcome.status || 'неизвестная ошибка');
  }
}

/* --- архив отчётов --- */
function renderAdminReports() {
  const list = loadReports();
  const kindName = t => t === 'weekly' ? 'Еженедельный отчёт' : (t === 'night' ? 'Ночная активность' : (t === 'stat' ? 'Запись на стажировку' : (t === 'intern' ? 'Отчёт о стажировке' : (t === 'unfit' ? 'Профнепригодность' : 'Отчёт на повышение'))));

  let html = `<div class="a-section"><h4>Архив отчётов</h4>
    <div class="a-hint">Все отправленные и сохранённые отчёты этого браузера: ${getDeclension(list.length, 'запись', 'записи', 'записей')}.</div>`;
  html += list.length
    ? list.map(r => `<div class="report-item" data-id="${r.id}">
        <div class="report-top">
          <span class="report-kind">${kindName(r.type)}</span>
          <span class="report-date">${new Date(r.createdAt).toLocaleString('ru-RU')}</span>
        </div>
        <div class="report-meta">${escapeHtml(r.fullName || '')}${r.period ? ' · ' + escapeHtml(r.period) : ''}${r.rank ? ' · ' + escapeHtml(r.rank) : ''}${r.type === 'stat' ? '' : ' · <b style="color:var(--accent)">' + r.totalPoints + ' баллов</b>'} · ${r.failed ? 'ошибка отправки' : (r.sent ? 'отправлен' : 'локально')}</div>
        <div class="report-actions">
          <button type="button" class="a-btn sec report-copy">Скопировать текст</button>
          <button type="button" class="a-btn danger report-del">Удалить</button>
        </div>
      </div>`).join('')
    : '<div class="a-empty">Отчётов пока нет</div>';
  html += `<div class="a-add"><button type="button" class="a-btn sec" id="exportReportsBtn">Выгрузить JSON</button><button type="button" class="a-btn danger" id="clearReportsBtn">Очистить архив</button></div></div>`;

  $('tabReports').querySelector('.admin-scroll').innerHTML = html;

  $('tabReports').querySelectorAll('.report-del').forEach(btn => {
    btn.onclick = () => { deleteReport(btn.closest('.report-item').dataset.id); renderAdminReports(); };
  });
  $('tabReports').querySelectorAll('.report-copy').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.closest('.report-item').dataset.id;
      const rec = loadReports().find(r => r.id === id);
      if (!rec) return;
      try {
        await navigator.clipboard.writeText(reportToText(rec));
        toast('Скопировано', 'Текст отчёта в буфере обмена');
      } catch (e) {
        toast('Не удалось скопировать', String(e.message || e), 'error');
      }
    };
  });
  $('exportReportsBtn').onclick = () => downloadJson('ems-reports.json', loadReports());
  $('clearReportsBtn').onclick = () => {
    if (!confirm('Удалить все сохранённые отчёты?')) return;
    clearReports();
    renderAdminReports();
  };
}

function reportToText(r) {
  const lines = [];
  if (r.type === 'stat') {
    lines.push('ЗАПИСЬ НА СТАЖИРОВКУ');
    lines.push('Имя: ' + (r.fullName || '—'));
    lines.push('Ссылка на присутствие в наборе в EMS: ' + (r.attendanceLink || '—'));
    lines.push('Удобное время прохождения стажировки: ' + (r.prefTime || '—'));
    return lines.join('\n');
  }
  if (r.type === 'unfit') {
    lines.push('ПРОФНЕПРИГОДНОСТЬ');
    lines.push('Отправил: ' + (r.reporterId || '—'));
    lines.push('ID сотрудника: ' + (r.employeeId || '—'));
    lines.push('ФИ сотрудника: ' + (r.fullName || '—'));
    lines.push('Паспорт: ' + (r.passport || '—'));
    lines.push('Дата последнего повышения: ' + (r.lastPromo || '—'));
    lines.push('Ранг: ' + (r.rank || '—'));
    lines.push('Фото: ' + (r.photo || '—'));
    return lines.join('\n');
  }
  lines.push(r.type === 'weekly' ? 'ЕЖЕНЕДЕЛЬНЫЙ ОТЧЁТ' : (r.type === 'night' ? 'НОЧНАЯ АКТИВНОСТЬ' : 'ОТЧЁТ НА ПОВЫШЕНИЕ'));
  lines.push('Имя: ' + (r.fullName || '—'));
  if (r.type === 'weekly' || r.type === 'night') lines.push('Период: ' + (r.period || '—'));
  else {
    lines.push('Ранг: ' + (r.rank || '—'));
    if (r.testLink) lines.push('Тест: ' + r.testLink);
    if (r.examMedLink) lines.push('Экзамен Мед.Карт: ' + r.examMedLink);
    if (r.examAspLink) lines.push('Экзамен АСМП: ' + r.examAspLink);
  }
  lines.push('');
  (r.items ? r.items.standard : []).forEach(i => lines.push(`• ${i.name}: ${i.count} шт., +${i.points} — ${i.link}`));
  (r.items ? r.items.extra : []).forEach(i => lines.push(`• ${i.name}: ${i.count} шт., +${i.points} — ${i.link}`));
  lines.push('');
  lines.push('Итого баллов: ' + r.totalPoints);
  return lines.join('\n');
}

/* --- данные / экспорт --- */
function renderAdminData() {
  $('tabData').querySelector('.admin-scroll').innerHTML = `
    <div class="a-section">
      <h4>Экспорт и импорт настроек</h4>
      <div class="a-hint">JSON содержит пункты, категории, правила, баннеры и вебхуки. Переносится между браузерами и устройствами.</div>
      <div class="a-add">
        <button type="button" class="a-btn sec" id="exportCfgBtn">Экспорт JSON</button>
        <button type="button" class="a-btn sec" id="importCfgBtn">Импорт JSON</button>
        <input type="file" id="importCfgFile" accept="application/json" style="display:none">
        <button type="button" class="a-btn danger" id="resetCfgBtn">Сбросить к заводским</button>
      </div>
    </div>
    <div class="a-section">
      <h4>Пароль администратора</h4>
      <div class="a-hint">Хранится локально в этом браузере. По умолчанию — <b>admin</b>.</div>
      <div class="a-add">
        <input type="text" id="newAdminPass" placeholder="Новый пароль" style="max-width:260px">
        <button type="button" class="a-btn" id="savePassBtn">Сменить пароль</button>
      </div>
      <div id="passStatus" class="a-hint" style="margin-top:10px"></div>
    </div>
    <div class="a-section">
      <h4>Пароль для Ассистента</h4>
      <div class="a-hint">Открывает разделы 05 «Вопросы для стажировки» и 06 «Отчёт о стажировке» (без доступа к админке).</div>
      <div class="a-add">
        <input type="text" id="newEditorPass" placeholder="Новый пароль" style="max-width:260px">
        <button type="button" class="a-btn" id="saveEditorPassBtn">Сменить пароль</button>
      </div>
      <div id="editorPassStatus" class="a-hint" style="margin-top:10px"></div>
    </div>
    <div class="a-section">
      <h4>Доступы на этом устройстве</h4>
      <div class="a-hint">Вход держится <b>7 дней</b>, после чего сбрасывается автоматически. Здесь можно снять доступ вручную (для этого браузера/устройства).</div>
      <div class="a-add">
        <button type="button" class="a-btn sec" id="revokeEditorBtn">Снять права ассистента</button>
        <button type="button" class="a-btn danger" id="logoutAdminBtn">Выйти из админки</button>
      </div>
      <div id="accessStatus" class="a-hint" style="margin-top:10px"></div>
    </div>`;

  $('exportCfgBtn').onclick = () => downloadJson('ems-config.json', editedConfig);

  $('importCfgBtn').onclick = () => $('importCfgFile').click();
  $('importCfgFile').onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        editedConfig = mergeConfig(DEFAULT_CONFIG, parsed);
        renderAdminEditor();
        toast('Импорт выполнен', 'Нажмите «Сохранить изменения», чтобы применить.');
      } catch (err) {
        toast('Ошибка импорта', 'Файл не является корректным JSON', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  $('resetCfgBtn').onclick = () => {
    if (!confirm('Сбросить все настройки к заводским значениям?')) return;
    editedConfig = deepClone(DEFAULT_CONFIG);
    renderAdminEditor();
    toast('Настроено по умолчанию', 'Нажмите «Сохранить изменения».');
  };

  $('savePassBtn').onclick = () => {
    const value = $('newAdminPass').value.trim();
    if (value.length < 3) return $('passStatus').textContent = 'Пароль должен быть не короче 3 символов.';
    editedConfig.adminPasswordHash = sha256hex(value);
    delete editedConfig.adminPassword;
    $('newAdminPass').value = '';
    $('passStatus').textContent = 'Пароль изменится после сохранения изменений.';
  };

  $('saveEditorPassBtn').onclick = () => {
    const value = $('newEditorPass').value.trim();
    if (value.length < 3) return $('editorPassStatus').textContent = 'Пароль должен быть не короче 3 символов.';
    editedConfig.editorPasswordHash = sha256hex(value);
    $('newEditorPass').value = '';
    $('editorPassStatus').textContent = 'Пароль ассистента изменится после сохранения изменений.';
  };

  $('revokeEditorBtn').onclick = () => {
    revokeAuth(EDITOR_AUTH_KEY);
    editorUnlocked = false;
    updateMenuVisibility();
    if (state.form === 'quiz' || state.form === 'intern' || state.form === 'unfit') showScreen('menu');
    $('accessStatus').textContent = 'Права ассистента сняты на этом устройстве.';
  };

  $('logoutAdminBtn').onclick = () => {
    revokeAuth(ADMIN_AUTH_KEY);
    adminUnlocked = false;
    updateMenuVisibility();
    closeAdmin();
    toast('Вы вышли из админки', 'Доступ нужно будет ввести заново.');
  };
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function saveAdminConfig() {
  const grab = (key) => {
    const urlEl = $(key + 'Url');
    const visEl = $(key + 'Visible');
    const typeEl = $(key + 'Type');
    if (urlEl) editedConfig[key] = {
      url: urlEl.value.trim(),
      visible: visEl ? visEl.checked : false,
      type: typeEl ? typeEl.value : 'auto'
    };
  };
  grab('bannerWeekly');
  grab('bannerPromotion');
  grab('bannerNight');
  grab('bannerStat');
  grab('bannerIntern');
  grab('bannerUnfit');

  const wt = $('weeklyTitleInput');
  const pt = $('promotionTitleInput');
  const nt = $('nightTitleInput');
  const st = $('statTitleInput');
  const it = $('internTitleInput');
  const ut = $('unfitTitleInput');
  if (wt) editedConfig.weeklyTitle = wt.value;
  if (pt) editedConfig.promotionTitle = pt.value;
  if (nt) editedConfig.nightTitle = nt.value;
  if (st) editedConfig.statTitle = st.value;
  if (it) editedConfig.internTitle = it.value;
  if (ut) editedConfig.unfitTitle = ut.value;

  showLoading('Сохраняем настройки…');
  setTimeout(() => {
    CONFIG = mergeConfig(DEFAULT_CONFIG, editedConfig);
    try {
      persistConfig(CONFIG);
    } catch (e) {
      hideLoading();
      toast('Не удалось сохранить настройки', 'Хранилище браузера переполнено — уберите большой файл-баннер или старые отчёты.', 'error');
      return;
    }
    hideLoading();
    applyConfig();
    renderActions(['weekly', 'promotion', 'night'].indexOf(state.form) >= 0 ? state.form : 'weekly');
    updatePoints('weekly');
    updatePoints('promotion');
    updatePoints('night');
    adminUnlocked = true;
    closeAdmin();
    toast('Настройки сохранены', 'Публикуем для всех пользователей…');
    publishRemoteConfig(CONFIG).then(outcome => {
      if (outcome && outcome.ok && outcome.partial) {
        toast('Опубликовано не везде', 'Не удалось обновить: ' + (outcome.failed || []).join(', '), 'error');
      } else if (outcome && outcome.ok) {
        toast('Настройки опубликованы', 'Изменения увидят все пользователи.');
      } else if (outcome && (outcome.code === 'no_secret' || outcome.code === 'no_server_secret')) {
        toast('Сохранено только локально', 'Задайте «Секрет сервера», чтобы изменения увидели все.', 'error');
      } else if (outcome && outcome.code === 'unauthorized') {
        toast('Сохранено только локально', 'Неверный «Секрет сервера».', 'error');
      } else if (outcome && outcome.code === 'too_large') {
        toast('Сохранено только локально', 'Настройки слишком большие для публикации — замените файл-баннер ссылкой.', 'error');
      } else {
        toast('Сохранено только локально', 'Не удалось опубликовать настройки на сервере.', 'error');
      }
    });
  }, 250);
}

/* ================= Инициализация ================= */

function initAdminEvents() {
  $('adminIcon').onclick = openAdmin;
  $('closeAdminModalBtn').onclick = closeAdmin;
  $('cancelAdminBtn').onclick = closeAdmin;
  $('cancelAdminEditBtn').onclick = closeAdmin;
  $('saveAdminBtn').onclick = saveAdminConfig;

  $('adminModal').addEventListener('click', e => { if (e.target === $('adminModal')) closeAdmin(); });

  $('adminPassword').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('loginAdminBtn').click(); }
  });

  $('loginAdminBtn').onclick = () => {
    const value = $('adminPassword').value;
    const err = $('adminError');
    if (!value) {
      err.textContent = 'Введите пароль';
      err.classList.remove('hidden');
      return;
    }
    const expected = CONFIG.adminPassword
      ? sha256hex(CONFIG.adminPassword)
      : (CONFIG.adminPasswordHash || sha256hex('admin'));
    if (expected === sha256hex(value)) {
      adminUnlocked = true;
      grantAuth(ADMIN_AUTH_KEY);
      err.classList.add('hidden');
      $('adminLogin').classList.add('hidden');
      $('adminPanel').classList.remove('hidden');
      document.querySelector('#adminModal .modal').classList.add('tall');
      editedConfig = deepClone(CONFIG);
      renderAdminEditor();
      const activeTab = document.querySelector('.admin-tab.active');
      if ($('saveAdminBtn')) $('saveAdminBtn').classList.toggle('hidden', !!activeTab && activeTab.dataset.tab === 'announce');
      updateMenuVisibility();
    } else {
      err.textContent = 'Неверный пароль';
      err.classList.remove('hidden');
      $('adminPassword').value = '';
      $('adminPassword').focus();
    }
  };

  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.onclick = () => switchTab(tab.dataset.tab);
  });
}

function initEditorEvents() {
  $('editorIcon').onclick = openEditor;
  $('closeEditorModalBtn').onclick = closeEditor;
  $('cancelEditorBtn').onclick = closeEditor;
  $('editorModal').addEventListener('click', e => { if (e.target === $('editorModal')) closeEditor(); });

  $('editorPassword').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('loginEditorBtn').click(); }
  });

  $('loginEditorBtn').onclick = () => {
    const value = $('editorPassword').value;
    const err = $('editorError');
    if (!value) {
      err.textContent = 'Введите пароль';
      err.classList.remove('hidden');
      return;
    }
    const expected = CONFIG.editorPasswordHash;
    if (expected && expected === sha256hex(value)) {
      editorUnlocked = true;
      grantAuth(EDITOR_AUTH_KEY);
      err.classList.add('hidden');
      closeEditor();
      updateMenuVisibility();
      toast('Режим ассистента включён', 'Появились разделы «Вопросы для стажировки» и «Отчёт о стажировке».');
    } else {
      err.textContent = 'Неверный пароль';
      err.classList.remove('hidden');
      $('editorPassword').value = '';
      $('editorPassword').focus();
    }
  };
}

/* ================= Фоновые частицы и «дальние звёзды» ================= */

function initBgParticles() {
  const cv = document.getElementById('bgParticles');
  if (!cv || typeof cv.getContext !== 'function') return;
  if (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.indexOf('jsdom') !== -1) return;
  let ctx = null;
  try { ctx = cv.getContext('2d'); } catch (e) { ctx = null; }
  if (!ctx) return;

  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COLORS = ['255,216,138', '255,181,77', '255,236,214', '255,140,96'];
  let w = 0, h = 0, dpr = 1, parts = [], stars = [], raf = 0;
  let px = 0.5, py = 0.4, tx = 0.5, ty = 0.4;

  function build() {
    const count = Math.max(45, Math.min(110, Math.round((w * h) / 17000)));
    parts = [];
    for (let i = 0; i < count; i++) {
      parts.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 0.6 + Math.random() * 1.7,
        vx: (Math.random() - 0.5) * 0.17,
        vy: (Math.random() - 0.5) * 0.17 - 0.035,
        c: COLORS[(Math.random() * COLORS.length) | 0],
        a: 0.22 + Math.random() * 0.48,
        tw: Math.random() * Math.PI * 2,
        ts: 0.006 + Math.random() * 0.015,
        depth: 0.3 + Math.random() * 0.7
      });
    }
    const starCount = Math.max(16, Math.min(42, Math.round((w * h) / 36000)));
    stars = [];
    for (let i = 0; i < starCount; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h * 0.8,
        r: Math.random() < 0.82 ? 0.7 : 1.3,
        a: 0.14 + Math.random() * 0.4,
        tw: Math.random() * Math.PI * 2
      });
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = cv.clientWidth || window.innerWidth || 1;
    h = cv.clientHeight || window.innerHeight || 1;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
    if (reduced) draw(0);
  }

  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    px += (tx - px) * 0.05;
    py += (ty - py) * 0.05;
    const ox = (px - 0.5) * 28;
    const oy = (py - 0.5) * 18;

    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const a = s.a * (0.55 + 0.45 * Math.sin(s.tw + t * 0.0016));
      ctx.fillStyle = 'rgba(255,241,224,' + a.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(s.x + ox * 0.3, s.y + oy * 0.3, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!reduced) {
        p.x += p.vx;
        p.y += p.vy;
        p.tw += p.ts;
        if (p.x < -24) p.x = w + 24; else if (p.x > w + 24) p.x = -24;
        if (p.y < -24) p.y = h + 24; else if (p.y > h + 24) p.y = -24;
      }
      p._x = p.x + ox * p.depth;
      p._y = p.y + oy * p.depth;
      const alpha = p.a * (0.62 + 0.38 * Math.sin(p.tw));
      ctx.fillStyle = 'rgba(' + p.c + ',' + alpha.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(p._x, p._y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < parts.length; i++) {
      const a = parts[i];
      for (let j = i + 1; j < parts.length; j++) {
        const b = parts[j];
        const dx = a._x - b._x;
        const dy = a._y - b._y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 15000) continue;
        const o = (1 - d2 / 15000) * 0.15;
        ctx.strokeStyle = 'rgba(255,203,146,' + o.toFixed(3) + ')';
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(a._x, a._y);
        ctx.lineTo(b._x, b._y);
        ctx.stroke();
      }
    }
  }

  function loop(t) {
    draw(t);
    raf = requestAnimationFrame(loop);
  }

  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('pointermove', e => {
    tx = (e.clientX || 0) / Math.max(1, window.innerWidth || 1);
    ty = (e.clientY || 0) / Math.max(1, window.innerHeight || 1);
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else if (!reduced) raf = requestAnimationFrame(loop);
  });

  resize();
  if (!reduced && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(loop);
}

function init() {
  try {
  if (typeof MutationObserver === 'function' && document.body) {
    new MutationObserver(() => hydrateIcons()).observe(document.body, { childList: true, subtree: true });
  }
    initBgParticles();
    restoreAuth();
    applyConfig();
  fetchWebhookStatus();
  initPeriodSelector('weekly');
  initPeriodSelector('night');
  initAdminEvents();
  initEditorEvents();
  initInternToggle();
  initUnfitPhoto();
  initUnfitDate();
  initUnfitRank();
  initParallax();

  renderRanks();
  renderActions('weekly');
  renderActions('promotion');
  renderActions('night');
  updatePoints('weekly');
  updatePoints('promotion');
  updatePoints('night');
  setCurrentWeek('weekly');
  renderCalendar('weekly');

  on('selectWeekly', 'click', () => showScreen('weekly'));
  on('selectPromotion', 'click', () => showScreen('promotion'));
  on('selectNight', 'click', () => showScreen('night'));
  on('selectStat', 'click', () => showScreen('stat'));
  on('selectQuiz', 'click', () => showScreen('quiz'));
  on('selectIntern', 'click', () => showScreen('intern'));
  on('selectUnfit', 'click', () => showScreen('unfit'));
  on('selectPremium', 'click', () => showScreen('premium'));
  on('selectAnnounce', 'click', () => { if (adminUnlocked) showScreen('announce'); });
  on('selectSets', 'click', () => { if (adminUnlocked) showScreen('sets'); });
  on('backToMenuWeekly', 'click', () => showScreen('menu'));
  on('backToMenuPromotion', 'click', () => showScreen('menu'));
  on('backToMenuNight', 'click', () => showScreen('menu'));
  on('backToMenuStat', 'click', () => showScreen('menu'));
  on('backToMenuQuiz', 'click', () => showScreen('menu'));
  on('backToMenuIntern', 'click', () => showScreen('menu'));
  on('backToMenuUnfit', 'click', () => showScreen('menu'));
  on('backToMenuPremium', 'click', () => showScreen('menu'));
  on('backToMenuAnnounce', 'click', () => showScreen('menu'));
  on('backToMenuSets', 'click', () => showScreen('menu'));
  on('premiumCopyBtn', 'click', copyPremiumText);
  on('premiumRefreshBtn', 'click', renderPremium);

  on('currentWeekBtnWeekly', 'click', e => { e.stopPropagation(); setCurrentWeek('weekly'); renderCalendar('weekly'); });
  on('clearBtnWeekly', 'click', e => { e.stopPropagation(); clearPeriod('weekly'); });
  on('currentWeekBtnNight', 'click', e => { e.stopPropagation(); setCurrentWeek('night'); renderCalendar('night'); });
  on('clearBtnNight', 'click', e => { e.stopPropagation(); clearPeriod('night'); });

  on('addBtnWeekly', 'click', openActModal);
  on('addBtnPromotion', 'click', openActModal);
  on('addBtnNight', 'click', openActModal);
  on('closeActModalBtn', 'click', closeActModal);
  on('actModal', 'click', e => { if (e.target === $('actModal')) closeActModal(); });
  on('actSearch', 'input', e => renderActModal(e.target.value));

  on('submitBtnWeekly', 'click', () => submitForm('weekly'));
  on('submitBtnPromotion', 'click', () => submitForm('promotion'));
  on('submitBtnNight', 'click', () => submitForm('night'));
  on('submitBtnStat', 'click', () => submitForm('stat'));
  on('submitBtnIntern', 'click', () => submitForm('intern'));
  on('submitBtnUnfit', 'click', () => submitForm('unfit'));

  on('quizResetBtn', 'click', () => { saveQuizChecked({}); renderQuiz(); });

  on('confirmCloseBtn', 'click', closeConfirm);
  on('confirmCancelBtn', 'click', closeConfirm);
  on('confirmOkBtn', 'click', () => { const fn = confirmAction; closeConfirm(); if (fn) fn(); });
  on('confirmModal', 'click', e => { if (e.target === $('confirmModal')) closeConfirm(); });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const isActive = id => { const el = $(id); return !!el && el.classList.contains('active'); };
    if (isActive('confirmModal')) closeConfirm();
    else if (isActive('actModal')) closeActModal();
    else if (isActive('adminModal')) closeAdmin();
    else if (isActive('editorModal')) closeEditor();
    else if (isActive('datePickerWeekly')) $('datePickerWeekly').classList.remove('active');
    else if (isActive('datePickerNight')) $('datePickerNight').classList.remove('active');
  });

  showScreen('menu');

  syncRemoteConfig().then(applied => {
    if (!applied) return;
    applyConfig();
    renderActions(['weekly', 'promotion', 'night'].indexOf(state.form) >= 0 ? state.form : 'weekly');
    updatePoints('weekly');
    updatePoints('promotion');
    updatePoints('night');
  });
  } catch (err) {
    console.error('[EMS] Ошибка инициализации:', err);
    try { hideLoading(); } catch (e) {}
  }
}

/* ================= SHA-256 ================= */
function sha256hex(str) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
        const cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        bytes.push(240 | (cp >> 18), 128 | ((cp >> 12) & 63), 128 | ((cp >> 6) & 63), 128 | (cp & 63));
        i++;
        continue;
      }
    }
    if (c < 128) bytes.push(c);
    else if (c < 2048) bytes.push(192 | (c >> 6), 128 | (c & 63));
    else bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  const len = bytes.length;
  const bitLen = len * 8;
  const total = (((len + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 4, bitLen >>> 0, false);
  dv.setUint32(total - 8, Math.floor(bitLen / 4294967296) >>> 0, false);

  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Int32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/* Глобальный перехват ошибок — чтобы сбой не оставлял «мёртвый» интерфейс молча */
window.addEventListener('error', e => {
  console.error('[EMS] window error:', e.message, e.filename ? e.filename + ':' + e.lineno : '');
});
window.addEventListener('unhandledrejection', e => {
  console.error('[EMS] unhandled rejection:', e.reason);
});

(function boot() {
  /* Заранее выбираем рабочий адрес API, чтобы первые запросы не висели. */
  try { ensureApiHost(); } catch (e) {}
  try {
    init();
  } catch (err) {
    console.error('[EMS] boot failed:', err);
    try { hideLoading(); } catch (e) {}
  }
})();
