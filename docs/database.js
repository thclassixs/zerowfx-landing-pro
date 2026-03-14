import Database from 'better-sqlite3';
import path from 'path';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import { fileURLToPath } from 'url';

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

  CREATE INDEX IF NOT EXISTS idx_news_category ON news_articles(category);
  CREATE INDEX IF NOT EXISTS idx_news_language ON news_articles(language);
  CREATE INDEX IF NOT EXISTS idx_news_created ON news_articles(created_at);
  CREATE INDEX IF NOT EXISTS idx_news_processed ON news_articles(is_processed);
`);

// Create default admin if not exists
const adminExists = db.prepare('SELECT COUNT(*) as count FROM admins').get();
if (adminExists.count === 0) {
    const hashedPassword = bcrypt.hashSync('zerowfx2026', 10);
    db.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').run('admin', hashedPassword);
    console.log('Default admin created - username: admin, password: zerowfx2026');
}

export default db;
