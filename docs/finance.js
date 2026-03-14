import { Router } from 'express';

const router = Router();

// ── Simple in-memory cache (1 min TTL for finance) ─────────
const cache = new Map();

function getCache(key, ttlMs = 60000) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.time > ttlMs) {
        cache.delete(key);
        return null;
    }
    return entry.data;
}

function setCache(key, data) {
    cache.set(key, { data, time: Date.now() });
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (now - entry.time > 300000) cache.delete(key);
    }
}, 300000);

// ============================================================
//  FINNHUB ENDPOINTS
// ============================================================

/**
 * GET /api/finance/quote/:symbol
 * Real-time stock quote
 */
router.get('/quote/:symbol', async (req, res) => {
    try {
        const token = process.env.FINNHUB_API_KEY;
        if (!token) return res.status(500).json({ error: 'FINNHUB_API_KEY not configured' });

        const symbol = req.params.symbol.toUpperCase();
        const cacheKey = `quote_${symbol}`;

        const cached = getCache(cacheKey, 30000); // 30 sec for quotes
        if (cached) return res.json(cached);

        const response = await fetch(
            `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${token}`
        );

        if (!response.ok) {
            return res.status(response.status).json({ error: 'Finnhub API error' });
        }

        const data = await response.json();

        // Finnhub returns all zeros if symbol not found
        if (data.c === 0 && data.h === 0 && data.l === 0) {
            return res.status(404).json({ error: `Symbol ${symbol} not found` });
        }

        const result = {
            symbol,
            currentPrice: data.c,
            change: data.d,
            changePercent: data.dp,
            high: data.h,
            low: data.l,
            open: data.o,
            previousClose: data.pc,
            timestamp: data.t,
        };

        setCache(cacheKey, result);
        res.json(result);
    } catch (err) {
        console.error('Quote error:', err.message);
        res.status(500).json({ error: 'Failed to fetch quote' });
    }
});

/**
 * GET /api/finance/quotes?symbols=AAPL,MSFT,GOOGL
 * Batch quotes for multiple symbols
 */
router.get('/quotes', async (req, res) => {
    try {
        const token = process.env.FINNHUB_API_KEY;
        if (!token) return res.status(500).json({ error: 'FINNHUB_API_KEY not configured' });

        const symbols = (req.query.symbols || '').split(',').filter(Boolean).slice(0, 20);
        if (!symbols.length) return res.status(400).json({ error: 'symbols query param required' });

        const results = [];

        for (const sym of symbols) {
            const symbol = sym.trim().toUpperCase();
            const cacheKey = `quote_${symbol}`;
            const cached = getCache(cacheKey, 30000);

            if (cached) {
                results.push(cached);
                continue;
            }

            try {
                const response = await fetch(
                    `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${token}`
                );
                const data = await response.json();

                if (data.c === 0 && data.h === 0) {
                    results.push({ symbol, error: 'Not found' });
                    continue;
                }

                const result = {
                    symbol,
                    currentPrice: data.c,
                    change: data.d,
                    changePercent: data.dp,
                    high: data.h,
                    low: data.l,
                    open: data.o,
                    previousClose: data.pc,
                };
                setCache(cacheKey, result);
                results.push(result);
            } catch {
                results.push({ symbol, error: 'Fetch failed' });
            }
        }

        res.json({ quotes: results });
    } catch (err) {
        console.error('Batch quotes error:', err.message);
        res.status(500).json({ error: 'Failed to fetch quotes' });
    }
});

/**
 * GET /api/finance/market-news
 * ?category=general|forex|crypto|merger
 */
