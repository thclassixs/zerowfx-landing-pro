import { Router } from 'express';
import db from '../database.js';

const router = Router();

// ── In-memory cache ────────────────────────────────────────
const cache = new Map();

function getCache(key, ttlMs) {
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

// Clean cache every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (now - entry.time > 600000) cache.delete(key);
    }
}, 600000);

// ── Helper: format NewsData.io article ─────────────────────
function formatArticle(article) {
    return {
        id: article.article_id || null,
        title: article.title,
        description: article.description,
        content: article.content || null,
        source: article.source_name || article.source_id,
        sourceUrl: article.source_url,
        link: article.link,
        image: article.image_url,
        category: article.category,
        country: article.country,
        language: article.language,
        publishedAt: article.pubDate,
        sentiment: article.sentiment || null,
        aiTags: article.ai_tag || null,
        keywords: article.keywords || [],
    };
}

// ── Helper: call Claude API ────────────────────────────────
async function callClaude(prompt, maxTokens = 1024) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt }],
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Claude API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.content?.[0]?.text || '';
}

// ============================================================
//  NEWS ENDPOINTS
// ============================================================

/**
 * GET /api/news/latest
 * ?category=business&language=en&country=us&q=keyword&page=nextPage
 */
router.get('/latest', async (req, res) => {
    try {
        const apiKey = process.env.NEWSDATA_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'NEWSDATA_API_KEY not configured' });

        const { category, language = 'en', country, q, page } = req.query;
        const cacheKey = `news_latest_${category}_${language}_${country}_${q}_${page}`;

        const cached = getCache(cacheKey, 300000); // 5 min
        if (cached) return res.json(cached);

        const params = new URLSearchParams({ apikey: apiKey, language });
        if (category) params.append('category', category);
        if (country) params.append('country', country);
        if (q) params.append('q', q);
        if (page) params.append('page', page);

        const response = await fetch(`https://newsdata.io/api/1/latest?${params}`);
        const data = await response.json();

        if (data.status === 'success') {
            const result = {
                status: 'success',
                totalResults: data.totalResults,
                nextPage: data.nextPage,
                articles: (data.results || []).map(formatArticle),
            };
            setCache(cacheKey, result);
            return res.json(result);
        }

        res.status(400).json({ error: data.message || 'Failed to fetch news' });
    } catch (err) {
        console.error('News fetch error:', err.message);
        res.status(500).json({ error: 'Failed to fetch news' });
    }
});

/**
 * GET /api/news/crypto
 * ?coin=bitcoin&language=en&page=nextPage
 */
router.get('/crypto', async (req, res) => {
    try {
        const apiKey = process.env.NEWSDATA_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'NEWSDATA_API_KEY not configured' });

        const { coin, language = 'en', page } = req.query;
        const cacheKey = `news_crypto_${coin}_${language}_${page}`;

        const cached = getCache(cacheKey, 300000);
        if (cached) return res.json(cached);

        const params = new URLSearchParams({ apikey: apiKey, language });
        if (coin) params.append('coin', coin);
        if (page) params.append('page', page);

        const response = await fetch(`https://newsdata.io/api/1/crypto?${params}`);
        const data = await response.json();

        if (data.status === 'success') {
            const result = {
                status: 'success',
                totalResults: data.totalResults,
                nextPage: data.nextPage,
                articles: (data.results || []).map(formatArticle),
            };
            setCache(cacheKey, result);
            return res.json(result);
        }

        res.status(400).json({ error: data.message || 'Failed to fetch crypto news' });
    } catch (err) {
        console.error('Crypto news error:', err.message);
        res.status(500).json({ error: 'Failed to fetch crypto news' });
    }
});

/**
 * GET /api/news/search
 * ?q=keyword&from_date=2026-01-01&to_date=2026-03-01&language=en&category=business
 * (Paid plan only — requires archive access)
 */
router.get('/search', async (req, res) => {
    try {
        const apiKey = process.env.NEWSDATA_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'NEWSDATA_API_KEY not configured' });

        const { q, from_date, to_date, language = 'en', category, page } = req.query;
        if (!q) return res.status(400).json({ error: "Query parameter 'q' is required" });

        const cacheKey = `news_search_${q}_${from_date}_${to_date}_${language}_${page}`;
        const cached = getCache(cacheKey, 300000);
        if (cached) return res.json(cached);

        const params = new URLSearchParams({ apikey: apiKey, q, language });
        if (from_date) params.append('from_date', from_date);
        if (to_date) params.append('to_date', to_date);
        if (category) params.append('category', category);
        if (page) params.append('page', page);

        const response = await fetch(`https://newsdata.io/api/1/archive?${params}`);
        const data = await response.json();

        if (data.status === 'success') {
            const result = {
                status: 'success',
                totalResults: data.totalResults,
                nextPage: data.nextPage,
                articles: (data.results || []).map(formatArticle),
            };
            setCache(cacheKey, result);
            return res.json(result);
        }

        res.status(400).json({ error: data.message || 'Search failed' });
    } catch (err) {
        console.error('News search error:', err.message);
        res.status(500).json({ error: 'Search failed' });
    }
});

