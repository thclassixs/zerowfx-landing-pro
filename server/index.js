import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import cors from 'cors';
import path from 'path';
import bcrypt from 'bcryptjs';
import { fileURLToPath, pathToFileURL } from 'url';
import db from './database.js';
import newsRoutes from './routes/news.js';
import financeRoutes from './routes/finance.js';
import adminNewsRoutes from './routes/admin-news.js';
import { setSchedulerControl } from './routes/admin-news.js';
import { startScheduler } from './scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// ── Trust proxy (required for Cloudflare / reverse proxy) ──
app.set('trust proxy', 1);

// ── CORS ────────────────────────────────────────────────────
const allowedOrigins = [
    process.env.FRONTEND_URL,
    'http://localhost:4321',
    'http://localhost:3000',
    'http://localhost:5173',
].filter(Boolean);

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);
        if (allowedOrigins.some(o => origin.startsWith(o))) {
            return callback(null, origin);
        }
        // In production, restrict to your domain
        if (process.env.NODE_ENV === 'production' && process.env.FRONTEND_URL) {
            return callback(null, process.env.FRONTEND_URL);
        }
        callback(null, origin);
    },
    credentials: true
}));

// ── Astro SSR handler (for dynamic pages like /news/[slug]) ─
let astroHandler = null;
try {
    const entryPath = path.join(__dirname, '..', 'dist', 'server', 'entry.mjs');
    const { handler } = await import(pathToFileURL(entryPath).href);
    astroHandler = handler;
    console.log('✅ Astro SSR handler loaded');
} catch (e) {
    console.warn('⚠️  Astro SSR handler not found (run `npm run build` first):', e.message);
}

// ── Serve Astro static client assets ────────────────────────
const clientDir = path.join(__dirname, '..', 'dist', 'client');
app.use(express.static(clientDir, { index: false }));

// ── Body parsers ────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Sessions ────────────────────────────────────────────────
app.use(session({
    secret: process.env.SESSION_SECRET || 'zerowfx-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    }
}));

// ── Static assets ───────────────────────────────────────────
app.use('/assets', express.static(path.join(__dirname, '..', '..', 'assets')));

// ── Auth middleware ──────────────────────────────────────────
function requireAuth(req, res, next) {
    if (req.session && req.session.adminId) {
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
}

// ============================================================
//  HEALTH CHECK
// ============================================================

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        services: {
            newsdata: !!process.env.NEWSDATA_API_KEY,
            finnhub: !!process.env.FINNHUB_API_KEY,
            claude: !!process.env.ANTHROPIC_API_KEY,
            fmp: !!process.env.FMP_API_KEY,
        },
    });
});

// ============================================================
//  SUBSCRIBER ROUTES (existing)
// ============================================================

