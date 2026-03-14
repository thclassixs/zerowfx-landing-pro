import { Router } from 'express';
import db from '../database.js';

const router = Router();

// ── Slug helper ────────────────────────────────────────────
function generateSlug(title) {
    if (!title) return 'untitled-' + Date.now();
    return title
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')     // remove special chars
        .replace(/\s+/g, '-')         // spaces → hyphens
        .replace(/-+/g, '-')          // collapse multiple hyphens
        .replace(/^-+|-+$/g, '')      // trim leading/trailing hyphens
        .slice(0, 80)                 // max length
        + '-' + Date.now().toString(36); // unique suffix
}

// ── Migration: add slug column if missing ──────────────────
try {
    const cols = db.prepare("PRAGMA table_info(news_articles)").all();
    const hasSlug = cols.some(c => c.name === 'slug');
    if (!hasSlug) {
        // SQLite cannot add a UNIQUE column via ALTER TABLE — add plain column first
        db.exec('ALTER TABLE news_articles ADD COLUMN slug TEXT');
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_news_slug ON news_articles(slug)');
        console.log('Migration: added slug column to news_articles');
        // Generate slugs for existing articles
        const articles = db.prepare('SELECT id, title FROM news_articles WHERE slug IS NULL').all();
        const updateSlug = db.prepare('UPDATE news_articles SET slug = ? WHERE id = ?');
        for (const a of articles) {
            updateSlug.run(generateSlug(a.title), a.id);
        }
        if (articles.length) console.log(`Generated slugs for ${articles.length} existing articles`);
    }
} catch (e) {
    console.log('Slug migration skipped:', e.message);
}

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

