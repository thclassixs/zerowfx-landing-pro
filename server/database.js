import Database from 'better-sqlite3';
import path from 'path';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '..', 'data', 'zerowfx.db');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    ip_address TEXT,
    country TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS news_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT,
    slug TEXT,
    title TEXT NOT NULL,
    description TEXT,
    content TEXT,
    original_url TEXT,
    image_url TEXT,
    source_name TEXT,
    category TEXT,
    language TEXT DEFAULT 'en',
    country TEXT,
    published_at TEXT,
    sentiment TEXT,
    keywords TEXT,
    ai_summary TEXT,
    ai_translation TEXT,
    ai_rewritten_title TEXT,
    ai_rewritten_content TEXT,
    translate_language TEXT,
    is_processed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_news_slug ON news_articles(slug);
  CREATE INDEX IF NOT EXISTS idx_news_category ON news_articles(category);
  CREATE INDEX IF NOT EXISTS idx_news_language ON news_articles(language);
  CREATE INDEX IF NOT EXISTS idx_news_created ON news_articles(created_at);
  CREATE INDEX IF NOT EXISTS idx_news_processed ON news_articles(is_processed);

  CREATE TABLE IF NOT EXISTS pipeline_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setting_key TEXT NOT NULL UNIQUE,
    setting_value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pipeline_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    status TEXT DEFAULT 'success',
    articles_fetched INTEGER DEFAULT 0,
    articles_translated INTEGER DEFAULT 0,
    articles_rewritten INTEGER DEFAULT 0,
    error_message TEXT,
    duration_ms INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS api_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_name TEXT NOT NULL,
    call_date TEXT NOT NULL,
    call_count INTEGER DEFAULT 1,
    UNIQUE(api_name, call_date)
  );
`);

// ── Migration: add ai_translated_title column if missing ──
try {
    const cols = db.prepare("PRAGMA table_info(news_articles)").all();
    const hasTranslatedTitle = cols.some(c => c.name === 'ai_translated_title');
    if (!hasTranslatedTitle) {
        db.exec('ALTER TABLE news_articles ADD COLUMN ai_translated_title TEXT');
        console.log('Migration: added ai_translated_title column to news_articles');
    }
} catch (e) {
    console.log('ai_translated_title migration skipped:', e.message);
}

// Create default admin if not exists
const adminExists = db.prepare('SELECT COUNT(*) as count FROM admins').get();
if (adminExists.count === 0) {
    const defaultPassword = process.env.ADMIN_PASSWORD || 'zerowfxadmin123';
    const hashedPassword = bcrypt.hashSync(defaultPassword, 10);
    db.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').run('admin', hashedPassword);
    console.log(`Default admin created - username: admin, password: ${process.env.ADMIN_PASSWORD ? '[HIDDEN]' : defaultPassword}`);
}

// Seed default pipeline settings if none exist
const settingsExist = db.prepare('SELECT COUNT(*) as count FROM pipeline_settings').get();
if (settingsExist.count === 0) {
    const defaults = {
        auto_fetch: 'true',
        fetch_interval: '3600000',
        fetch_categories: 'crypto,world',
        fetch_language: 'en',
        max_articles_per_fetch: '5',
        auto_translate: 'true',
        translate_languages: 'ar,fr',
        translate_style: 'professional',
        auto_rewrite: 'true',
        rewrite_style: 'professional',
        auto_summary: 'true',
        summary_length: 'medium',
    };

    const upsert = db.prepare(`
        INSERT INTO pipeline_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = datetime('now')
    `);

    const seedSettings = db.transaction((entries) => {
        for (const [key, value] of entries) {
            upsert.run(key, value);
        }
    });

    seedSettings(Object.entries(defaults));
    console.log('Default pipeline settings seeded.');
}

export default db;
