import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '..', 'data', 'zerowfx.db');
const CSV_PATH = path.join(__dirname, '..', 'docs', 'subscribers (1).csv');

// Ensure data dir exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Ensure table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    ip_address TEXT,
    country TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Read CSV
const csv = fs.readFileSync(CSV_PATH, 'utf-8');
const lines = csv.trim().split('\n');

// Skip header
const header = lines[0];
console.log(`CSV Header: ${header}`);
console.log(`Total rows in CSV: ${lines.length - 1}`);

const insert = db.prepare(`
    INSERT OR IGNORE INTO subscribers (email, ip_address, country, created_at)
    VALUES (?, ?, ?, ?)
`);

let imported = 0;
let skipped = 0;

const importAll = db.transaction(() => {
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Parse CSV line (handles quoted fields)
        const parts = [];
        let current = '';
        let inQuotes = false;
        for (const char of line) {
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                parts.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        parts.push(current.trim());

        // CSV format: ID, Email, IP Address, Country, Joined Date
        const [_id, email, ip, country, joinedDate] = parts;

        if (!email) {
            console.log(`  Skipping line ${i + 1}: no email`);
            skipped++;
            continue;
        }

        try {
            const result = insert.run(email, ip || null, country || null, joinedDate || null);
            if (result.changes > 0) {
                imported++;
            } else {
                skipped++;
            }
        } catch (e) {
            console.log(`  Error on line ${i + 1} (${email}): ${e.message}`);
            skipped++;
        }
    }
});

importAll();

const total = db.prepare('SELECT COUNT(*) as count FROM subscribers').get();
console.log(`\n✅ Import complete!`);
console.log(`   Imported: ${imported} new subscribers`);
console.log(`   Skipped:  ${skipped} (already exist or invalid)`);
console.log(`   Total in DB: ${total.count} subscribers`);

db.close();
