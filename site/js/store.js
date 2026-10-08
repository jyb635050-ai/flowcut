// 本机存储：IndexedDB 存原始音频和工程，localStorage 存偏好。只在本机，不上传
const dbP = new Promise((res, rej) => {
  let r;
  try { r = indexedDB.open('flowcut', 1); } catch (e) { return rej(e); }
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(mode, fn) {
  const db = await dbP;
  return new Promise((res, rej) => {
    const t = db.transaction('kv', mode), req = fn(t.objectStore('kv'));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
export const idbGet = k => tx('readonly', s => s.get(k)).catch(() => undefined);
export const idbPut = (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => {});
export const idbDel = k => tx('readwrite', s => s.delete(k)).catch(() => {});
export const idbKeys = () => tx('readonly', s => s.getAllKeys()).catch(() => []);

export const pref = {
  get(k) { try { return localStorage.getItem('flowcut.' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('flowcut.' + k, v); } catch {} },
};
