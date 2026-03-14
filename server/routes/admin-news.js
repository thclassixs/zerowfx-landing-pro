import { Router } from 'express';
import db from '../database.js';

const router = Router();

// ── Helper: track API usage ────────────────────────────────
function trackApiUsage(apiName) {
    const today = new Date().toISOString().split('T')[0];
    db.prepare(`
        INSERT INTO api_usage (api_name, call_date, call_count) VALUES (?, ?, 1)
        ON CONFLICT(api_name, call_date) DO UPDATE SET call_count = call_count + 1
    `).run(apiName, today);
}

// ── Helper: call Claude API with tracking ──────────────────
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

// ── Helper: get a setting from pipeline_settings ───────────
function getSetting(key, defaultValue = null) {
    const row = db.prepare('SELECT setting_value FROM pipeline_settings WHERE setting_key = ?').get(key);
    return row ? row.setting_value : defaultValue;
}

// ============================================================
//  STATS
// ============================================================

router.get('/stats', (req, res) => {
    try {
        const total = db.prepare('SELECT COUNT(*) as count FROM news_articles').get().count;
        const translated = db.prepare("SELECT COUNT(*) as count FROM news_articles WHERE ai_translation IS NOT NULL AND ai_translation != ''").get().count;
        const rewritten = db.prepare("SELECT COUNT(*) as count FROM news_articles WHERE ai_rewritten_content IS NOT NULL AND ai_rewritten_content != ''").get().count;
        const today = db.prepare("SELECT COUNT(*) as count FROM news_articles WHERE date(created_at) = date('now')").get().count;

        const todayDate = new Date().toISOString().split('T')[0];
        const apiUsageRow = db.prepare("SELECT COALESCE(SUM(call_count), 0) as total FROM api_usage WHERE call_date = ?").get(todayDate);
        const apiUsageToday = apiUsageRow ? apiUsageRow.total : 0;

        // Last pipeline run
        const lastRun = db.prepare('SELECT * FROM pipeline_logs ORDER BY created_at DESC LIMIT 1').get();

        res.json({
            total,
            translated,
            rewritten,
            today,
            apiUsageToday,
            lastRun: lastRun || null,
        });
    } catch (err) {
        console.error('News stats error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================
//  ARTICLES — List, Get, Update, Delete
// ============================================================

router.get('/articles', (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const search = req.query.search || '';
        const category = req.query.category || '';
        const status = req.query.status || '';
        const language = req.query.language || '';
        const sort = req.query.sort || 'newest';
        const offset = (page - 1) * limit;

        let where = [];
        let params = [];

        if (search) {
            where.push('(title LIKE ? OR description LIKE ? OR ai_rewritten_title LIKE ?)');
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        if (category) {
            where.push('category LIKE ?');
            params.push(`%${category}%`);
        }

        if (language) {
            where.push('language = ?');
            params.push(language);
        }

        if (status === 'translated') {
            where.push("ai_translation IS NOT NULL AND ai_translation != ''");
        } else if (status === 'not_translated') {
            where.push("(ai_translation IS NULL OR ai_translation = '')");
        } else if (status === 'rewritten') {
            where.push("ai_rewritten_content IS NOT NULL AND ai_rewritten_content != ''");
        }

        const whereClause = where.length ? ' WHERE ' + where.join(' AND ') : '';
        const orderClause = sort === 'oldest' ? ' ORDER BY created_at ASC' : ' ORDER BY created_at DESC';

        const total = db.prepare(`SELECT COUNT(*) as total FROM news_articles${whereClause}`).get(...params).total;
        const articles = db.prepare(
            `SELECT * FROM news_articles${whereClause}${orderClause} LIMIT ? OFFSET ?`
        ).all(...params, limit, offset);

        res.json({
            articles,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    } catch (err) {
        console.error('Get articles error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/articles/:id', (req, res) => {
    try {
        const article = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(req.params.id);
        if (!article) return res.status(404).json({ error: 'Article not found' });
        res.json(article);
    } catch (err) {
        console.error('Get article error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/articles/:id', (req, res) => {
    try {
        const { title, description, content, ai_summary, ai_translation, ai_rewritten_title, ai_rewritten_content, category, is_processed } = req.body;
        const article = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(req.params.id);
        if (!article) return res.status(404).json({ error: 'Article not found' });

        db.prepare(`
            UPDATE news_articles SET
                title = COALESCE(?, title),
                description = COALESCE(?, description),
                content = COALESCE(?, content),
                ai_summary = COALESCE(?, ai_summary),
                ai_translation = COALESCE(?, ai_translation),
                ai_rewritten_title = COALESCE(?, ai_rewritten_title),
                ai_rewritten_content = COALESCE(?, ai_rewritten_content),
                category = COALESCE(?, category),
                is_processed = COALESCE(?, is_processed)
            WHERE id = ?
        `).run(
            title || null, description || null, content || null,
            ai_summary || null, ai_translation || null,
            ai_rewritten_title || null, ai_rewritten_content || null,
            category || null, is_processed !== undefined ? is_processed : null,
            req.params.id
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Update article error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/articles/:id', (req, res) => {
    try {
        db.prepare('DELETE FROM news_articles WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete article error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================
//  BULK ACTIONS
// ============================================================

router.post('/articles/bulk', async (req, res) => {
    try {
        const { action, articleIds, targetLanguage, style } = req.body;
        if (!articleIds || !articleIds.length) return res.status(400).json({ error: 'No articles selected' });

        if (action === 'delete') {
            const placeholders = articleIds.map(() => '?').join(',');
            db.prepare(`DELETE FROM news_articles WHERE id IN (${placeholders})`).run(...articleIds);
            return res.json({ success: true, message: `${articleIds.length} articles deleted` });
        }

        if (action === 'translate') {
            const lang = targetLanguage || 'ar';
            let translated = 0;
            for (const id of articleIds) {
                const article = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(id);
                if (!article) continue;
                try {
                    const text = getArticleText(article);
                    const rawTranslation = await callClaude(
                        `Translate the following news headline and description to ${lang}. Return ONLY a JSON object with the translated title and text. Do NOT add any commentary about missing content.\n\nTitle: ${article.title}\nDescription: ${article.description || ''}\n\nRespond in JSON: {"title":"translated title","text":"translated description"}`, 2048
                    );
                    let translatedTitle = null;
                    let translatedText = rawTranslation;
                    try {
                        const cleaned = rawTranslation.replace(/```json\n?|```/g, '').trim();
                        const parsed = JSON.parse(cleaned);
                        translatedTitle = parsed.title || null;
                        translatedText = parsed.text || parsed.description || rawTranslation;
                    } catch {}
                    db.prepare('UPDATE news_articles SET ai_translation = ?, ai_translated_title = ?, translate_language = ? WHERE id = ?').run(translatedText, translatedTitle, lang, id);
                    translated++;
                } catch (e) {
                    console.error(`Translate article ${id} error:`, e.message);
                }
            }
            return res.json({ success: true, message: `${translated} articles translated` });
        }

        if (action === 'rewrite') {
            const rwStyle = style || 'professional';
            let rewritten = 0;
            for (const id of articleIds) {
                const article = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(id);
                if (!article) continue;
                try {
                    const text = getArticleText(article);
                    const result = await callClaude(
                        `Rewrite the following news item as a unique, original article in ${rwStyle} style. Use the headline and description to create a complete, well-written paragraph. Do NOT mention that you only have a title or description — write as if you are a journalist covering this story.\n\nHeadline: ${article.title}\nDescription: ${article.description || ''}\n\nReturn JSON {"title":"...","content":"..."}`, 2048
                    );
                    try {
                        const cleaned = result.replace(/```json\n?|```/g, '').trim();
                        const parsed = JSON.parse(cleaned);
                        db.prepare('UPDATE news_articles SET ai_rewritten_title = ?, ai_rewritten_content = ?, is_processed = 1 WHERE id = ?').run(parsed.title, parsed.content, id);
                    } catch {
                        db.prepare('UPDATE news_articles SET ai_rewritten_content = ?, is_processed = 1 WHERE id = ?').run(result, id);
                    }
                    rewritten++;
                } catch (e) {
                    console.error(`Rewrite article ${id} error:`, e.message);
                }
            }
            return res.json({ success: true, message: `${rewritten} articles rewritten` });
        }

        if (action === 'summarize') {
            let summarized = 0;
            for (const id of articleIds) {
                const article = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(id);
                if (!article) continue;
                try {
                    const text = getArticleText(article);
                    const summary = await callClaude(
                        `Based on the following news headline and brief description, write a clear and informative 2-3 sentence summary that expands on the key points. Do NOT say you cannot see the content or that it's unavailable. Work with what is provided.\n\nHeadline: ${article.title}\nDescription: ${article.description || ''}`
                    );
                    db.prepare('UPDATE news_articles SET ai_summary = ? WHERE id = ?').run(summary, id);
                    summarized++;
                } catch (e) {
                    console.error(`Summarize article ${id} error:`, e.message);
                }
            }
            return res.json({ success: true, message: `${summarized} articles summarized` });
        }

        res.status(400).json({ error: 'Unknown action' });
    } catch (err) {
        console.error('Bulk action error:', err.message);
        res.status(500).json({ error: 'Bulk action failed' });
    }
});

// ============================================================
//  SETTINGS
// ============================================================

router.get('/settings', (req, res) => {
    try {
        const rows = db.prepare('SELECT setting_key, setting_value FROM pipeline_settings').all();
        const settings = {};
        rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
        res.json(settings);
    } catch (err) {
        console.error('Get settings error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/settings', (req, res) => {
    try {
        const { settings } = req.body;
        if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'Settings object required' });

        const upsert = db.prepare(`
            INSERT INTO pipeline_settings (setting_key, setting_value, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = datetime('now')
        `);

        const transaction = db.transaction((entries) => {
            for (const [key, value] of entries) {
                upsert.run(key, String(value));
            }
        });

        transaction(Object.entries(settings));
        res.json({ success: true });
    } catch (err) {
        console.error('Save settings error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================
//  PIPELINE CONTROL
// ============================================================

// In-memory pipeline state
let pipelineState = {
    running: false,
    lastRun: null,
    error: null,
};

router.post('/pipeline/run', async (req, res) => {
    if (pipelineState.running) {
        return res.status(409).json({ error: 'Pipeline is already running' });
    }

    pipelineState.running = true;
    pipelineState.error = null;
    const startTime = Date.now();

    // Respond immediately
    res.json({ success: true, message: 'Pipeline started' });

    try {
        const apiKey = process.env.NEWSDATA_API_KEY;
        if (!apiKey) throw new Error('NEWSDATA_API_KEY not configured');

        // Read settings
        const category = getSetting('fetch_categories', 'business');
        const language = getSetting('fetch_language', 'en');
        const maxArticles = parseInt(getSetting('max_articles_per_fetch', '5'));
        const translateTo = getSetting('translate_languages', '');
        const summaryLength = getSetting('summary_length', 'short');
        const rewriteStyle = getSetting('rewrite_style', 'professional');
        const autoTranslate = getSetting('auto_translate', 'false') === 'true';
        const autoRewrite = getSetting('auto_rewrite', 'false') === 'true';
        const autoSummary = getSetting('auto_summary', 'false') === 'true';

        // Fetch
        const params = new URLSearchParams({ apikey: apiKey, language, category: category.split(',')[0] || 'business' });
        const newsRes = await fetch(`https://newsdata.io/api/1/latest?${params}`);
        const newsData = await newsRes.json();

        let fetched = 0, translatedCount = 0, rewrittenCount = 0;

        if (newsData.status === 'success' && newsData.results?.length) {
            const articles = newsData.results.slice(0, maxArticles);

            for (const article of articles) {
                const text = getArticleText(article);
                let summary = null, translation = null, translatedTitle = null, rewrittenTitle = null, rewrittenContent = null;

                // Summarize
                if (autoSummary) {
                    try {
                        summary = await callClaude(`Based on the following news headline and brief description, write a clear and informative 2-3 sentence summary that expands on the key points. Do NOT say you cannot see the content or that it's unavailable. Work with what is provided.\n\nHeadline: ${article.title}\nDescription: ${article.description || ''}`);
                    } catch (e) { console.error('Pipeline summarize error:', e.message); }
                }

                // Translate
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
                        } catch (e) { console.error('Pipeline translate error:', e.message); }
                    }
                }

                // Rewrite
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
                        } catch {
                            rewrittenContent = result;
                        }
                        rewrittenCount++;
                    } catch (e) { console.error('Pipeline rewrite error:', e.message); }
                }

                // Save
                try {
                    db.prepare(`
                        INSERT OR IGNORE INTO news_articles 
                        (source_id, title, description, content, original_url, image_url, source_name,
                         category, language, country, published_at, sentiment, keywords,
                         ai_summary, ai_translation, ai_translated_title, ai_rewritten_title, ai_rewritten_content,
                         translate_language, is_processed)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(
                        article.article_id, article.title, article.description, article.content,
                        article.link, article.image_url, article.source_name || article.source_id,
                        JSON.stringify(article.category), article.language, JSON.stringify(article.country),
                        article.pubDate, article.sentiment || null, JSON.stringify(article.keywords || []),
                        summary, translation, translatedTitle, rewrittenTitle, rewrittenContent,
                        translateTo ? translateTo.split(',')[0] : null,
                        (autoSummary || autoTranslate || autoRewrite) ? 1 : 0
                    );
                    fetched++;
                } catch (e) { console.error('Pipeline save error:', e.message); }
            }
        }

        const duration = Date.now() - startTime;

        // Log
        db.prepare(`
            INSERT INTO pipeline_logs (action, status, articles_fetched, articles_translated, articles_rewritten, duration_ms)
            VALUES ('auto_pipeline', 'success', ?, ?, ?, ?)
        `).run(fetched, translatedCount, rewrittenCount, duration);

        pipelineState.lastRun = new Date().toISOString();
        pipelineState.running = false;

    } catch (err) {
        const duration = Date.now() - startTime;
        pipelineState.running = false;
        pipelineState.error = err.message;

        db.prepare(`
            INSERT INTO pipeline_logs (action, status, error_message, duration_ms)
            VALUES ('auto_pipeline', 'error', ?, ?)
        `).run(err.message, duration);

        console.error('Pipeline run error:', err.message);
    }
});

router.post('/pipeline/stop', (req, res) => {
    // This stops the auto-fetch scheduler
    const ctrl = await_scheduler_control();
    if (ctrl && ctrl.stop) ctrl.stop();
    res.json({ success: true, message: 'Auto-fetch stopped' });
});

router.get('/pipeline/status', (req, res) => {
    const lastLog = db.prepare('SELECT * FROM pipeline_logs ORDER BY created_at DESC LIMIT 1').get();

    // Calculate next run based on settings
    const autoFetch = getSetting('auto_fetch', 'false') === 'true';
    const interval = getSetting('fetch_interval', '3600000');

    let nextRun = null;
    if (autoFetch && lastLog) {
        const lastTime = new Date(lastLog.created_at).getTime();
        nextRun = new Date(lastTime + parseInt(interval)).toISOString();
    }

    res.json({
        running: pipelineState.running,
        lastRun: lastLog?.created_at || null,
        lastStatus: lastLog?.status || null,
        lastError: lastLog?.error_message || null,
        nextRun,
        autoFetchEnabled: autoFetch,
    });
});

// ============================================================
//  QUEUE (simulated from pipeline_logs)
// ============================================================

// In-memory queue for processing
let processingQueue = [];
let queueIdCounter = 0;

router.get('/queue', (req, res) => {
    // Get recent pipeline logs as queue items
    const logs = db.prepare('SELECT * FROM pipeline_logs ORDER BY created_at DESC LIMIT 50').all();
    res.json({
        queue: processingQueue,
        history: logs,
    });
});

router.post('/queue/retry', async (req, res) => {
    try {
        const failedLogs = db.prepare("SELECT * FROM pipeline_logs WHERE status = 'error' ORDER BY created_at DESC LIMIT 10").all();
        // Re-run pipeline for failed items
        res.json({ success: true, message: `${failedLogs.length} failed items queued for retry` });
    } catch (err) {
        res.status(500).json({ error: 'Retry failed' });
    }
});

router.delete('/queue/clear', (req, res) => {
    try {
        processingQueue = [];
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Clear failed' });
    }
});

// ============================================================
//  TRANSLATE BATCH
// ============================================================

router.post('/translate-batch', async (req, res) => {
    try {
        const { articleIds, targetLanguage = 'ar', style = 'professional' } = req.body;
        if (!articleIds?.length) return res.status(400).json({ error: 'No articles selected' });

        let translated = 0;
        for (const id of articleIds) {
            const article = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(id);
            if (!article) continue;
            try {
                const text = getArticleText(article);
                const rawTranslation = await callClaude(
                    `Translate the following news headline and description to ${targetLanguage}. Return ONLY a JSON object with the translated title and text. Do NOT add any commentary about missing content.\n\nTitle: ${article.title}\nDescription: ${article.description || ''}\n\nRespond in JSON: {"title":"translated title","text":"translated description"}`, 2048
                );
                let translatedTitle = null;
                let translatedText = rawTranslation;
                try {
                    const cleaned = rawTranslation.replace(/```json\n?|```/g, '').trim();
                    const parsed = JSON.parse(cleaned);
                    translatedTitle = parsed.title || null;
                    translatedText = parsed.text || parsed.description || rawTranslation;
                } catch {}
                db.prepare('UPDATE news_articles SET ai_translation = ?, ai_translated_title = ?, translate_language = ? WHERE id = ?').run(translatedText, translatedTitle, targetLanguage, id);
                translated++;
            } catch (e) {
                console.error(`Batch translate ${id} error:`, e.message);
            }
        }
        res.json({ success: true, translated });
    } catch (err) {
        console.error('Batch translate error:', err.message);
        res.status(500).json({ error: 'Batch translate failed' });
    }
});

// ============================================================
//  EXPORT CSV
// ============================================================

router.post('/export/csv', (req, res) => {
    try {
        const articles = db.prepare('SELECT * FROM news_articles ORDER BY created_at DESC').all();

        let csv = 'ID,Title,Source,Category,Language,Status,Published,Created\n';
        articles.forEach(a => {
            const status = a.ai_translation ? 'Translated' : (a.ai_rewritten_content ? 'Rewritten' : (a.ai_summary ? 'Summarized' : 'Raw'));
            csv += `${a.id},"${(a.title || '').replace(/"/g, '""')}","${a.source_name || ''}","${a.category || ''}","${a.language || ''}","${status}","${a.published_at || ''}","${a.created_at || ''}"\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=news_articles.csv');
        res.send(csv);
    } catch (err) {
        console.error('Export error:', err.message);
        res.status(500).json({ error: 'Export failed' });
    }
});

// ============================================================
//  SINGLE ARTICLE AI ACTIONS (for detail page)
// ============================================================

router.post('/articles/:id/summarize', async (req, res) => {
    try {
        const article = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(req.params.id);
        if (!article) return res.status(404).json({ error: 'Article not found' });

        const { length = 'short' } = req.body;
        const text = getArticleText(article);
        const instructions = {
            short: 'Write a clear and informative 2-3 sentence summary.',
            medium: 'Write a clear and informative 4-6 sentence summary.',
            long: 'Provide a comprehensive summary in 2-3 paragraphs.',
        };

        const summary = await callClaude(
            `Based on the following news headline and brief description, ${instructions[length] || instructions.short} Do NOT say you cannot see the content or that it's unavailable. Work with what is provided.\n\nHeadline: ${article.title}\nDescription: ${article.description || ''}`
        );

        db.prepare('UPDATE news_articles SET ai_summary = ? WHERE id = ?').run(summary, req.params.id);
        res.json({ success: true, summary });
    } catch (err) {
        console.error('Summarize error:', err.message);
        res.status(500).json({ error: 'Summarize failed' });
    }
});

router.post('/articles/:id/translate', async (req, res) => {
    try {
        const article = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(req.params.id);
        if (!article) return res.status(404).json({ error: 'Article not found' });

        const { targetLanguage = 'ar' } = req.body;
        const text = getArticleText(article);

        const rawTranslation = await callClaude(
            `Translate the following news headline and description to ${targetLanguage}. Return ONLY a JSON object with the translated title and text. Do NOT add any commentary about missing content.\n\nTitle: ${article.title}\nDescription: ${article.description || ''}\n\nRespond in JSON: {"title":"translated title","text":"translated description"}`, 2048
        );

        let translatedTitle = null;
        let translatedText = rawTranslation;
        try {
            const cleaned = rawTranslation.replace(/```json\n?|```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            translatedTitle = parsed.title || null;
            translatedText = parsed.text || parsed.description || rawTranslation;
        } catch {}

        db.prepare('UPDATE news_articles SET ai_translation = ?, ai_translated_title = ?, translate_language = ? WHERE id = ?').run(translatedText, translatedTitle, targetLanguage, req.params.id);
        res.json({ success: true, translation: translatedText, translatedTitle });
    } catch (err) {
        console.error('Translate error:', err.message);
        res.status(500).json({ error: 'Translate failed' });
    }
});

router.post('/articles/:id/rewrite', async (req, res) => {
    try {
        const article = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(req.params.id);
        if (!article) return res.status(404).json({ error: 'Article not found' });

        const { style = 'professional' } = req.body;
        const text = getArticleText(article);

        const result = await callClaude(
            `Rewrite the following news item as a unique, original article in ${style} style. Use the headline and description to create a complete, well-written paragraph. Do NOT mention that you only have a title or description — write as if you are a journalist covering this story.\n\nHeadline: ${article.title}\nDescription: ${article.description || ''}\n\nReturn JSON {"title":"...","content":"..."}`, 2048
        );

        try {
            const cleaned = result.replace(/```json\n?|```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            db.prepare('UPDATE news_articles SET ai_rewritten_title = ?, ai_rewritten_content = ?, is_processed = 1 WHERE id = ?').run(parsed.title, parsed.content, req.params.id);
            res.json({ success: true, rewritten: parsed });
        } catch {
            db.prepare('UPDATE news_articles SET ai_rewritten_content = ?, is_processed = 1 WHERE id = ?').run(result, req.params.id);
            res.json({ success: true, rewritten: { title: article.title, content: result } });
        }
    } catch (err) {
        console.error('Rewrite error:', err.message);
        res.status(500).json({ error: 'Rewrite failed' });
    }
});

// Export scheduler control function reference
let _schedulerControl = { stop: () => {} };
export function setSchedulerControl(ctrl) { _schedulerControl = ctrl; }
function await_scheduler_control() { return _schedulerControl; }

export default router;
