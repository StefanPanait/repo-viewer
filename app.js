const REPO = 'StefanPanait/TripPlanning';
const API = `https://api.github.com/repos/${REPO}`;
const HOME = 'README.md';
const SYNC_EVERY_MS = 5 * 60 * 1000;

const doc = document.getElementById('doc');
const status = document.getElementById('status');
const banner = document.getElementById('banner');
const pin = document.getElementById('pin');

// IndexedDB rather than localStorage, so the service worker can read it too.
// kv: token, lastSync, startPage, lastPage. files: path -> { sha, text }.
const dbOpen = new Promise((resolve, reject) => {
  const open = indexedDB.open('trips', 2);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
  };
  open.onerror = () => reject(open.error);
  open.onsuccess = () => resolve(open.result);
});

async function tx(name, mode, fn) {
  const db = await dbOpen;
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, mode);
    const req = fn(t.objectStore(name));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const get = (name, key) => tx(name, 'readonly', s => s.get(key));
const put = (name, key, val) => tx(name, 'readwrite', s => s.put(val, key));
const del = (name, key) => tx(name, 'readwrite', s => s.delete(key));
const allKeys = name => tx(name, 'readonly', s => s.getAllKeys());

class AuthError extends Error {}

// A chat app's built-in browser (WeChat, WhatsApp, Facebook...) keeps its own storage, apart from
// the browser the app gets installed from.
const IN_APP_BROWSER = /MicroMessenger|WhatsApp|FBAN|FBAV|Instagram|Line\/|; wv\)/.test(navigator.userAgent);

// Accepts ?token= as well as #token=, since some chat apps drop the # part of a link.
async function readToken() {
  const url = new URL(location.href);
  const token = url.searchParams.get('token') ?? new URLSearchParams(url.hash.slice(1)).get('token');
  if (token) {
    await put('kv', 'token', token.trim());
    // Inside a chat app, keep the token in the link so "Open in browser" carries it across.
    if (!IN_APP_BROWSER) {
      url.searchParams.delete('token');
      url.hash = '';
      history.replaceState(null, '', url);
    }
  }
  return get('kv', 'token');
}

async function api(path, token, opts = {}) {
  const r = await fetch(`${API}/${path}`, {
    cache: opts.cache,
    headers: { Authorization: `Bearer ${token}`, Accept: opts.accept ?? 'application/vnd.github+json' },
  });
  if (r.status === 401) throw new AuthError('Access expired.');
  // GitHub answers 404, not 403, when a token can't see a private repo.
  if (r.status === 404) throw new AuthError("This token can't read the trip repo.");
  if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
  return r;
}

const wanted = path => path.endsWith('.md') && !path.startsWith('.claude/');

