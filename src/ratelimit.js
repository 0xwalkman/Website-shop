// Small in-memory rate limiter (per process). Old entries are pruned so memory stays bounded.
function createLimiter(windowMs) {
  const hits = new Map(); // key -> [timestamps]
  const recent = (key) => (hits.get(key) || []).filter((t) => Date.now() - t < windowMs);
  setInterval(() => {
    for (const [key, list] of hits) {
      const kept = list.filter((t) => Date.now() - t < windowMs);
      if (kept.length) hits.set(key, kept); else hits.delete(key);
    }
  }, Math.min(windowMs, 10 * 60 * 1000)).unref();
  return {
    // Records one hit and returns how many hits this key has in the window (including this one).
    hit(key) { const list = recent(key); list.push(Date.now()); hits.set(key, list); return list.length; },
    count(key) { return recent(key).length; },
    clear(key) { hits.delete(key); },
  };
}
module.exports = { createLimiter };
