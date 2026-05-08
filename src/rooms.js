// MongoDB-backed public room list and room metadata helpers.
// On Vercel these calls go through /api/rooms, which stores data in MongoDB.

export const backendEnabled = true;

export const STALE_MS = 120_000;
export const HEARTBEAT_MS = 30_000;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function createRoom({ code, hostName, maxPlayers, gameType }) {
  try {
    await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        op: 'upsert',
        row: {
          code,
          host_name: hostName,
          player_count: 1,
          max_players: maxPlayers,
          started: false,
          game_type: gameType || 'skipbo',
          version: 0,
        },
      }),
    });
  } catch (error) {
    console.warn('createRoom failed', error);
  }
}

export async function updateRoom(code, patch) {
  try {
    await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ op: 'update', code, patch }),
    });
  } catch (error) {
    console.warn('updateRoom failed', error);
  }
}

export async function deleteRoom(code) {
  try {
    await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ op: 'delete', code }),
    });
  } catch (error) {
    console.warn('deleteRoom failed', error);
  }
}

export function subscribeOpenRooms(onRooms, gameType = 'skipbo') {
  let cancelled = false;
  let timer = null;

  async function load() {
    try {
      const data = await api(`/api/rooms?gameType=${encodeURIComponent(gameType)}`);
      if (!cancelled) onRooms(data.rooms || []);
    } catch (error) {
      console.warn('fetch rooms failed', error);
      if (!cancelled) onRooms([]);
    }
  }

  load();
  timer = setInterval(load, 5000);

  return () => {
    cancelled = true;
    if (timer) clearInterval(timer);
  };
}
