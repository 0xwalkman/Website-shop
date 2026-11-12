// Minimal express-session store backed by the app's SQLite database.
module.exports = function (session) {
  const DAY = 24 * 60 * 60 * 1000;

  class SqliteStore extends session.Store {
    constructor(db) {
      super();
      this.db = db;
      this.getStmt = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?');
      this.setStmt = db.prepare(
        'INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires'
      );
      this.delStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
      this.touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
      this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expires < ?');
      this.timer = setInterval(() => this.pruneStmt.run(Date.now()), 60 * 60 * 1000);
      this.timer.unref();
    }

    expiry(sess) {
      const e = sess && sess.cookie && sess.cookie.expires;
      return e ? new Date(e).getTime() : Date.now() + DAY;
    }

    get(sid, cb) {
      try {
        const row = this.getStmt.get(sid);
        if (!row || row.expires < Date.now()) return cb(null, null);
        cb(null, JSON.parse(row.data));
      } catch (err) { cb(err); }
    }

    set(sid, sess, cb) {
      try {
        this.setStmt.run(sid, JSON.stringify(sess), this.expiry(sess));
        cb && cb(null);
      } catch (err) { cb && cb(err); }
    }

    destroy(sid, cb) {
      try { this.delStmt.run(sid); cb && cb(null); } catch (err) { cb && cb(err); }
    }

    touch(sid, sess, cb) {
      try { this.touchStmt.run(this.expiry(sess), sid); cb && cb(null); } catch (err) { cb && cb(err); }
    }
  }

  return SqliteStore;
};
