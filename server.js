'use strict';

const express  = require('express');
const http     = require('http');
const { WebSocketServer } = require('ws');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ── helpers ── */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function profilePath(name) {
  return path.join(__dirname, 'profiles', `${name.replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

/* ── in-memory gaze state ── */
const sessions         = new Map();
const disconnectTimers = new Map();

function broadcastSessions() {
  const msg = JSON.stringify({ type: 'sessions', data: Object.fromEntries(sessions) });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

/* ── WebSocket ── */
wss.on('connection', ws => {
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'gaze' && typeof msg.name === 'string' && msg.name) {
        ws.username = msg.name;
        if (disconnectTimers.has(msg.name)) {
          clearTimeout(disconnectTimers.get(msg.name));
          disconnectTimers.delete(msg.name);
        }
        sessions.set(msg.name, {
          x:               +msg.x || 0,
          y:               +msg.y || 0,
          ts:              Date.now(),
          fixationCount:   msg.fixationCount  || 0,
          saccadeCount:    msg.saccadeCount   || 0,
          firstFixTs:      msg.firstFixTs     || null,
          sessionDuration: msg.sessionDuration || 0
        });
        broadcastSessions();
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    const name = ws.username;
    if (!name) return;
    const timer = setTimeout(() => {
      sessions.delete(name);
      disconnectTimers.delete(name);
      broadcastSessions();
    }, 5000);
    disconnectTimers.set(name, timer);
  });

  ws.send(JSON.stringify({ type: 'sessions', data: Object.fromEntries(sessions) }));
});

/* ══════════════════════════════════════════════════════════════════════
   PROFILE ENDPOINTS
   ══════════════════════════════════════════════════════════════════════ */

/* GET /api/profile/:name — load a profile */
app.get('/api/profile/:name', (req, res) => {
  try {
    const fp = profilePath(req.params.name);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'profile not found' });
    const profile = JSON.parse(fs.readFileSync(fp, 'utf8'));
    res.json(profile);
  } catch (e) {
    console.error('[profile:get]', e);
    res.status(500).json({ error: 'read failed' });
  }
});

/* GET /api/profiles — list all profiles (summary only) */
app.get('/api/profiles', (_req, res) => {
  try {
    const dir = path.join(__dirname, 'profiles');
    ensureDir(dir);
    const profiles = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return {
            name:         p.name,
            age:          p.age,
            gender:       p.gender,
            location:     p.location,
            sessionCount: (p.sessions || []).length,
            lastSeen:     p.lastSeen || null,
            createdAt:    p.createdAt || null
          };
        } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    res.json(profiles);
  } catch (e) {
    console.error('[profiles]', e);
    res.status(500).json({ error: 'read failed' });
  }
});

/* POST /api/profile — create or update a profile, append session */
app.post('/api/profile', (req, res) => {
  try {
    const { name, age, gender, location, session } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const dir = path.join(__dirname, 'profiles');
    ensureDir(dir);
    const fp = profilePath(name);

    // load existing or create new
    let profile = fs.existsSync(fp)
      ? JSON.parse(fs.readFileSync(fp, 'utf8'))
      : { name, age, gender, location, createdAt: Date.now(), sessions: [] };

    // update base info
    profile.name     = name;
    profile.age      = age     ?? profile.age;
    profile.gender   = gender  ?? profile.gender;
    profile.location = location ?? profile.location;
    profile.lastSeen = Date.now();

    // append session if provided (strip heavy image data to save space)
    if (session) {
      const slim = {
        timestamp:       session.timestamp      || Date.now(),
        imageName:       session.imageName      || 'unknown',
        sessionDuration: session.sessionDuration || 0,
        fixationCount:   (session.fixationHistory  || []).length,
        saccadeCount:    (session.saccadeHistory   || []).length,
        sampleCount:     (session.gazeLog          || []).length,
        avgFixDur:       session.fixationHistory?.length
          ? Math.round(session.fixationHistory.reduce((s, f) => s + f.duration, 0) / session.fixationHistory.length)
          : 0,
        sacAmplitude:    session.saccadeHistory?.length
          ? +(session.saccadeHistory.reduce((s, f) => s + Math.hypot(f.toX - f.fromX, f.toY - f.fromY), 0)
              / session.saccadeHistory.length * 100).toFixed(1)
          : 0,
        ttff: session.firstFix
          ? +((session.firstFix.startTs - session.firstFixModeTs) / 1000).toFixed(2)
          : null,
        firstFix:        session.firstFix        || null,
        scanPathSteps:   (session.scanPathHistory || []).length,
        // keep full gaze/fixation arrays for replay (optional — comment out to save space)
        gazeLog:         session.gazeLog          || [],
        fixationHistory: session.fixationHistory  || [],
        saccadeHistory:  session.saccadeHistory   || [],
        scanPathHistory: session.scanPathHistory  || [],
        firstFixModeTs:  session.firstFixModeTs   || 0
      };
      profile.sessions.push(slim);
    }

    fs.writeFileSync(fp, JSON.stringify(profile, null, 2));
    res.json({ ok: true, sessionCount: profile.sessions.length });
  } catch (e) {
    console.error('[profile:post]', e);
    res.status(500).json({ error: 'write failed' });
  }
});

/* DELETE /api/profile/:name — delete a profile */
app.delete('/api/profile/:name', (req, res) => {
  try {
    const fp = profilePath(req.params.name);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
    fs.unlinkSync(fp);
    res.json({ ok: true });
  } catch (e) {
    console.error('[profile:delete]', e);
    res.status(500).json({ error: 'delete failed' });
  }
});

/* ══════════════════════════════════════════════════════════════════════
   SESSION ENDPOINTS (existing)
   ══════════════════════════════════════════════════════════════════════ */

app.post('/api/save-session', (req, res) => {
  try {
    const { user, data } = req.body;
    if (!user || !data) return res.status(400).json({ error: 'missing user or data' });

    const dir = path.join(__dirname, 'sessions');
    ensureDir(dir);

    const ts       = Date.now();
    const filename = `${user.replace(/[^a-z0-9_-]/gi, '_')}_${ts}.json`;
    const filepath = path.join(dir, filename);

    fs.writeFileSync(filepath, JSON.stringify({ user, ts, ...data }, null, 2));
    res.json({ ok: true, filename });
  } catch (e) {
    console.error('[save-session]', e);
    res.status(500).json({ error: 'write failed' });
  }
});

app.get('/api/sessions', (_req, res) => {
  try {
    const dir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(dir)) return res.json([]);

    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filepath = path.join(dir, f);
        const stat     = fs.statSync(filepath);
        try {
          const raw  = fs.readFileSync(filepath, 'utf8');
          const data = JSON.parse(raw);
          return {
            filename:        f,
            user:            data.user,
            ts:              data.ts,
            sessionDuration: data.sessionDuration,
            fixationCount:   data.fixations ? data.fixations.length : 0,
            saccadeCount:    data.saccades  ? data.saccades.length  : 0,
            firstFix:        data.firstFix  || null,
            size:            stat.size
          };
        } catch (_) {
          return { filename: f, ts: stat.mtimeMs };
        }
      })
      .sort((a, b) => b.ts - a.ts);

    res.json(files);
  } catch (e) {
    console.error('[sessions]', e);
    res.status(500).json({ error: 'read failed' });
  }
});

/* ── start ── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`listening on :${PORT}`));
