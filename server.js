'use strict';

const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 10000;
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'https://catch-the-booster-390255.onrender.com')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const MAX_SCORE = 4000;
const NAME_MAX = 16;
const TOP_N = 25;
const POST_WINDOW_MS = 10 * 60 * 1000;
const POST_MAX = 8;
const GET_WINDOW_MS = 60 * 1000;
const GET_MAX = 60;

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const OUTCOMES = new Set(['PERFECT', 'CAUGHT', 'DIVERT', 'RUD']);

// Short display-name filter only. Not a full moderation system.
const BLOCKED = /\b(fuck|shit|asshole|bitch|cunt|nigger|nigga|faggot|retard|rape|rapist|slut|whore|kike|spic|chink|tranny|porn|nazi|hitler)\b/i;

function utcMonth(d = new Date()) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
function seasonName(month = utcMonth()) {
  const [y, m] = month.split('-').map(Number);
  return MONTHS[m - 1] + ' ' + y + ' season';
}

function sanitizeName(raw) {
  let s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > NAME_MAX) s = s.slice(0, NAME_MAX).trim();
  if (!s) return { error: 'Name is required.' };
  if (!/^[\p{L}\p{N} .'_-]+$/u.test(s)) return { error: 'Name can only use letters, numbers, spaces, and .\'-_ ' };
  if (BLOCKED.test(s)) return { error: 'Please pick a different name.' };
  return { name: s };
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

const postHits = new Map();
const getHits = new Map();
function limited(map, ip, windowMs, max) {
  const now = Date.now();
  let arr = (map.get(ip) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { map.set(ip, arr); return true; }
  arr.push(now);
  map.set(ip, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of postHits) {
    const keep = arr.filter(t => now - t < POST_WINDOW_MS);
    if (keep.length) postHits.set(ip, keep); else postHits.delete(ip);
  }
  for (const [ip, arr] of getHits) {
    const keep = arr.filter(t => now - t < GET_WINDOW_MS);
    if (keep.length) getHits.set(ip, keep); else getHits.delete(ip);
  }
}, 60 * 1000).unref();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 8000,
  ssl: process.env.DATABASE_URL && /render\.com/i.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined
});

let ready = null;
async function ensureSchema() {
  if (ready) return ready;
  ready = pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      score INTEGER NOT NULL,
      acc INTEGER,
      outcome TEXT NOT NULL,
      mission TEXT NOT NULL,
      played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      month CHAR(7) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scores_month_score ON scores (month, score DESC, played_at DESC);
  `).then(() => true).catch(err => { ready = null; throw err; });
  return ready;
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(fs.readFileSync(path.join(__dirname, 'robots.txt'), 'utf8'));
});

app.get(['/', '/health'], async (_req, res) => {
  try {
    if (!process.env.DATABASE_URL) return res.status(503).json({ ok: false });
    await ensureSchema();
    res.json({ ok: true, season: seasonName() });
  } catch (e) {
    res.status(503).json({ ok: false });
  }
});

app.get('/scores', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (limited(getHits, ip, GET_WINDOW_MS, GET_MAX)) {
    return res.status(429).json({ error: 'Too many requests. Try again in a moment.' });
  }
  try {
    await ensureSchema();
    const month = utcMonth();
    const { rows } = await pool.query(
      `SELECT id, name, score, acc, outcome, mission, played_at
         FROM scores
        WHERE month = $1
        ORDER BY score DESC, played_at ASC
        LIMIT $2`,
      [month, TOP_N]
    );
    res.json({
      season: seasonName(month),
      month,
      scores: rows.map(r => ({
        id: r.id,
        name: r.name,
        score: r.score,
        acc: r.acc,
        outcome: r.outcome,
        mission: r.mission,
        date: r.played_at.toISOString().slice(0, 10)
      }))
    });
  } catch (e) {
    console.error('GET /scores', e.message);
    res.status(503).json({ error: 'Leaderboard is waking up. Try again in a moment.' });
  }
});

app.post('/scores', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (limited(postHits, ip, POST_WINDOW_MS, POST_MAX)) {
    return res.status(429).json({ error: 'Too many scores from this network. Try again later.' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const named = sanitizeName(body.name);
  if (named.error) return res.status(400).json({ error: named.error });
  const score = clampInt(body.score, 0, MAX_SCORE);
  if (score == null) return res.status(400).json({ error: 'Score is required.' });
  let acc = body.acc == null || body.acc === '' ? null : clampInt(body.acc, 0, 100);
  const outcome = String(body.outcome || '').toUpperCase();
  if (!OUTCOMES.has(outcome)) return res.status(400).json({ error: 'Unknown outcome.' });
  const mission = String(body.mission || 'FLIGHT')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32) || 'FLIGHT';
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const month = utcMonth();
  try {
    await ensureSchema();
    await pool.query(
      `INSERT INTO scores (id, name, score, acc, outcome, mission, played_at, month)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)`,
      [id, named.name, score, acc, outcome, mission, month]
    );
    res.status(201).json({ ok: true, id, season: seasonName(month), month });
  } catch (e) {
    console.error('POST /scores', e.message);
    res.status(503).json({ error: 'Could not save that score right now.' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('chopsticks-leaderboard listening on ' + PORT + ' · ' + seasonName());
  if (process.env.DATABASE_URL) ensureSchema().catch(err => console.error('schema', err.message));
});
