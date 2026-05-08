// MongoDB-backed shared profile directory. The app still lets users type
// any display name, but optional profiles keep stats attached to a person
// across devices when MongoDB is configured in Vercel.

export const backendEnabled = true;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function listProfiles() {
  try {
    const data = await api('/api/profiles');
    return data.profiles || [];
  } catch (error) {
    console.warn('listProfiles failed', error);
    return [];
  }
}

export async function createProfile(name) {
  const clean = String(name || '').trim().slice(0, 20);
  if (!clean) return { ok: false, error: 'Please enter a name.' };
  try {
    const data = await api('/api/profiles', {
      method: 'POST',
      body: JSON.stringify({ op: 'create', name: clean }),
    });
    return { ok: true, profile: data.profile };
  } catch (error) {
    return { ok: false, error: error.message || 'Could not create profile.' };
  }
}

export async function touchProfile(id) {
  if (!id) return;
  try {
    await api('/api/profiles', {
      method: 'POST',
      body: JSON.stringify({ op: 'touch', id }),
    });
  } catch (error) {
    console.warn('touchProfile failed', error);
  }
}

export async function recordGameForProfile(profileId, record) {
  if (!profileId) return;
  try {
    await api('/api/profiles', {
      method: 'POST',
      body: JSON.stringify({ op: 'recordGame', profileId, record }),
    });
  } catch (error) {
    console.warn('recordGameForProfile failed', error);
  }
}

export async function fetchHistoryForProfile(profileId, { gameType, limit = 50 } = {}) {
  if (!profileId) return [];
  try {
    const data = await api('/api/profiles', {
      method: 'POST',
      body: JSON.stringify({ op: 'history', profileId, gameType, limit }),
    });
    return data.history || [];
  } catch (error) {
    console.warn('fetchHistoryForProfile failed', error);
    return [];
  }
}
