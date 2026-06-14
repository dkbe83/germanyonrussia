// /api/cron.js
// Runs daily at 05:00 UTC via Vercel Cron
// Fetches RSS → computes Overton sentiment → stores in Redis

import { createClient } from 'redis';

async function getRedisClient() {
  const client = createClient({ url: process.env.REDIS_URL });
  client.on('error', err => console.error('Redis error:', err));
  await client.connect();
  return client;
}


async function getRedditSentiment(client) {
  try {
    const raw = await client.get('reddit:sentiment');
    if (!raw) return null;
    const d = JSON.parse(raw);
    // Only use if from today
    if (d.date !== new Date().toISOString().slice(0, 10)) return null;
    return d;
  } catch (e) { return null; }
}

const RSS_SOURCES = [
  'https://www.tagesschau.de/xml/rss2/',
  'https://www.spiegel.de/schlagzeilen/tops/index.rss',
  'https://newsfeed.zeit.de/all',
  'https://www.faz.net/rss/aktuell/',
  'https://rss.sueddeutsche.de/rss/Politik',
  'https://www.fr.de/rssfeed.rss',
  'https://www.handelsblatt.com/contentexport/feed/schlagzeilen',
  'https://www.tagesspiegel.de/politik.rss',
  'https://www.welt.de/feeds/latest.rss',
  'https://www.nzz.ch/international.rss',
  'https://rss.focus.de/fol/XML/rss_folnews.xml',
  'https://www.berliner-zeitung.de/feed.rss',
  'https://rss.dw.com/rdf/rss-en-all',
  'https://feeds.bbci.co.uk/news/world/europe/rss.xml',
  'https://meduza.io/en/rss/all',
];

const RUSSIA_KW = [
  'russland','russisch','ukraine','putin','moskau','sanktion',
  'waffenstillstand','kriegsmüdigkeit','ostpolitik','wagner',
  'nordstream','lukaschenko','belarus','selenskyj','lawrow','medwedew',
  'annexion','donbass','donezk','luhansk','krim','kreml',
  'russia','russian','ukraine','ukrainian','putin','moscow','kremlin',
  'zelensky','zelenskyy','lavrov','crimea','donbas','bucha','mariupol',
  'kherson','zaporizhzhia','kharkiv','nordstream','wagner group','meduza',
  'russie','ukraine','poutine','kremlin',
];

const EXCLUDE_KW = [
  'iran','israel','gaza','hamas','lebanon','syrien','syria',
  'china','taiwan','nordkorea','north korea','afghanistan',
];

function isRussiaRelated(text) {
  const t = (text || '').toLowerCase();
  if(!RUSSIA_KW.some(k => t.includes(k))) return false;
  const excludeHits = EXCLUDE_KW.filter(k => t.includes(k)).length;
  const russiaHits = RUSSIA_KW.filter(k => t.includes(k)).length;
  if(excludeHits > russiaHits) return false;
  return true;
}

function sentimentScore(title, desc = '') {
  const t = (title + ' ' + desc).toLowerCase();
  const neg = ['angriff','attack','krieg','war','eskalation','escalat','drohne','drone',
    'rakete','missile','sanktion','sanction','verhaftet','arrested','tote','dead',
    'opfer','casualt','bombardier','offensive','invasion','conflict'];
  const pos = ['verhandlung','negotiat','waffenstillstand','ceasefire','frieden',
    'peace','dialog','einigung','agreement','diplomatie','diplomacy','gespräch'];
  const negHits = neg.filter(k => t.includes(k)).length;
  const posHits = pos.filter(k => t.includes(k)).length;
  if (negHits > posHits) return -1;
  if (posHits > negHits) return 1;
  return 0;
}

