# CLAUDE.md — Zerowfx Server

## Project Overview
This is the Zerowfx backend API server. It handles:
- **Subscribers**: Email waitlist with Cloudflare IP/country detection
- **Admin**: Session-based auth, subscriber management, CSV export
- **News**: NewsData.io integration for real-time news fetching (latest, crypto, archive search)
- **Finance**: Finnhub API for stock quotes, candles, market news + optional FMP for economic data
- **AI Pipeline**: Claude API for summarizing, translating, rewriting news articles + sentiment analysis

## Tech Stack
- **Runtime**: Node.js (ESM modules — all files use `import/export`, NOT `require`)
- **Framework**: Express.js
- **Database**: SQLite via `better-sqlite3` (file: `../data/zerowfx.db`)
- **Auth**: `express-session` + `bcryptjs` for admin login
- **No ORM** — raw SQL with prepared statements

## File Structure
```
server/
├── index.js          # Main Express app — mounts all routes, sessions, CORS
├── database.js       # SQLite setup, table creation, default admin seed
├── package.json      # ESM ("type": "module"), all dependencies
├── .env.example      # Template for environment variables
└── routes/
    ├── news.js       # /api/news/* — NewsData.io + AI endpoints + pipeline
    └── finance.js    # /api/finance/* — Finnhub + FMP endpoints
```

## API Routes Summary
| Prefix | Description |
|--------|-------------|
| `POST /api/subscribe` | Email signup (public) |
| `POST /api/admin/login` | Admin session login |
| `POST /api/admin/logout` | Destroy session |
| `GET /api/admin/me` | Check auth status |
| `GET /api/admin/subscribers` | List subscribers (paginated, searchable) |
| `DELETE /api/admin/subscribers/:id` | Remove subscriber |
| `GET /api/admin/subscribers/export/csv` | CSV download |
| `GET /api/admin/news/stats` | News article counts |
| `GET /api/news/latest` | Fetch latest news from NewsData.io |
| `GET /api/news/crypto` | Fetch crypto news |
| `GET /api/news/search` | Search archive (paid plan) |
| `GET /api/news/saved` | Get locally saved articles from DB |
| `DELETE /api/news/saved/:id` | Delete saved article |
| `POST /api/news/ai/summarize` | AI summarize article |
| `POST /api/news/ai/translate` | AI translate text |
| `POST /api/news/ai/rewrite` | AI rewrite article (unique) |
| `POST /api/news/ai/sentiment` | AI market sentiment analysis |
| `POST /api/news/pipeline/process` | Full pipeline: fetch → summarize → translate → rewrite → save |
| `GET /api/finance/quote/:symbol` | Real-time stock quote |
| `GET /api/finance/quotes?symbols=AAPL,MSFT` | Batch quotes |
| `GET /api/finance/market-news` | Market news from Finnhub |
| `GET /api/finance/candles/:symbol` | Historical OHLCV data |
| `GET /api/finance/company/:symbol` | Company profile |
| `GET /api/finance/economic-calendar` | Economic events (FMP) |
| `GET /api/health` | Server health + API key status |

## Database Tables
- `subscribers` — id, email (unique), ip_address, country, created_at
- `admins` — id, username (unique), password (bcrypt hash), created_at
- `news_articles` — id, source_id, title, description, content, original_url, image_url, source_name, category, language, country, published_at, sentiment, keywords, ai_summary, ai_translation, ai_rewritten_title, ai_rewritten_content, translate_language, is_processed, created_at

## Important Patterns
- All external API calls use native `fetch()` (Node 18+)
- In-memory Map cache per route file (news: 5min TTL, finance: 30s-2min TTL)
- Cloudflare headers used for real IP: `cf-connecting-ip`, `x-real-ip`, `x-forwarded-for`
- Cloudflare country header: `cf-ipcountry`
- `trust proxy` is enabled for production behind reverse proxy
- Session cookie: `secure: true` in production, `sameSite: 'none'` in production
- Default admin: username `admin`, password `zerowfx2026`

## Environment Variables
All in `.env` file at server root:
- `PORT` — server port (default 3001)
- `NODE_ENV` — development | production
- `FRONTEND_URL` — CORS allowed origin
- `SESSION_SECRET` — session encryption key
- `NEWSDATA_API_KEY` — from newsdata.io
- `FINNHUB_API_KEY` — from finnhub.io
- `ANTHROPIC_API_KEY` — from console.anthropic.com
- `FMP_API_KEY` — optional, from financialmodelingprep.com

## Running
```bash
npm install
cp .env.example .env  # fill in your API keys
npm run dev            # development with --watch
npm start              # production
```

## Common Tasks
- **Add a new API route**: Create in `routes/` folder, export Router, mount in `index.js`
- **Add a DB table**: Add `CREATE TABLE IF NOT EXISTS` in `database.js`
- **Protect a route**: Use `requireAuth` middleware (defined in `index.js`)
- **Add caching**: Use the Map-based cache pattern in each route file
