import db from './database.js';

// ── Helper: get a setting ──────────────────────────────────
function getSetting(key, defaultValue = null) {
    const row = db.prepare('SELECT setting_value FROM pipeline_settings WHERE setting_key = ?').get(key);
    return row ? row.setting_value : defaultValue;
}

// ── Helper: track API usage ────────────────────────────────
function trackApiUsage(apiName) {
    const today = new Date().toISOString().split('T')[0];
    db.prepare(`
        INSERT INTO api_usage (api_name, call_date, call_count) VALUES (?, ?, 1)
        ON CONFLICT(api_name, call_date) DO UPDATE SET call_count = call_count + 1
    `).run(apiName, today);
}

// ── Helper: call Claude API ────────────────────────────────
async function callClaude(prompt, maxTokens = 1024) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

    trackApiUsage('claude');

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

// ── Scheduler state ────────────────────────────────────────
let intervalId = null;
let isRunning = false;

async function runPipeline() {
    if (isRunning) {
        console.log('[Scheduler] Pipeline already running, skipping...');
        return;
    }

    const autoFetch = getSetting('auto_fetch', 'false');
    if (autoFetch !== 'true') {
        return;
    }

    isRunning = true;
    const startTime = Date.now();
    console.log('[Scheduler] Starting auto-fetch pipeline...');

    try {
        const apiKey = process.env.NEWSDATA_API_KEY;
        if (!apiKey) throw new Error('NEWSDATA_API_KEY not configured');

        const category = getSetting('fetch_categories', 'business');
        const language = getSetting('fetch_language', 'en');
        const maxArticles = parseInt(getSetting('max_articles_per_fetch', '5'));
        const translateTo = getSetting('translate_languages', '');
        const rewriteStyle = getSetting('rewrite_style', 'professional');
        const autoTranslate = getSetting('auto_translate', 'false') === 'true';
        const autoRewrite = getSetting('auto_rewrite', 'false') === 'true';
        const autoSummary = getSetting('auto_summary', 'false') === 'true';

        // Fetch news
        const params = new URLSearchParams({
            apikey: apiKey,
            language,
            category: category.split(',')[0] || 'business',
        });

        const newsRes = await fetch(`https://newsdata.io/api/1/latest?${params}`);
        const newsData = await newsRes.json();

        let fetched = 0, translatedCount = 0, rewrittenCount = 0;

        if (newsData.status === 'success' && newsData.results?.length) {
            const articles = newsData.results.slice(0, maxArticles);

            for (const article of articles) {
                const text = getArticleText(article);
                let summary = null, translation = null, translatedTitle = null, rewrittenTitle = null, rewrittenContent = null;

                if (autoSummary) {
                    try {
                        summary = await callClaude(`Based on the following news headline and brief description, write a clear and informative 2-3 sentence summary that expands on the key points. Do NOT say you cannot see the content or that it's unavailable. Work with what is provided.\n\nHeadline: ${article.title}\nDescription: ${article.description || ''}`);
                    } catch (e) { console.error('[Scheduler] Summarize error:', e.message); }
                }

                if (autoTranslate && translateTo) {
                    const lang = translateTo.split(',')[0];
                    if (lang && lang !== language) {
                        try {
                            const rawTranslation = await callClaude(`Translate the following news headline and description to ${lang}. Return ONLY a JSON object with the translated title and text. Do NOT add any commentary about missing content.\n\nTitle: ${article.title}\nDescription: ${article.description || ''}\n\nRespond in JSON: {"title":"translated title","text":"translated description"}`, 2048);
                            try {
                                const cleaned = rawTranslation.replace(/```json\n?|```/g, '').trim();
                                const parsed = JSON.parse(cleaned);
                                translatedTitle = parsed.title || null;
                                translation = parsed.text || parsed.description || rawTranslation;
                            } catch {
                                translation = rawTranslation;
                            }
                            translatedCount++;
                        } catch (e) { console.error('[Scheduler] Translate error:', e.message); }
                    }
                }

                if (autoRewrite) {
                    try {
                        const result = await callClaude(
                            `Rewrite the following news item as a unique, original article in ${rewriteStyle} style. Use the headline and description to create a complete, well-written paragraph. Do NOT mention that you only have a title or description — write as if you are a journalist covering this story.\n\nHeadline: ${article.title}\nDescription: ${article.description || ''}\n\nReturn JSON {"title":"...","content":"..."}`, 2048
                        );
                        try {
                            const cleaned = result.replace(/```json\n?|```/g, '').trim();
                            const parsed = JSON.parse(cleaned);
                            rewrittenTitle = parsed.title;
                            rewrittenContent = parsed.content;
                        } catch { rewrittenContent = result; }
                        rewrittenCount++;
                    } catch (e) { console.error('[Scheduler] Rewrite error:', e.message); }
                }

                try {
                    // Generate slug from title
                    const slug = article.title
                        ? article.title.toLowerCase()
                            .replace(/[^\w\s-]/g, '')
                            .replace(/\s+/g, '-')
                            .replace(/-+/g, '-')
                            .replace(/^-+|-+$/g, '')
                            .slice(0, 80) + '-' + Date.now().toString(36)
                        : 'article-' + Date.now().toString(36);

                    db.prepare(`
                        INSERT OR IGNORE INTO news_articles 
                        (source_id, slug, title, description, content, original_url, image_url, source_name,
                         category, language, country, published_at, sentiment, keywords,
                         ai_summary, ai_translation, ai_translated_title, ai_rewritten_title, ai_rewritten_content,
                         translate_language, is_processed)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(
                        article.article_id, slug, article.title, article.description, article.content,
                        article.link, article.image_url, article.source_name || article.source_id,
                        JSON.stringify(article.category), article.language, JSON.stringify(article.country),
                        article.pubDate, article.sentiment || null, JSON.stringify(article.keywords || []),
                        summary, translation, translatedTitle, rewrittenTitle, rewrittenContent,
                        translateTo ? translateTo.split(',')[0] : null,
                        (autoSummary || autoTranslate || autoRewrite) ? 1 : 0
                    );
                    fetched++;
                } catch (e) { console.error('[Scheduler] Save error:', e.message); }
            }
        }

        const duration = Date.now() - startTime;
        db.prepare(`
            INSERT INTO pipeline_logs (action, status, articles_fetched, articles_translated, articles_rewritten, duration_ms)
            VALUES ('scheduled_pipeline', 'success', ?, ?, ?, ?)
        `).run(fetched, translatedCount, rewrittenCount, duration);

        console.log(`[Scheduler] Pipeline complete: fetched=${fetched}, translated=${translatedCount}, rewritten=${rewrittenCount}, duration=${duration}ms`);

    } catch (err) {
        const duration = Date.now() - startTime;
        db.prepare(`
            INSERT INTO pipeline_logs (action, status, error_message, duration_ms)
            VALUES ('scheduled_pipeline', 'error', ?, ?)
        `).run(err.message, duration);

        console.error('[Scheduler] Pipeline error:', err.message);
    } finally {
        isRunning = false;
    }
}

export function startScheduler() {
    // Read interval from settings, default 1 hour
    const intervalMs = parseInt(getSetting('fetch_interval', '3600000'));

    console.log(`[Scheduler] Initialized. Checking every ${intervalMs / 1000}s for auto-fetch.`);

    // Check and run periodically
    intervalId = setInterval(() => {
        runPipeline().catch(err => console.error('[Scheduler] Unhandled error:', err));
    }, intervalMs);

    // Return control object
    return {
        stop: () => {
            if (intervalId) {
                clearInterval(intervalId);
                intervalId = null;
                console.log('[Scheduler] Stopped.');
            }
        },
        restart: () => {
            if (intervalId) clearInterval(intervalId);
            const newInterval = parseInt(getSetting('fetch_interval', '3600000'));
            intervalId = setInterval(() => {
                runPipeline().catch(err => console.error('[Scheduler] Unhandled error:', err));
            }, newInterval);
            console.log(`[Scheduler] Restarted with interval ${newInterval / 1000}s.`);
        },
    };
}
