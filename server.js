// Archive Viewer server (zero dependencies — uses only Node's built-in http module)
//
// Serves the frontend, exposes the archive index as JSON, and streams
// images straight from a folder on disk — no browser file pickers,
// no permission prompts, no re-selecting anything on refresh.
//
// Configure via environment variables (or just edit the defaults below):
//   DATA_FILE  - path to your data.json index file
//   IMAGES_DIR - path to the folder containing the PNGs (searched recursively)
//   PORT       - port to listen on (default 3000)
//
// Run:
//   node server.js
//   DATA_FILE=/path/to/data.json IMAGES_DIR=/path/to/images node server.js

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { URL } = require('url');
const { exec, spawn } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(__dirname, 'data.json'));
const NOTES_FILE = path.join(path.dirname(DATA_FILE), 'notes.md');
const IMAGES_DIR = path.resolve(process.env.IMAGES_DIR || path.join(__dirname, 'images'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// ---------------------------------------------------------------------
// In-memory index of filename -> absolute path, built by scanning
// IMAGES_DIR recursively. Rebuilt on startup and via POST /api/rescan,
// so new images can be dropped in without restarting the server.
// ---------------------------------------------------------------------
let imageIndex = new Map();

async function buildImageIndex(dir, into) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`Could not read images directory "${dir}": ${err.message}`);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await buildImageIndex(full, into);
    } else if (entry.isFile() && /\.png$/i.test(entry.name)) {
      into.set(entry.name, full);
    }
  }
}

async function rescanImages() {
  const fresh = new Map();
  await buildImageIndex(IMAGES_DIR, fresh);
  imageIndex = fresh;
  return imageIndex.size;
}

// ---------------------------------------------------------------------
// data.json read/write helpers
// ---------------------------------------------------------------------
async function readArchive() {
  const text = await fsp.readFile(DATA_FILE, 'utf8');
  const parsed = JSON.parse(text);
  if (!parsed.files || !Array.isArray(parsed.files)) {
    throw new Error("data.json is missing a top-level 'files' array");
  }
  if (!Array.isArray(parsed.tags)) {
    // Migrate: build initial tag list from tags currently in use.
    const set = new Set();
    parsed.files.forEach(g => (g.tags || []).forEach(t => set.add(t)));
    parsed.tags = Array.from(set).sort((a, b) => a.localeCompare(b));
  }
  return parsed;
}

async function writeArchive(data) {
  const tmp = DATA_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, DATA_FILE);
}

// ---------------------------------------------------------------------
// Server-side application settings (stored in the repo, not in DATA_FILE)
// ---------------------------------------------------------------------
async function readSettings() {
  try {
    const text = await fsp.readFile(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(text);
    if (!['off', 'restart'].includes(parsed.autoUpdate)) parsed.autoUpdate = 'off';
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return { autoUpdate: 'off' };
    throw err;
  }
}

async function writeSettings(settings) {
  const tmp = SETTINGS_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
  await fsp.rename(tmp, SETTINGS_FILE);
}

// ---------------------------------------------------------------------
// Git helpers for checking / pulling application updates
// ---------------------------------------------------------------------
async function gitFetch() {
  await execAsync('git fetch', { cwd: __dirname });
}

async function gitCurrentCommit() {
  const { stdout } = await execAsync('git rev-parse HEAD', { cwd: __dirname });
  return stdout.trim();
}

async function gitUpstreamCommit() {
  try {
    const { stdout } = await execAsync('git rev-parse @{upstream}', { cwd: __dirname });
    return stdout.trim();
  } catch (err) {
    const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: __dirname });
    const { stdout } = await execAsync(`git rev-parse origin/${branch.trim()}`, { cwd: __dirname });
    return stdout.trim();
  }
}

async function gitLogPending() {
  try {
    const { stdout } = await execAsync('git log HEAD..@{upstream} --oneline', { cwd: __dirname });
    return parseGitLog(stdout);
  } catch (err) {
    const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: __dirname });
    const { stdout } = await execAsync(`git log HEAD..origin/${branch.trim()} --oneline`, { cwd: __dirname });
    return parseGitLog(stdout);
  }
}