// Downloads only files whose sha changed and drops deleted ones. Returns the number of changes.
async function sync(token, onProgress) {
  // no-cache revalidates with the ETag; an unchanged tree comes back 304, which is free.
  const tree = await (await api('git/trees/main?recursive=1', token, { cache: 'no-cache' })).json();
  const remote = new Map(tree.tree.filter(t => t.type === 'blob' && wanted(t.path)).map(t => [t.path, t.sha]));
  const local = new Map();
  for (const path of await allKeys('files')) local.set(path, (await get('files', path)).sha);

  const changed = [...remote].filter(([path, sha]) => local.get(path) !== sha);
  const removed = [...local.keys()].filter(path => !remote.has(path));

  let done = 0;
  const queue = [...changed];
  const worker = async () => {
    for (let item; (item = queue.shift());) {
      const [path, sha] = item;
      const text = await (await api(`git/blobs/${sha}`, token, { accept: 'application/vnd.github.raw' })).text();
      await put('files', path, { sha, text });
      onProgress?.(++done, changed.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  for (const path of removed) await del('files', path);
  await put('kv', 'lastSync', Date.now());
  return changed.length + removed.length;
}

// GitHub's heading anchors: lowercase, drop punctuation, spaces to hyphens, duplicates get -1, -2...
function addHeadingIds(root) {
  const seen = new Map();
  for (const h of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const base = h.textContent.trim().toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    h.id = n ? `${base}-${n}` : base;
  }
}

function rewriteLinks(root, path) {
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^[a-z]+:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener'; continue; }
    if (href.startsWith('#')) continue;
    const url = new URL(href, `https://repo/${path}`);
    const target = decodeURIComponent(url.pathname.slice(1));
    a.href = target.endsWith('.md') || target.endsWith('/')
      ? `?p=${encodeURIComponent(target)}${url.hash}`
      : `https://github.com/${REPO}/blob/main/${target}${url.hash}`;
  }
}

const renderer = {
  code({ text, lang }) {
    if (lang !== 'geojson') return false;
    return `<div class="map" data-geojson="${encodeURIComponent(text)}"></div>`;
  },
};

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// WGS-84 -> GCJ-02, ported from tools/geo.py. Amap only reads GCJ-02.
function wgs2gcj(lon, lat) {
  if (!(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55)) return [lon, lat];
  const A = 6378245.0, EE = 0.00669342162296594323, PI = Math.PI;
  const x = lon - 105, y = lat - 35;
  let dlat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  dlat += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  dlat += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  dlat += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
  let dlon = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dlon += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  dlon += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  dlon += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
  const rad = lat * PI / 180, m = 1 - EE * Math.sin(rad) ** 2, sm = Math.sqrt(m);
  return [lon + dlon * 180 / (A / sm * Math.cos(rad) * PI), lat + dlat * 180 / (A * (1 - EE) / (m * sm) * PI)];
}

function amapUrl([lon, lat], name) {
  const [glon, glat] = wgs2gcj(lon, lat);
  const position = `${glon.toFixed(6)},${glat.toFixed(6)}`;
  return `https://uri.amap.com/marker?position=${position}&name=${encodeURIComponent(name)}&coordinate=gaode&callnative=1`;
}

function popup(f) {
  const { name = '', ...rest } = f.properties ?? {};
  const rows = Object.values(rest).map(v => `<div>${esc(v)}</div>`).join('');
  const amap = f.geometry.type === 'Point'
    ? `<a href="${esc(amapUrl(f.geometry.coordinates, name))}" target="_blank" rel="noopener">Open in Amap</a>` : '';
  return `<b>${esc(name)}</b>${rows}${amap}`;
}

// Numbered like tools/geo.py's geojson.io styling: a name starting "3." gets a 3 on its pin.
const pinIcon = name => L.divIcon({
  className: 'pin', iconSize: [24, 24], popupAnchor: [0, -10],
  html: esc(String(name ?? '').match(/^(\d+)\./)?.[1] ?? ''),
});

// One-finger drags scroll the page until the map is tapped, so a map can't trap the scroll.
function drawMaps(root) {
  if (!window.L) return; // a stale cached index.html without Leaflet, during a shell update
  for (const el of root.querySelectorAll('.map')) {
    let data;
    try { data = JSON.parse(decodeURIComponent(el.dataset.geojson)); } catch { continue; }
    const map = L.map(el, { dragging: false, scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, crossOrigin: true, attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    const layer = L.geoJSON(data, {
      pointToLayer: (f, latlng) => L.marker(latlng, { icon: pinIcon(f.properties?.name) }),
      style: { color: '#d9534f', weight: 3 },
      onEachFeature: (f, l) => l.bindPopup(popup(f)),
    }).addTo(map);
    map.fitBounds(layer.getBounds(), { padding: [24, 24], maxZoom: 15 });
    map.on('click', () => { map.dragging.enable(); el.classList.add('active'); });
    document.addEventListener('click', e => {
      if (!el.contains(e.target)) { map.dragging.disable(); el.classList.remove('active'); }
    });
  }
}
marked.use({ gfm: true, renderer });

function askForToken(problem = '') {
  doc.innerHTML = `
    <p>${problem} Paste your access token. Ask Stefan if you don't have one.</p>
    <form id="token-form"><input name="t" placeholder="github_pat_..." autocomplete="off"> <button>Save</button></form>`;
  doc.querySelector('#token-form').onsubmit = async e => {
    e.preventDefault();
    await put('kv', 'token', e.target.t.value.trim());
    location.reload();
  };
}

// A folder shows its README.md like GitHub does, else a list of what it holds.
async function load(path) {
  if (!path.endsWith('/')) return (await get('files', path))?.text;
  const readme = await get('files', `${path}README.md`);
  if (readme) return readme.text;
  const entries = new Set((await allKeys('files'))
    .filter(p => p.startsWith(path))
    .map(p => p.slice(path.length).replace(/\/.*/, '/')));
  if (!entries.size) return undefined;
  return `# ${path.split('/').at(-2)}\n\n${[...entries].sort().map(e => `- [${e.replace(/\.md$/, '')}](<${e}>)`).join('\n')}`;
}

async function render(path) {
  const text = await load(path);
  if (text === undefined) return false;
  doc.innerHTML = marked.parse(text);
  addHeadingIds(doc);
  rewriteLinks(doc, path);
  drawMaps(doc);
  document.title = doc.querySelector('h1')?.textContent ?? path;
  put('kv', 'lastPage', path);
  if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  return true;
}

function showBanner(text, onClick) {
  banner.textContent = text;
  banner.hidden = false;
  banner.onclick = onClick;
}

async function showLastSync() {
  const t = await get('kv', 'lastSync');
  status.textContent = t ? `Synced ${new Date(t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : '';
}

let syncing = false;
async function backgroundSync(token) {
  if (syncing) return;
  syncing = true;
  status.textContent = 'Checking…';
  try {
    if (await sync(token)) showBanner('Updated. Tap to reload.', () => location.reload());
  } catch (e) {
    if (e instanceof AuthError) showBanner(`${e.message} Tap to enter a new token.`, () => { banner.hidden = true; askForToken(); });
  } finally {
    syncing = false;
    await showLastSync();
  }
}

async function showPin(path) {
  const isStart = await get('kv', 'startPage') === path;
  pin.textContent = isStart ? '★ Start page' : '☆ Set as start page';
  pin.hidden = false;
  pin.onclick = async () => {
    await (isStart ? del('kv', 'startPage') : put('kv', 'startPage', path));
    showPin(path);
  };
}

async function main() {
  if (IN_APP_BROWSER) showBanner('To install the app: tap ⋯ at the top right, then "Open in browser".');
  const token = await readToken();
  if (!token) return askForToken();
  // The home-screen icon launches with no ?p: open the chosen start page, else the last page read.
  const path = new URLSearchParams(location.search).get('p')
    || await get('kv', 'startPage') || await get('kv', 'lastPage') || HOME;
  showPin(path);
  navigator.storage?.persist?.();

  if (await render(path)) {
    await showLastSync();
    const last = await get('kv', 'lastSync') ?? 0;
    if (Date.now() - last > SYNC_EVERY_MS) backgroundSync(token);
  } else {
    // First run, or a page that isn't stored yet: download before rendering.
    try {
      await sync(token, (n, total) => { status.textContent = `Downloading ${n}/${total}`; });
      await showLastSync();
      if (!(await render(path))) doc.textContent = `${path} is not in the trip repo.`;
    } catch (e) {
      status.textContent = '';
      if (e instanceof AuthError) askForToken(e.message);
      else doc.textContent = `Could not download the trip docs: ${e.message}`;
    }
  }

  status.onclick = () => backgroundSync(token);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const last = await get('kv', 'lastSync') ?? 0;
    if (Date.now() - last > SYNC_EVERY_MS) backgroundSync(token);
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
main();