// Subscribe (Join the list)
app.post('/api/subscribe', async (req, res) => {
    try {
        const { email } = req.body;
        const turnstileToken = req.body['cf-turnstile-response'];

        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email is required' });
        }

        if (!turnstileToken) {
            return res.status(400).json({ error: 'Security check missing' });
        }

        // Get real IP from Cloudflare headers
        const ip = req.headers['cf-connecting-ip']
            || req.headers['x-real-ip']
            || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || req.socket?.remoteAddress
            || req.ip;

        // Verify Turnstile
        const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '0x4AAAAAACq8bTe7_-SRivC2eupLGekUnTU';
        const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body: new URLSearchParams({
                secret: TURNSTILE_SECRET,
                response: turnstileToken,
                remoteip: ip
            })
        });

        const verifyResult = await verifyRes.json();
        if (!verifyResult.success) {
            return res.status(400).json({ error: 'Security check failed. Please try again.' });
        }

        // Get country from Cloudflare header
        const country = req.headers['cf-ipcountry'] || 'Unknown';

        // Check if already subscribed
        const existing = db.prepare('SELECT id FROM subscribers WHERE email = ?').get(email);
        if (existing) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        db.prepare('INSERT INTO subscribers (email, ip_address, country) VALUES (?, ?, ?)').run(email, ip, country);

        res.json({ success: true, message: 'Successfully joined the list!' });
    } catch (error) {
        console.error('Subscribe error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================
//  ADMIN ROUTES (existing)
// ============================================================

// Admin Login
app.post('/api/admin/login', (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);

        if (!admin || !bcrypt.compareSync(password, admin.password)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        req.session.adminId = admin.id;
        req.session.adminUsername = admin.username;

        res.json({ success: true, username: admin.username });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin Logout
app.post('/api/admin/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

// Check auth status
app.get('/api/admin/me', requireAuth, (req, res) => {
    res.json({ username: req.session.adminUsername });
});

// Get all subscribers (admin only)
app.get('/api/admin/subscribers', requireAuth, (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const search = req.query.search || '';
        const offset = (page - 1) * limit;

        let countQuery = 'SELECT COUNT(*) as total FROM subscribers';
        let dataQuery = 'SELECT * FROM subscribers';
        const params = [];

        if (search) {
            const whereClause = ' WHERE email LIKE ? OR ip_address LIKE ? OR country LIKE ?';
            countQuery += whereClause;
            dataQuery += whereClause;
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        dataQuery += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

        const total = db.prepare(countQuery).get(...params).total;
        const subscribers = db.prepare(dataQuery).all(...params, limit, offset);

        res.json({
            subscribers,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get subscribers error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete subscriber (admin only)
app.delete('/api/admin/subscribers/:id', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        db.prepare('DELETE FROM subscribers WHERE id = ?').run(id);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete subscriber error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Export subscribers as CSV (admin only)
app.get('/api/admin/subscribers/export/csv', requireAuth, (req, res) => {
    try {
        const subscribers = db.prepare('SELECT * FROM subscribers ORDER BY created_at DESC').all();

        let csv = 'ID,Email,IP Address,Country,Joined Date\n';
        subscribers.forEach(s => {
            csv += `${s.id},"${s.email}","${s.ip_address}","${s.country}","${s.created_at}"\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=subscribers.csv');
        res.send(csv);
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================
//  NEWS + FINANCE ROUTES (new)
// ============================================================

app.use('/api/news', newsRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/admin/news', requireAuth, adminNewsRoutes);

// ============================================================
//  ASTRO SSR FALLBACK (dynamic pages like /news/[slug])
// ============================================================

if (astroHandler) {
    // Let Astro handle any non-API requests (SSR pages + static fallback)
    app.use((req, res, next) => {
        // Skip API routes — they should 404 normally
        if (req.path.startsWith('/api/')) return next();
        astroHandler(req, res, next);
    });
}

// ============================================================
//  GLOBAL ERROR HANDLER
// ============================================================

app.use((err, req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
//  START SERVER
// ============================================================

app.listen(PORT, () => {
    const keys = {
        NEWSDATA: process.env.NEWSDATA_API_KEY ? '✅' : '❌',
        FINNHUB: process.env.FINNHUB_API_KEY ? '✅' : '❌',
        CLAUDE: process.env.ANTHROPIC_API_KEY ? '✅' : '❌',
        FMP: process.env.FMP_API_KEY ? '✅' : '⚠️  optional',
    };

    // Start auto-fetch scheduler
    const schedulerCtrl = startScheduler();
    setSchedulerControl(schedulerCtrl);

    console.log(`
🚀 Zerowfx API server running on http://localhost:${PORT}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  NewsData.io  ${keys.NEWSDATA}    Finnhub  ${keys.FINNHUB}
  Claude AI    ${keys.CLAUDE}    FMP      ${keys.FMP}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Subscribers  /api/subscribe
  Admin        /api/admin/*
  Admin News   /api/admin/news/*
  News         /api/news/*
  Finance      /api/finance/*
  Health       /api/health
  Astro SSR    ${astroHandler ? '✅' : '❌'} /news/[slug]
  Scheduler    ✅ Active
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});