async function fetchRSSJson(url) {
  try {
    const proxy = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`;
    const r = await fetch(proxy, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const d = await r.json();
    if (d.status !== 'ok' || !d.items) return [];
    return d.items
      .filter(item => isRussiaRelated(item.title + ' ' + (item.description || '')))
      .map(item => ({
        title: item.title || '',
        desc: (item.description || '').replace(/<[^>]+>/g, '').slice(0, 200),
        date: item.pubDate || new Date().toISOString(),
        src: url,
        score: sentimentScore(item.title, item.description || ''),
      }));
  } catch (e) {
    return [];
  }
}

function computeOvIndex(articles) {
  if (!articles.length) return null;
  const now = Date.now();
  let wScore = 0, wTotal = 0;

  articles.forEach(a => {
    const ageH = (now - new Date(a.date).getTime()) / 3_600_000;
    const w = Math.exp(-ageH / 48); // exponential decay, 48h half-life
    wScore += a.score * w;
    wTotal += w;
  });

  if (wTotal === 0) return null;
  const rawSentiment = (wScore / wTotal + 1) / 2; // normalise -1..1 → 0..1

  // Map onto Overton center scale (historical baseline Jun 2025 = 45)
  const baseline = 45;
  const delta = (rawSentiment - 0.5) * 18;
  const center = Math.round(Math.max(15, Math.min(75, baseline + delta)));

  // Window width: wider = more diverse discourse
  const variance = articles.reduce((s, a) => s + Math.pow(a.score - (wScore / wTotal), 2), 0) / articles.length;
  const width = Math.round(Math.max(62, Math.min(90, 74 + variance * 18)));

  const neg = articles.filter(a => a.score === -1).length;
  const neu = articles.filter(a => a.score === 0).length;
  const pos = articles.filter(a => a.score === 1).length;

  return {
    center,
    width,
    sentiment: Math.round(rawSentiment * 100),
    articleCount: articles.length,
    neg, neu, pos,
    date: new Date().toISOString().slice(0, 10),
    ts: Date.now(),
  };
}

function blendWithReddit(ovData, redditSentiment) {
  if (!redditSentiment || redditSentiment.total < 3) return ovData;
  // Reddit = 20% weight, Media = 80% (polls handled separately)
  const redditRaw = (redditSentiment.pos - redditSentiment.neg) / redditSentiment.total;
  const redditCenter = Math.round(Math.max(15, Math.min(75, 45 + redditRaw * 18)));
  const blendedCenter = Math.round(ovData.center * 0.8 + redditCenter * 0.2);
  return {
    ...ovData,
    center: blendedCenter,
    redditSentiment: redditSentiment.avgScore,
    redditArticles: redditSentiment.total,
    sources: 'media+reddit',
  };
}

export default async function handler(req, res) {
  // Verify this is called by Vercel Cron or manually with secret
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('[cron] Starting daily Overton calculation...');

  // Fetch all RSS in parallel (max 15 at once)
  const batches = [];
  for (let i = 0; i < RSS_SOURCES.length; i += 5) {
    batches.push(RSS_SOURCES.slice(i, i + 5));
  }

  let allArticles = [];
  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map(fetchRSSJson));
    results.forEach(r => {
      if (r.status === 'fulfilled') allArticles = allArticles.concat(r.value);
    });
  }

  console.log(`[cron] Fetched ${allArticles.length} Russia-relevant articles`);

  let ovData = computeOvIndex(allArticles);
  if (!ovData) {
    return res.status(200).json({ ok: false, reason: 'No articles found' });
  }

  // Blend with Reddit sentiment (20% weight)
  const redditData = await getRedditSentiment(redisClient);
  ovData = blendWithReddit(ovData, redditData);
  console.log(`[cron] Reddit blend: ${redditData ? redditData.total + ' posts' : 'no data'}`);

  // Store in Redis
  let redisClient;
  try {
    redisClient = await getRedisClient();
    const dateKey = `overton:${ovData.date}`;
    await redisClient.set(dateKey, JSON.stringify(ovData), { EX: 60 * 60 * 24 * 400 });
    await redisClient.set('overton:latest', JSON.stringify(ovData), { EX: 60 * 60 * 24 * 400 });
    await redisClient.lPush('overton:series', JSON.stringify(ovData));
    await redisClient.lTrim('overton:series', 0, 399);
    await redisClient.quit();
  } catch (e) {
    console.error('[cron] Redis error:', e);
    if (redisClient) await redisClient.quit().catch(() => {});
    return res.status(500).json({ ok: false, error: 'Redis storage failed: ' + e.message });
  }

  console.log(`[cron] Stored Overton value: center=${ovData.center}, width=${ovData.width}`);

  return res.status(200).json({
    ok: true,
    date: ovData.date,
    center: ovData.center,
    width: ovData.width,
    sentiment: ovData.sentiment,
    articleCount: ovData.articleCount,
  });
}
