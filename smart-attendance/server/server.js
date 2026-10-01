require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const db = require('./db');
const { generalLimiter } = require('./middleware/rateLimit');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' })); // CSV bulk-import bodies are sent as JSON text, above express's 100kb default
app.use('/api', generalLimiter); // broad baseline guard; sensitive routes below layer stricter limits on top

app.use('/api/auth', require('./routes/auth'));
app.use('/api/students', require('./routes/students'));
app.use('/api/faculty', require('./routes/faculty'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/holidays', require('./routes/holidays'));
app.use('/api/notes', require('./routes/notes'));
app.use('/api/super-admin', require('./routes/superAdmin'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// serve the frontend
const clientDir = path.join(__dirname, '..', 'client');
app.use(express.static(clientDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(clientDir, 'index.html'));
});

// central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 3000;

// Confirms the selected DB_ENGINE can actually be reached before accepting any
// traffic. A bad DATABASE_URL / unreachable Postgres server must fail startup
// loudly and immediately here — it must never fall back to SQLite, and must
// never let the app silently start and only fail on a user's first request.
(async () => {
  try {
    await db.get('SELECT 1');
  } catch (e) {
    console.error(`\nFATAL: could not connect to the database (engine: ${db.engine}).`);
    console.error(e.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`\nSmart Attendance server running at http://localhost:${PORT} (DB engine: ${db.engine})`);
    console.log('Demo logins → student: 24UCS205/student123 · faculty: FAC-1042/faculty123 · admin: ADM-009/admin123\n');
  });
})();