/**
 * GET /api/news/saved
 * Get articles saved in local database
 * ?page=1&limit=20&category=business&processed=1
 */
router.get('/saved', (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const category = req.query.category || '';
        const processed = req.query.processed;
        const offset = (page - 1) * limit;

        let where = [];
        let params = [];

        if (category) {
            where.push('category LIKE ?');
            params.push(`%${category}%`);
        }
        if (processed !== undefined) {
            where.push('is_processed = ?');
            params.push(parseInt(processed));
        }

        const whereClause = where.length ? ' WHERE ' + where.join(' AND ') : '';

        const total = db.prepare(`SELECT COUNT(*) as total FROM news_articles${whereClause}`).get(...params).total;
        const articles = db.prepare(
            `SELECT * FROM news_articles${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).all(...params, limit, offset);

        res.json({
            articles,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    } catch (err) {
        console.error('Saved news error:', err.message);
        res.status(500).json({ error: 'Failed to get saved articles' });
    }
});

/**
 * DELETE /api/news/saved/:id
 */
router.delete('/saved/:id', (req, res) => {
    try {
        db.prepare('DELETE FROM news_articles WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete article error:', err.message);
        res.status(500).json({ error: 'Failed to delete article' });
    }
});

// ============================================================
//  AI ENDPOINTS
// ============================================================

/**
 * POST /api/news/ai/summarize
 * { title, content, length: "short"|"medium"|"long" }
 */
router.post('/ai/summarize', async (req, res) => {
    try {
        const { title, content, length = 'short' } = req.body;
        if (!content && !title) return res.status(400).json({ error: 'Content or title is required' });

        const instructions = {
            short: 'Summarize in 2-3 sentences. Be concise.',
            medium: 'Summarize in 4-6 sentences. Include key details.',
            long: 'Provide a comprehensive summary in 2-3 paragraphs.',
        };

        const summary = await callClaude(
            `You are a professional news editor. ${instructions[length] || instructions.short}\n\nTitle: ${title || 'N/A'}\nContent: ${content || 'N/A'}\n\nProvide ONLY the summary, no labels.`
        );

        res.json({ summary, length });
    } catch (err) {
        console.error('AI summarize error:', err.message);
        res.status(500).json({ error: 'Failed to generate summary' });
    }
});

/**
 * POST /api/news/ai/translate
 * { text, targetLanguage: "ar", sourceLanguage: "en" }
 */
router.post('/ai/translate', async (req, res) => {
    try {
        const { text, targetLanguage = 'ar', sourceLanguage = 'en' } = req.body;
        if (!text) return res.status(400).json({ error: 'Text is required' });

        const translation = await callClaude(
            `Translate from ${sourceLanguage} to ${targetLanguage}. Maintain tone and style. Provide ONLY the translation:\n\n${text}`,
            2048
        );

        res.json({ original: text, translation, sourceLanguage, targetLanguage });
    } catch (err) {
        console.error('AI translate error:', err.message);
        res.status(500).json({ error: 'Failed to translate' });
    }
});

/**
 * POST /api/news/ai/rewrite
 * { title, content, style: "professional"|"casual"|"technical"|"brief" }
 */
router.post('/ai/rewrite', async (req, res) => {
    try {
        const { title, content, style = 'professional' } = req.body;
        if (!content) return res.status(400).json({ error: 'Content is required' });

        const styles = {
            professional: 'Write in a professional, authoritative news style.',
            casual: 'Write in a conversational, easy-to-read blog style.',
            technical: 'Write in a detailed, analytical style with data focus.',
            brief: 'Write a concise, punchy version for social media or alerts.',
        };

        const result = await callClaude(
            `You are a skilled journalist. Rewrite this article in your own words to create a unique version. ${styles[style] || styles.professional}\n\nOriginal Title: ${title || 'N/A'}\nOriginal Content: ${content}\n\nRespond in JSON: {"title":"...","content":"..."}`,
            2048
        );

        try {
            const cleaned = result.replace(/```json\n?|```/g, '').trim();
            res.json({ rewritten: JSON.parse(cleaned), style });
        } catch {
            res.json({ rewritten: { title, content: result }, style });
        }
    } catch (err) {
        console.error('AI rewrite error:', err.message);
        res.status(500).json({ error: 'Failed to rewrite' });
    }
});

/**
 * POST /api/news/ai/sentiment
 * { articles: [{ title, content }] }
 */
router.post('/ai/sentiment', async (req, res) => {
    try {
        const { articles } = req.body;
        if (!articles?.length) return res.status(400).json({ error: 'Articles array is required' });

        const list = articles
            .slice(0, 10)
            .map((a, i) => `${i + 1}. ${a.title}${a.content ? ': ' + a.content.slice(0, 200) : ''}`)
            .join('\n');

        const result = await callClaude(
            `Analyze market sentiment from these news headlines.\n\n${list}\n\nRespond ONLY in JSON:\n{"overallSentiment":"bullish"|"bearish"|"neutral","score":-100 to 100,"summary":"brief analysis","keyTopics":["topic1"],"signals":[{"type":"bullish|bearish|neutral","reason":"..."}]}`
        );

        try {
            const cleaned = result.replace(/```json\n?|```/g, '').trim();
            res.json(JSON.parse(cleaned));
        } catch {
            res.json({ overallSentiment: 'neutral', score: 0, summary: result });
        }
    } catch (err) {
        console.error('Sentiment error:', err.message);
        res.status(500).json({ error: 'Failed to analyze sentiment' });
    }
});

// ============================================================
//  PIPELINE: Fetch → Summarize → Translate → Rewrite → Save
// ============================================================

/**
 * POST /api/news/pipeline/process
 * {
 *   category: "business",
 *   language: "en",
 *   country: "us",
 *   translateTo: "ar",
 *   summaryLength: "short",
 *   rewriteStyle: "professional",
 *   save: true
 * }
 */
router.post('/pipeline/process', async (req, res) => {
    try {
        const apiKey = process.env.NEWSDATA_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'NEWSDATA_API_KEY not configured' });

        const {
            category = 'business',
            language = 'en',
            country,
            translateTo,
            summaryLength = 'short',
            rewriteStyle = 'professional',
            save = true,
            limit = 5,
        } = req.body;

        // Step 1: Fetch news
        const params = new URLSearchParams({ apikey: apiKey, language, category });
        if (country) params.append('country', country);

        const newsRes = await fetch(`https://newsdata.io/api/1/latest?${params}`);
        const newsData = await newsRes.json();

        if (newsData.status !== 'success' || !newsData.results?.length) {
            return res.status(400).json({ error: 'No news articles found' });
        }

        // Step 2: Process each article
        const processed = [];
        const articlesToProcess = newsData.results.slice(0, Math.min(limit, 10));

        for (const article of articlesToProcess) {
            const item = {
                original: formatArticle(article),
                summary: null,
                translation: null,
                rewritten: null,
            };

            const text = article.content || article.description || article.title;

            // Summarize
            try {
                item.summary = await callClaude(
                    `Summarize this news in 2-3 sentences:\n\nTitle: ${article.title}\nContent: ${text}`
                );
            } catch (e) {
                item.summary = null;
                console.error('Pipeline summarize error:', e.message);
            }

            // Translate
            if (translateTo && translateTo !== language) {
                try {
                    item.translation = await callClaude(
                        `Translate to ${translateTo}. Provide ONLY the translation:\n\n${item.summary || text}`,
                        2048
                    );
                } catch (e) {
                    item.translation = null;
                    console.error('Pipeline translate error:', e.message);
                }
            }

            // Rewrite
            try {
                const rewriteResult = await callClaude(
                    `Rewrite this news in a ${rewriteStyle} style. Make it unique. Return JSON {"title":"...","content":"..."}:\n\nTitle: ${article.title}\nContent: ${text}`,
                    2048
                );
                try {
                    const cleaned = rewriteResult.replace(/```json\n?|```/g, '').trim();
                    item.rewritten = JSON.parse(cleaned);
                } catch {
                    item.rewritten = { title: article.title, content: rewriteResult };
                }
            } catch (e) {
                item.rewritten = null;
                console.error('Pipeline rewrite error:', e.message);
            }

            // Save to database
            if (save) {
                try {
                    db.prepare(`
                        INSERT OR IGNORE INTO news_articles 
                        (source_id, title, description, content, original_url, image_url, source_name, 
                         category, language, country, published_at, sentiment, keywords,
                         ai_summary, ai_translation, ai_rewritten_title, ai_rewritten_content, 
                         translate_language, is_processed)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(
                        article.article_id,
                        article.title,
                        article.description,
                        article.content,
                        article.link,
                        article.image_url,
                        article.source_name || article.source_id,
                        JSON.stringify(article.category),
                        article.language,
                        JSON.stringify(article.country),
                        article.pubDate,
                        article.sentiment || null,
                        JSON.stringify(article.keywords || []),
                        item.summary,
                        item.translation,
                        item.rewritten?.title || null,
                        item.rewritten?.content || null,
                        translateTo || null,
                        1
                    );
                } catch (e) {
                    console.error('Pipeline save error:', e.message);
                }
            }

            processed.push(item);
        }

        res.json({
            status: 'success',
            processedCount: processed.length,
            articles: processed,
        });
    } catch (err) {
        console.error('Pipeline error:', err.message);
        res.status(500).json({ error: 'Pipeline processing failed' });
    }
});

export default router;