router.get('/market-news', async (req, res) => {
    try {
        const token = process.env.FINNHUB_API_KEY;
        if (!token) return res.status(500).json({ error: 'FINNHUB_API_KEY not configured' });

        const category = req.query.category || 'general';
        const cacheKey = `market_news_${category}`;

        const cached = getCache(cacheKey, 120000); // 2 min
        if (cached) return res.json(cached);

        const response = await fetch(
            `https://finnhub.io/api/v1/news?category=${category}&token=${token}`
        );
        const data = await response.json();

        const result = (Array.isArray(data) ? data : []).slice(0, 30).map((item) => ({
            id: item.id,
            title: item.headline,
            summary: item.summary,
            source: item.source,
            url: item.url,
            image: item.image,
            category: item.category,
            publishedAt: item.datetime ? new Date(item.datetime * 1000).toISOString() : null,
        }));

        setCache(cacheKey, result);
        res.json(result);
    } catch (err) {
        console.error('Market news error:', err.message);
        res.status(500).json({ error: 'Failed to fetch market news' });
    }
});

/**
 * GET /api/finance/candles/:symbol
 * ?resolution=D&from=unixtime&to=unixtime
 * resolution: 1, 5, 15, 30, 60, D, W, M
 */
router.get('/candles/:symbol', async (req, res) => {
    try {
        const token = process.env.FINNHUB_API_KEY;
        if (!token) return res.status(500).json({ error: 'FINNHUB_API_KEY not configured' });

        const symbol = req.params.symbol.toUpperCase();
        const resolution = req.query.resolution || 'D';
        const now = Math.floor(Date.now() / 1000);
        const from = req.query.from || now - 30 * 86400;
        const to = req.query.to || now;

        const cacheKey = `candles_${symbol}_${resolution}_${from}_${to}`;
        const cached = getCache(cacheKey, 120000);
        if (cached) return res.json(cached);

        const response = await fetch(
            `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}&token=${token}`
        );
        const data = await response.json();

        if (data.s !== 'ok' || !data.t) {
            return res.status(400).json({ error: 'No candle data available' });
        }

        const result = {
            symbol,
            resolution,
            candles: data.t.map((time, i) => ({
                time: new Date(time * 1000).toISOString(),
                open: data.o[i],
                high: data.h[i],
                low: data.l[i],
                close: data.c[i],
                volume: data.v[i],
            })),
        };

        setCache(cacheKey, result);
        res.json(result);
    } catch (err) {
        console.error('Candles error:', err.message);
        res.status(500).json({ error: 'Failed to fetch candles' });
    }
});

/**
 * GET /api/finance/company/:symbol
 * Company profile from Finnhub
 */
router.get('/company/:symbol', async (req, res) => {
    try {
        const token = process.env.FINNHUB_API_KEY;
        if (!token) return res.status(500).json({ error: 'FINNHUB_API_KEY not configured' });

        const symbol = req.params.symbol.toUpperCase();
        const cacheKey = `company_${symbol}`;

        const cached = getCache(cacheKey, 3600000); // 1 hour
        if (cached) return res.json(cached);

        const response = await fetch(
            `https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${token}`
        );
        const data = await response.json();

        if (!data.name) {
            return res.status(404).json({ error: `Company ${symbol} not found` });
        }

        setCache(cacheKey, data);
        res.json(data);
    } catch (err) {
        console.error('Company error:', err.message);
        res.status(500).json({ error: 'Failed to fetch company data' });
    }
});

// ============================================================
//  FMP ENDPOINTS (Optional — requires FMP_API_KEY)
// ============================================================

/**
 * GET /api/finance/economic-calendar
 * ?from=2026-03-01&to=2026-03-14
 */
router.get('/economic-calendar', async (req, res) => {
    try {
        const apiKey = process.env.FMP_API_KEY;
        if (!apiKey) return res.status(400).json({ error: 'FMP_API_KEY not configured (optional)' });

        const { from, to } = req.query;
        const cacheKey = `econ_cal_${from}_${to}`;

        const cached = getCache(cacheKey, 600000); // 10 min
        if (cached) return res.json(cached);

        const params = new URLSearchParams({ apikey: apiKey });
        if (from) params.append('from', from);
        if (to) params.append('to', to);

        const response = await fetch(
            `https://financialmodelingprep.com/api/v3/economic_calendar?${params}`
        );
        const data = await response.json();

        setCache(cacheKey, data);
        res.json(data);
    } catch (err) {
        console.error('Economic calendar error:', err.message);
        res.status(500).json({ error: 'Failed to fetch economic calendar' });
    }
});

export default router;
