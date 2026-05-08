import { getDb, json, safeDoc } from './_mongo.js';

function id() {
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
function nowIso() { return new Date().toISOString(); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const db = await getDb();
    const profiles = db.collection('profiles');
    const records = db.collection('game_records');

    if (req.method === 'GET') {
      const list = await profiles.find({}).sort({ last_seen_at: -1 }).limit(100).toArray();
      return json(res, 200, { profiles: list.map(safeDoc) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    const body = req.body || {};
    const op = body.op;

    if (op === 'create') {
      const name = String(body.name || '').trim().slice(0, 20);
      if (!name) return json(res, 400, { error: 'Please enter a name.' });
      const lowerName = name.toLowerCase();
      const profile = { id: id(), name, lowerName, created_at: nowIso(), last_seen_at: nowIso() };
      try {
        await profiles.insertOne(profile);
      } catch (err) {
        if (err.code === 11000) return json(res, 409, { error: `"${name}" is already taken — choose a different name.` });
        throw err;
      }
      return json(res, 200, { profile: safeDoc(profile) });
    }

    if (op === 'touch') {
      if (body.id) await profiles.updateOne({ id: body.id }, { $set: { last_seen_at: nowIso() } });
      return json(res, 200, { ok: true });
    }

    if (op === 'recordGame') {
      const record = { ...(body.record || {}), profile_id: body.profileId, ended_at: body.record?.endedAt ? new Date(body.record.endedAt).toISOString() : nowIso() };
      if (record.profile_id) await records.insertOne(record);
      return json(res, 200, { ok: true });
    }

    if (op === 'history') {
      const filter = { profile_id: body.profileId };
      if (body.gameType) filter.game_type = body.gameType;
      const limit = Math.min(200, Math.max(1, Number(body.limit || 50)));
      const history = await records.find(filter).sort({ ended_at: -1 }).limit(limit).toArray();
      return json(res, 200, { history: history.map(safeDoc) });
    }

    return json(res, 400, { error: 'Unknown operation' });
  } catch (err) {
    return json(res, 500, { error: err.message || String(err) });
  }
}