function parseGitLog(stdout) {
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const hash = line.split(' ')[0];
    const message = line.slice(hash.length).trim();
    return { hash, message };
  });
}

async function gitCheckUpdate() {
  await gitFetch();
  const localCommit = await gitCurrentCommit();
  const remoteCommit = await gitUpstreamCommit();
  // An update is only available when the remote is strictly ahead of local.
  // Using the commit log count avoids false positives when local has unpushed
  // commits (in which case HEAD..upstream is empty).
  const commits = await gitLogPending();
  return {
    needsUpdate: commits.length > 0,
    localCommit,
    remoteCommit,
    commits
  };
}

async function gitPull() {
  const { stdout, stderr } = await execAsync('git pull', { cwd: __dirname });
  return { output: (stdout + stderr).trim() };
}

async function applyAutoUpdate() {
  try {
    const settings = await readSettings();
    if (settings.autoUpdate !== 'restart') return;
    const status = await gitCheckUpdate();
    if (status.needsUpdate) {
      console.log(`Update available (${status.localCommit.slice(0, 7)} -> ${status.remoteCommit.slice(0, 7)}). Pulling...`);
      const pull = await gitPull();
      console.log('Pulled update.' + (pull.output ? '\n' + pull.output : ''));
      console.log('Restarting server to run the update...');
      restartServerProcess();
      process.exit(0);
    } else {
      console.log('No application update available.');
    }
  } catch (err) {
    console.error('Auto-update failed:', err.message);
  }
}

function restartServerProcess() {
  const child = spawn(process.argv[0], process.argv.slice(1), {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
    env: process.env
  });
  child.unref();
}

// ---------------------------------------------------------------------
// Tiny helpers for a dependency-free HTTP server
// ---------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { // 5MB body cap
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('Invalid JSON body: ' + err.message));
      }
    });
    req.on('error', reject);
  });
}

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  // Prevent escaping the public directory.
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache' // always revalidate, so frontend edits show up on a normal refresh
    });
    fs.createReadStream(full).pipe(res);
  });
}

function serveImage(req, res, filename) {
  const full = imageIndex.get(filename);
  if (!full) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Image not found: ' + filename);
  }
  fs.stat(full, (err, stat) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Image not found on disk: ' + filename);
    }
    // ETag derived from size + mtime, so editing/replacing a file that keeps
    // the same filename is detected immediately — no more stale images after
    // a rescan or restart, and no need to disable the browser cache.
    const etag = '"' + stat.size.toString(36) + '-' + stat.mtimeMs.toString(36) + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache', // always revalidate with the server before reusing a cached copy
      'ETag': etag,
      'Last-Modified': stat.mtime.toUTCString()
    });
    fs.createReadStream(full).pipe(res);
  });
}

