const REPO = 'StefanPanait/TripPlanning';
const API = `https://api.github.com/repos/${REPO}`;
const HOME = 'README.md';

const doc = document.getElementById('doc');
const status = document.getElementById('status');

// Key-value store in IndexedDB rather than localStorage, so the service worker can read the token too.
function store(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('trips', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = fn(open.result.transaction('kv', mode).objectStore('kv'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}
const get = key => store('readonly', s => s.get(key));
const set = (key, val) => store('readwrite', s => s.put(val, key));

async function readToken() {
  const m = location.hash.match(/^#token=(github_pat_\w+)$/);
  if (m) {
    await set('token', m[1]);
    history.replaceState(null, '', location.pathname + location.search);
  }
  return get('token');
}

async function fetchFile(path, token) {
  const r = await fetch(`${API}/contents/${encodeURI(path)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw' },
  });
  if (r.status === 401) throw new Error('Access expired. Ask Stefan for a new link.');
  if (!r.ok) throw new Error(`GitHub returned ${r.status} for ${path}`);
  return r.text();
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
    a.href = target.endsWith('.md')
      ? `?p=${encodeURIComponent(target)}${url.hash}`
      : `https://github.com/${REPO}/blob/main/${target}${url.hash}`;
  }
}

const renderer = {
  code({ text, lang }) {
    if (lang !== 'geojson') return false;
    const pre = document.createElement('pre');
    pre.textContent = text;
    return `<details><summary>Map data</summary>${pre.outerHTML}</details>`;
  },
};
marked.use({ gfm: true, renderer });

function askForToken() {
  doc.innerHTML = `
    <p>No access token on this device. Open the link you were sent, or paste the token here.</p>
    <form id="token-form"><input name="t" placeholder="github_pat_..." autocomplete="off"> <button>Save</button></form>`;
  doc.querySelector('#token-form').onsubmit = async e => {
    e.preventDefault();
    await set('token', e.target.t.value.trim());
    location.reload();
  };
}

async function main() {
  const path = new URLSearchParams(location.search).get('p') || HOME;
  const token = await readToken();
  if (!token) return askForToken();
  status.textContent = 'Loading…';
  try {
    doc.innerHTML = marked.parse(await fetchFile(path, token));
    addHeadingIds(doc);
    rewriteLinks(doc, path);
    document.title = doc.querySelector('h1')?.textContent ?? path;
    status.textContent = '';
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  } catch (e) {
    status.textContent = '';
    doc.textContent = e.message;
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
main();
