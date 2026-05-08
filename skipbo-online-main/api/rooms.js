import { getDb, json, safeDoc } from './_mongo.js';

function nowIso() { return new Date().toISOString(); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const db = await getDb();
    const rooms = db.collection('rooms');

    if (req.method === 'GET') {
      const { code, gameType } = req.query;
      if (code) {
        const row = await rooms.findOne({ code: String(code).toUpperCase() });
        return json(res, 200, { row: safeDoc(row) });
      }
      const cutoff = new Date(Date.now() - 120_000).toISOString();
      const filter = { updated_at: { $gte: cutoff } };
      if (gameType) filter.game_type = String(gameType);
      const list = await rooms.find(filter).sort({ started: 1, updated_at: -1 }).limit(40).toArray();
      return json(res, 200, { rooms: list.map(safeDoc) });
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    const body = req.body || {};
    const op = body.op;

    if (op === 'upsert') {
      const row = { ...(body.row || {}), updated_at: nowIso() };
      if (!row.code) return json(res, 400, { error: 'Missing room code' });
      row.code = String(row.code).toUpperCase();
      await rooms.updateOne({ code: row.code }, { $set: row }, { upsert: true });
      const saved = await rooms.findOne({ code: row.code });
      return json(res, 200, { row: safeDoc(saved) });
    }

    if (op === 'update') {
      const code = String(body.code || '').toUpperCase();
      if (!code) return json(res, 400, { error: 'Missing room code' });
      await rooms.updateOne({ code }, { $set: { ...(body.patch || {}), updated_at: nowIso() } });
      const saved = await rooms.findOne({ code });
      return json(res, 200, { row: safeDoc(saved) });
    }

    if (op === 'delete') {
      const code = String(body.code || '').toUpperCase();
      if (!code) return json(res, 400, { error: 'Missing room code' });
      await rooms.deleteOne({ code });
      return json(res, 200, { ok: true });
    }

    if (op === 'atomicUpdate') {
      const code = String(body.code || '').toUpperCase();
      const expectedVersion = body.expectedVersion;
      if (!code) return json(res, 400, { error: 'Missing room code' });
      const filter = { code };
      if (expectedVersion !== null && expectedVersion !== undefined) filter.version = expectedVersion;
      const result = await rooms.findOneAndUpdate(
        filter,
        { $set: { ...(body.patch || {}), updated_at: nowIso() } },
        { returnDocument: 'after' },
      );
      return json(res, 200, { row: safeDoc(result.value) });
    }

    if (op === 'appendChat') {
      const code = String(body.code || '').toUpperCase();
      const msg = body.message;
      if (!code || !msg) return json(res, 400, { error: 'Missing chat payload' });
      await rooms.updateOne(
        { code },
        { $push: { chat: { $each: [msg], $slice: -100 } }, $set: { updated_at: nowIso() } },
      );
      const saved = await rooms.findOne({ code });
      return json(res, 200, { row: safeDoc(saved) });
    }

    return json(res, 400, { error: 'Unknown operation' });
  } catch (err) {
    return json(res, 500, { error: err.message || String(err) });
  }
}