// ---------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(parsed.pathname);

  try {
    // GET /api/data — full archive index
    if (req.method === 'GET' && pathname === '/api/data') {
      const data = await readArchive();
      return sendJson(res, 200, data);
    }

    // GET /api/settings — server-side application settings
    if (req.method === 'GET' && pathname === '/api/settings') {
      const settings = await readSettings();
      return sendJson(res, 200, settings);
    }

    // POST /api/settings — update server-side application settings
    if (req.method === 'POST' && pathname === '/api/settings') {
      const body = await readBody(req);
      const current = await readSettings();
      const updated = { ...current };
      if (['off', 'restart'].includes(body.autoUpdate)) {
        updated.autoUpdate = body.autoUpdate;
      }
      await writeSettings(updated);
      return sendJson(res, 200, updated);
    }

    // GET /api/update/status — check whether a git update is available
    if (req.method === 'GET' && pathname === '/api/update/status') {
      try {
        const status = await gitCheckUpdate();
        return sendJson(res, 200, status);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // POST /api/update/now — pull the latest application code from git and restart
    if (req.method === 'POST' && pathname === '/api/update/now') {
      try {
        const status = await gitCheckUpdate();
        if (!status.needsUpdate) {
          return sendJson(res, 200, { updated: false, message: 'Already up to date', ...status });
        }
        const pull = await gitPull();
        restartServerProcess();
        sendJson(res, 200, { updated: true, message: 'Updated and restarting server.', output: pull.output });
        // Allow the response to flush before exiting.
        setTimeout(() => process.exit(0), 200);
        return;
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /images/:filename
    if (req.method === 'GET' && pathname.startsWith('/images/')) {
      const filename = pathname.slice('/images/'.length);
      return serveImage(req, res, filename);
    }

    // GET /api/images — every image filename currently indexed on disk
    if (req.method === 'GET' && pathname === '/api/images') {
      const files = Array.from(imageIndex.keys()).sort((a, b) => a.localeCompare(b));
      return sendJson(res, 200, { files });
    }

    // GET /api/ungrouped — images found on disk that aren't referenced by any
    // group yet, either as content (`files`) or as a news clipping (`news`).
    // Files whose names explicitly contain "news" are treated as news clippings
    // even before they are assigned to a group, so they stay out of this grid.
    if (req.method === 'GET' && pathname === '/api/ungrouped') {
      const data = await readArchive();
      const referenced = new Set();
      data.files.forEach(g => {
        (g.files || []).forEach(f => referenced.add(f));
        if (g.news) referenced.add(g.news);
      });
      const ungrouped = Array.from(imageIndex.keys())
        .filter(f => !referenced.has(f) && !/news/i.test(f))
        .sort((a, b) => a.localeCompare(b));
      return sendJson(res, 200, { files: ungrouped });
    }

    // POST /api/rescan — re-index the images directory
    if (req.method === 'POST' && pathname === '/api/rescan') {
      const count = await rescanImages();
      return sendJson(res, 200, { imageCount: count });
    }

    // POST /api/images/delete — delete image files from disk
    if (req.method === 'POST' && pathname === '/api/images/delete') {
      const body = await readBody(req);
      const toDelete = Array.isArray(body.files) ? body.files : [];
      if (toDelete.length === 0) {
        return sendJson(res, 400, { error: '"files" must be a non-empty array' });
      }
      const data = await readArchive();
      const referenced = new Set();
      data.files.forEach(g => {
        (g.files || []).forEach(f => referenced.add(f));
        if (g.news) referenced.add(g.news);
      });
      const inUse = toDelete.filter(f => referenced.has(f));
      if (inUse.length) {
        return sendJson(res, 409, { error: 'Still referenced in archive: ' + inUse.join(', ') });
      }
      const results = [];
      for (const fn of toDelete) {
        const full = imageIndex.get(fn);
        if (!full) {
          results.push({ file: fn, ok: false, error: 'Image not indexed' });
          continue;
        }
        try {
          await fsp.unlink(full);
          imageIndex.delete(fn);
          results.push({ file: fn, ok: true });
        } catch (err) {
          results.push({ file: fn, ok: false, error: err.message });
        }
      }
      return sendJson(res, 200, { deleted: results });
    }

    // POST /api/groups — add a new group entry
    if (req.method === 'POST' && pathname === '/api/groups') {
      const body = await readBody(req);
      const { files, tags, youtubes, news } = body;
      if (!Array.isArray(files) || files.length === 0) {
        return sendJson(res, 400, { error: '"files" must be a non-empty array' });
      }
      const data = await readArchive();
      const existing = new Set();
      data.files.forEach(g => (g.files || []).forEach(f => existing.add(f)));
      const dupes = files.filter(f => existing.has(f));
      if (dupes.length) {
        return sendJson(res, 409, { error: 'Already in another group: ' + dupes.join(', ') });
      }
      data.files.push({
        files,
        tags: Array.isArray(tags) ? tags : [],
        youtubes: Array.isArray(youtubes) ? youtubes : [],
        news: typeof news === 'string' ? news : ''
      });
      await writeArchive(data);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/groups/:filename/tags — add/remove tags on the group containing :filename
    const tagMatch = pathname.match(/^\/api\/groups\/([^/]+)\/tags$/);
    if (req.method === 'POST' && tagMatch) {
      const filename = decodeURIComponent(tagMatch[1]);
      const body = await readBody(req);
      const add = Array.isArray(body.add) ? body.add : [];
      const remove = Array.isArray(body.remove) ? body.remove : [];
      const data = await readArchive();
      const group = data.files.find(g => (g.files || []).includes(filename));
      if (!group) {
        return sendJson(res, 404, { error: 'No group contains file: ' + filename });
      }
      let tags = new Set(group.tags || []);
      add.forEach(t => tags.add(t));
      remove.forEach(t => tags.delete(t));
      group.tags = Array.from(tags);
      const known = new Set(data.tags || []);
      add.forEach(t => known.add(t));
      data.tags = Array.from(known).sort((a, b) => a.localeCompare(b));
      await writeArchive(data);
      return sendJson(res, 200, { tags: group.tags, allTags: data.tags });
    }

    // GET /api/tags — persisted tag list
    if (req.method === 'GET' && pathname === '/api/tags') {
      const data = await readArchive();
      return sendJson(res, 200, { tags: data.tags || [] });
    }

    // DELETE /api/tags/:tag — remove tag from the persisted list and strip it from every group
    const deleteTagMatch = pathname.match(/^\/api\/tags\/(.+)$/);
    if (req.method === 'DELETE' && deleteTagMatch) {
      const tag = decodeURIComponent(deleteTagMatch[1]);
      const data = await readArchive();
      const known = new Set(data.tags || []);
      if (!known.has(tag)) {
        return sendJson(res, 404, { error: 'Tag not found: ' + tag });
      }
      known.delete(tag);
      data.tags = Array.from(known).sort((a, b) => a.localeCompare(b));
      data.files.forEach(g => {
        if (g.tags) g.tags = g.tags.filter(t => t !== tag);
      });
      await writeArchive(data);
      return sendJson(res, 200, { tags: data.tags });
    }

    // GET /api/notes — free-form markdown notes (stored next to data.json)
    if (req.method === 'GET' && pathname === '/api/notes') {
      let text = '';
      try {
        text = await fsp.readFile(NOTES_FILE, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      return sendJson(res, 200, { notes: text });
    }

    // POST /api/notes — save free-form markdown notes
    if (req.method === 'POST' && pathname === '/api/notes') {
      const body = await readBody(req);
      const text = typeof body.notes === 'string' ? body.notes : '';
      const tmp = NOTES_FILE + '.tmp';
      await fsp.writeFile(tmp, text, 'utf8');
      await fsp.rename(tmp, NOTES_FILE);
      return sendJson(res, 200, { notes: text });
    }

    // POST /api/groups/:filename/youtubes — add/remove video links on the group containing :filename
    const ytMatch = pathname.match(/^\/api\/groups\/([^/]+)\/youtubes$/);
    if (req.method === 'POST' && ytMatch) {
      const filename = decodeURIComponent(ytMatch[1]);
      const body = await readBody(req);
      const add = Array.isArray(body.add) ? body.add : [];
      const remove = Array.isArray(body.remove) ? body.remove : [];
      const data = await readArchive();
      const group = data.files.find(g => (g.files || []).includes(filename));
      if (!group) {
        return sendJson(res, 404, { error: 'No group contains file: ' + filename });
      }
      let list = (group.youtubes || []).filter(u => !remove.includes(u));
      add.forEach(u => { if (u && !list.includes(u)) list.push(u); });
      group.youtubes = list;
      await writeArchive(data);
      return sendJson(res, 200, { youtubes: group.youtubes });
    }

    // POST /api/groups/:filename/news — set (or clear with "") the news field on the group containing :filename
    const newsMatch = pathname.match(/^\/api\/groups\/([^/]+)\/news$/);
    if (req.method === 'POST' && newsMatch) {
      const filename = decodeURIComponent(newsMatch[1]);
      const body = await readBody(req);
      const value = typeof body.value === 'string' ? body.value : '';
      const data = await readArchive();
      const group = data.files.find(g => (g.files || []).includes(filename));
      if (!group) {
        return sendJson(res, 404, { error: 'No group contains file: ' + filename });
      }
      group.news = value;
      await writeArchive(data);
      return sendJson(res, 200, { news: group.news });
    }

    // POST /api/groups/:filename/files/remove — remove one or more images from the group
    const removeMatch = pathname.match(/^\/api\/groups\/([^/]+)\/files\/remove$/);
    if (req.method === 'POST' && removeMatch) {
      const filename = decodeURIComponent(removeMatch[1]);
      const body = await readBody(req);
      const toRemove = Array.isArray(body.files) ? body.files : [];
      if (toRemove.length === 0) {
        return sendJson(res, 400, { error: '"files" must be a non-empty array' });
      }
      const data = await readArchive();
      const idx = data.files.findIndex(g => (g.files || []).includes(filename));
      if (idx === -1) {
        return sendJson(res, 404, { error: 'No group contains file: ' + filename });
      }
      const group = data.files[idx];
      const before = group.files || [];
      const after = before.filter(f => !toRemove.includes(f));
      const removed = before.filter(f => toRemove.includes(f));
      if (removed.length === 0) {
        return sendJson(res, 400, { error: 'Specified file(s) are not in this group' });
      }
      if (after.length === 0) {
        // Last image removed — delete the whole group.
        data.files.splice(idx, 1);
      } else {
        group.files = after;
      }
      await writeArchive(data);
      return sendJson(res, 200, { files: after });
    }

    // POST /api/groups/:filename/files/add — add one or more images to an existing group
    const addMatch = pathname.match(/^\/api\/groups\/([^/]+)\/files\/add$/);
    if (req.method === 'POST' && addMatch) {
      const filename = decodeURIComponent(addMatch[1]);
      const body = await readBody(req);
      const toAdd = Array.isArray(body.files) ? body.files : [];
      if (toAdd.length === 0) {
        return sendJson(res, 400, { error: '"files" must be a non-empty array' });
      }
      const data = await readArchive();
      const group = data.files.find(g => (g.files || []).includes(filename));
      if (!group) {
        return sendJson(res, 404, { error: 'No group contains file: ' + filename });
      }
      const existing = new Set();
      data.files.forEach(g => {
        if (g === group) return;
        (g.files || []).forEach(f => existing.add(f));
      });
      const dupes = toAdd.filter(f => existing.has(f));
      if (dupes.length) {
        return sendJson(res, 409, { error: 'Already in another group: ' + dupes.join(', ') });
      }
      const current = new Set(group.files || []);
      const newFiles = toAdd.filter(f => !current.has(f));
      if (newFiles.length === 0) {
        return sendJson(res, 400, { error: 'Specified file(s) are already in this group' });
      }
      const list = group.files || [];
      const at = Number(body.at);
      if (Number.isInteger(at) && at >= 0 && at <= list.length) {
        list.splice(at, 0, ...newFiles);
      } else {
        list.push(...newFiles);
      }
      group.files = list;
      await writeArchive(data);
      return sendJson(res, 200, { files: group.files });
    }

    // POST /api/groups/:filename/delete — delete the whole group and its image files,
    // but keep the news clipping file if there is one.
    const deleteGroupMatch = pathname.match(/^\/api\/groups\/([^/]+)\/delete$/);
    if (req.method === 'POST' && deleteGroupMatch) {
      const filename = decodeURIComponent(deleteGroupMatch[1]);
      const data = await readArchive();
      const idx = data.files.findIndex(g => (g.files || []).includes(filename));
      if (idx === -1) {
        return sendJson(res, 404, { error: 'No group contains file: ' + filename });
      }
      const group = data.files[idx];
      const keep = new Set();
      if (group.news) keep.add(group.news);
      const toDelete = (group.files || []).filter(f => !keep.has(f));
      for (const fn of toDelete) {
        const full = imageIndex.get(fn);
        if (full) {
          try { await fsp.unlink(full); } catch (err) { /* ignore */ }
          imageIndex.delete(fn);
        }
      }
      data.files.splice(idx, 1);
      await writeArchive(data);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/groups/:filename/move — move a group one position up or down
    const moveMatch = pathname.match(/^\/api\/groups\/([^/]+)\/move$/);
    if (req.method === 'POST' && moveMatch) {
      const filename = decodeURIComponent(moveMatch[1]);
      const body = await readBody(req);
      const data = await readArchive();
      const idx = data.files.findIndex(g => (g.files || []).includes(filename));
      if (idx === -1) {
        return sendJson(res, 404, { error: 'No group contains file: ' + filename });
      }
      const direction = body.direction;
      if (direction === 'up' && idx > 0) {
        [data.files[idx - 1], data.files[idx]] = [data.files[idx], data.files[idx - 1]];
      } else if (direction === 'down' && idx < data.files.length - 1) {
        [data.files[idx], data.files[idx + 1]] = [data.files[idx + 1], data.files[idx]];
      } else {
        return sendJson(res, 400, { error: 'Cannot move ' + direction + ' from position ' + idx });
      }
      await writeArchive(data);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/groups/reorder — move a source group before or after a target group
    if (req.method === 'POST' && pathname === '/api/groups/reorder') {
      const body = await readBody(req);
      const sourceFn = body.source;
      const targetFn = body.target;
      const position = body.position; // 'before' or 'after'
      if (!sourceFn || !targetFn || !['before', 'after'].includes(position)) {
        return sendJson(res, 400, { error: 'source, target and position (before/after) are required' });
      }
      const data = await readArchive();
      const sourceIdx = data.files.findIndex(g => (g.files || []).includes(sourceFn));
      const targetIdx = data.files.findIndex(g => (g.files || []).includes(targetFn));
      if (sourceIdx === -1 || targetIdx === -1) {
        return sendJson(res, 404, { error: 'Group not found' });
      }
      if (sourceIdx !== targetIdx) {
        const [moved] = data.files.splice(sourceIdx, 1);
        let insertIdx = data.files.findIndex(g => (g.files || []).includes(targetFn));
        if (position === 'after') insertIdx++;
        data.files.splice(insertIdx, 0, moved);
      }
      await writeArchive(data);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/groups/:filename/files/reorder — replace the group's file order
    const reorderFilesMatch = pathname.match(/^\/api\/groups\/([^/]+)\/files\/reorder$/);
    if (req.method === 'POST' && reorderFilesMatch) {
      const filename = decodeURIComponent(reorderFilesMatch[1]);
      const body = await readBody(req);
      const newFiles = Array.isArray(body.files) ? body.files : [];
      const data = await readArchive();
      const group = data.files.find(g => (g.files || []).includes(filename));
      if (!group) {
        return sendJson(res, 404, { error: 'No group contains file: ' + filename });
      }
      const current = group.files || [];
      if (newFiles.length !== current.length || !newFiles.every(f => current.includes(f))) {
        return sendJson(res, 400, { error: 'New order must contain exactly the same files' });
      }
      group.files = newFiles;
      await writeArchive(data);
      return sendJson(res, 200, { files: group.files });
    }

    // Fall through to static file serving (frontend)
    if (req.method === 'GET') {
      return serveStatic(req, res, pathname);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

async function startServer() {
  await applyAutoUpdate();
  const count = await rescanImages();
  server.listen(PORT, () => {
    console.log(`Archive Viewer running at http://localhost:${PORT}`);
    console.log(`  data file:   ${DATA_FILE}`);
    console.log(`  images dir:  ${IMAGES_DIR}  (${count} PNGs found)`);
  });
}

startServer();