// ── Helper: get best available article text (free plan has no content) ──
function getArticleText(article) {
    // Build the best available text — free plan only has title + description
    let text = [article.title, article.description || ''].filter(Boolean).join('. ');

    // Only use content if it actually exists and isn't a "paid plan" message
    if (article.content &&
        !article.content.includes('paid plan') &&
        !article.content.includes('ONLY AVAILABLE') &&
        article.content.length > 50) {
        text = article.content;
    }

    return text;
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

        // Auto-generate slugs for articles that don't have one
        const updateSlug = db.prepare('UPDATE news_articles SET slug = ? WHERE id = ?');
        for (const a of articles) {
            if (!a.slug) {
                a.slug = generateSlug(a.title);
                updateSlug.run(a.slug, a.id);
            }
        }

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
 * GET /api/news/article/:slug
 * Public endpoint — get a single article by slug (for /news/[slug] pages)
 */
router.get('/article/:slug', (req, res) => {
    try {
        const article = db.prepare('SELECT * FROM news_articles WHERE slug = ?').get(req.params.slug);
        if (!article) {
            return res.status(404).json({ error: 'Article not found' });
        }
        res.json(article);
    } catch (err) {
        console.error('Get article by slug error:', err.message);
        res.status(500).json({ error: 'Failed to get article' });
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
        const { title, content, description, length = 'short' } = req.body;
        if (!title && !content && !description) return res.status(400).json({ error: 'Title, description, or content is required' });

        const instructions = {
            short: 'Write a clear and informative 2-3 sentence summary.',
            medium: 'Write a clear and informative 4-6 sentence summary.',
            long: 'Provide a comprehensive summary in 2-3 paragraphs.',
        };

        // Build text using the free-plan-safe approach
        const textObj = { title: title || '', description: description || content || '' };
        const articleText = getArticleText(textObj);

        const summary = await callClaude(
            `Based on the following news headline and brief description, ${instructions[length] || instructions.short} Do NOT say you cannot see the content or that it's unavailable. Work with what is provided.\n\nHeadline: ${title || 'N/A'}\nDescription: ${description || content || 'N/A'}\n\nProvide ONLY the summary, no labels.`
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
        const { text, title, description, targetLanguage = 'ar', sourceLanguage = 'en' } = req.body;
        const inputText = text || [title, description || ''].filter(Boolean).join('. ');
        if (!inputText) return res.status(400).json({ error: 'Text, title, or description is required' });

        const rawTranslation = await callClaude(
            `Translate the following news headline and description to ${targetLanguage}. Return ONLY a JSON object with the translated title and text. Do NOT add any commentary about missing content.\n\nTitle: ${title || inputText}\nDescription: ${description || inputText}\n\nRespond in JSON: {"title":"translated title","text":"translated description"}`,
            2048
        );

        let translatedTitle = '';
        let translatedText = rawTranslation;
        try {
            const cleaned = rawTranslation.replace(/```json\n?|```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            translatedTitle = parsed.title || '';
            translatedText = parsed.text || parsed.description || rawTranslation;
        } catch {
            // If not valid JSON, use the raw text as translation
            translatedText = rawTranslation;
        }

        res.json({ original: inputText, translation: translatedText, translatedTitle, sourceLanguage, targetLanguage });
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
        const { title, content, description, style = 'professional' } = req.body;
        if (!title && !content && !description) return res.status(400).json({ error: 'Title, description, or content is required' });

        const styles = {
            professional: 'Write in a professional, authoritative news style.',
            casual: 'Write in a conversational, easy-to-read blog style.',
            technical: 'Write in a detailed, analytical style with data focus.',
            brief: 'Write a concise, punchy version for social media or alerts.',
        };

        const result = await callClaude(
            `Rewrite the following news item as a unique, original article in ${style} style. ${styles[style] || styles.professional} Use the headline and description to create a complete, well-written paragraph. Do NOT mention that you only have a title or description — write as if you are a journalist covering this story.\n\nHeadline: ${title || 'N/A'}\nDescription: ${description || content || 'N/A'}\n\nRespond in JSON: {"title":"...","content":"..."}`,
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

            const text = getArticleText(article);

            // Summarize
            try {
                item.summary = await callClaude(
                    `Based on the following news headline and brief description, write a clear and informative 2-3 sentence summary that expands on the key points. Do NOT say you cannot see the content or that it's unavailable. Work with what is provided.\n\nHeadline: ${article.title}\nDescription: ${article.description || ''}`
                );
            } catch (e) {
                item.summary = null;
                console.error('Pipeline summarize error:', e.message);
            }

            // Translate
            if (translateTo && translateTo !== language) {
                try {
                    const rawTranslation = await callClaude(
                        `Translate the following news headline and description to ${translateTo}. Return ONLY a JSON object with the translated title and text. Do NOT add any commentary about missing content.\n\nTitle: ${article.title}\nDescription: ${article.description || ''}\n\nRespond in JSON: {"title":"translated title","text":"translated description"}`,
                        2048
                    );
                    try {
                        const cleaned = rawTranslation.replace(/```json\n?|```/g, '').trim();
                        const parsed = JSON.parse(cleaned);
                        item.translatedTitle = parsed.title || null;
                        item.translation = parsed.text || parsed.description || rawTranslation;
                    } catch {
                        item.translation = rawTranslation;
                        item.translatedTitle = null;
                    }
                } catch (e) {
                    item.translation = null;
                    item.translatedTitle = null;
                    console.error('Pipeline translate error:', e.message);
                }
            }

            // Rewrite
            try {
                const rewriteResult = await callClaude(
                    `Rewrite the following news item as a unique, original article in ${rewriteStyle} style. Use the headline and description to create a complete, well-written paragraph. Do NOT mention that you only have a title or description — write as if you are a journalist covering this story.\n\nHeadline: ${article.title}\nDescription: ${article.description || ''}\n\nReturn JSON {"title":"...","content":"..."}`,
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
                        (source_id, slug, title, description, content, original_url, image_url, source_name, 
                         category, language, country, published_at, sentiment, keywords,
                         ai_summary, ai_translation, ai_translated_title, ai_rewritten_title, ai_rewritten_content, 
                         translate_language, is_processed)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(
                        article.article_id,
                        generateSlug(article.title),
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
                        item.translatedTitle || null,
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
