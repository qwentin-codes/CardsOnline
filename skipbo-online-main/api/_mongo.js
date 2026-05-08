import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'online_card_games';

let cachedClient;
let cachedDb;

export async function getDb() {
  if (!uri) {
    throw new Error('Missing MONGODB_URI environment variable. Add it in Vercel Project Settings.');
  }
  if (cachedDb) return cachedDb;
  if (!cachedClient) {
    cachedClient = new MongoClient(uri);
    await cachedClient.connect();
  }
  cachedDb = cachedClient.db(dbName);
  await ensureIndexes(cachedDb);
  return cachedDb;
}

let indexed = false;
async function ensureIndexes(db) {
  if (indexed) return;
  indexed = true;
  await Promise.all([
    db.collection('rooms').createIndex({ code: 1 }, { unique: true }),
    db.collection('rooms').createIndex({ game_type: 1, updated_at: -1 }),
    db.collection('profiles').createIndex({ lowerName: 1 }, { unique: true }),
    db.collection('profiles').createIndex({ last_seen_at: -1 }),
    db.collection('game_records').createIndex({ profile_id: 1, ended_at: -1 }),
  ]);
}

export function json(res, status, body) {
  res.status(status).json(body);
}

export function safeDoc(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}
