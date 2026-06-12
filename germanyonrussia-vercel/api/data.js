// /api/data.js
// Returns stored Overton time series from Redis Cloud
// Called by the frontend on every page load

import { createClient } from 'redis';

async function getRedisClient() {
  const client = createClient({ url: process.env.REDIS_URL });
  client.on('error', err => console.error('Redis error:', err));
  await client.connect();
  return client;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  let redisClient;
  try {
    const { type = 'series' } = req.query;
    redisClient = await getRedisClient();

    if (type === 'latest') {
      const raw = await redisClient.get('overton:latest');
      await redisClient.quit();
      const data = raw ? JSON.parse(raw) : null;
      return res.status(200).json({ ok: true, data });
    }

    if (type === 'series') {
      const raw = await redisClient.lRange('overton:series', 0, 399);
      await redisClient.quit();
      const series = raw
        .map(item => { try { return JSON.parse(item); } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      return res.status(200).json({ ok: true, count: series.length, data: series });
    }

    await redisClient.quit();
    return res.status(400).json({ ok: false, error: 'Unknown type' });

  } catch (e) {
    console.error('[api/data]', e);
    if (redisClient) await redisClient.quit().catch(() => {});
    return res.status(500).json({ ok: false, error: e.message });
  }
}
