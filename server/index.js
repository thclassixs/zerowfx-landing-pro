import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import cors from 'cors';
import path from 'path';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import db from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || origin.startsWith('http://localhost:') || origin === process.env.FRONTEND_URL) {
            callback(null, origin || '*');
        } else {
            callback(null, process.env.FRONTEND_URL || 'http://localhost:4321');
        }
    },
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'zerowfx-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true in production with HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Serve assets statically
app.use('/assets', express.static(path.join(__dirname, '..', '..', 'assets')));

// Auth middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.adminId) {
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
}

// ==================== API ROUTES ====================

// Subscribe (Join the list)
app.post('/api/subscribe', (req, res) => {
    try {
        const { email } = req.body;

        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email is required' });
        }

        // Get real IP from Cloudflare headers
        // Cloudflare sends the real visitor IP in these headers:
        // CF-Connecting-IP is the most reliable one
        const ip = req.headers['cf-connecting-ip']
            || req.headers['x-real-ip']
            || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || req.socket?.remoteAddress
            || req.ip;

        // Get country from Cloudflare header
        // Cloudflare automatically adds this header when proxied
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

app.listen(PORT, () => {
    console.log(`🚀 Zerowfx API server running on http://localhost:${PORT}`);
});
