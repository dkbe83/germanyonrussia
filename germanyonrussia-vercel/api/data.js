// /api/data.js
// Returns stored Overton time series from Vercel KV
// Called by the frontend on every page load

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600'); // cache 5 min

  try {
    const { type = 'series' } = req.query;

    if (type === 'latest') {
      // Just the latest computed value
      const latest = await kv.get('overton:latest');
      return res.status(200).json({ ok: true, data: latest });
    }

    if (type === 'series') {
      // Full time series, newest first
      const raw = await kv.lrange('overton:series', 0, 399);
      const series = raw
        .map(item => {
          try { return typeof item === 'string' ? JSON.parse(item) : item; }
          catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => new Date(a.date) - new Date(b.date)); // oldest first for chart

      return res.status(200).json({ ok: true, count: series.length, data: series });
    }

    return res.status(400).json({ ok: false, error: 'Unknown type' });

  } catch (e) {
    console.error('[api/data]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
