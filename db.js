// ===== CAPA DE DATOS - DEDITOS =====
// Dos modos con la MISMA interfaz async:
//  - Con DATABASE_URL  → PostgreSQL (persistente: cuentas, EXP, amigos, sesiones)
//  - Sin DATABASE_URL  → memoria (desarrollo y pruebas; no rompe nada)
//
// Uso:  const db = require('./db')(process.env.DATABASE_URL);

const crypto = require('crypto');

const EXPIRACION_SESION_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

function crearCapaDatos(url) {
  const esPersistente = !!url;

  // ================= MEMORIA =================
  if (!esPersistente) {
    const users = {};           // { username: {passwordHash, exp, nivel, codigo, friends[]} }
    const requests = {};        // { para: [{de, estado, fecha}] }
    const sessions = {};        // { token: {username, creado} }

    return {
      esPersistente: () => false,

      async init() { /* memoria: no hay tablas que crear */ },

      async getUser(username) {
        const u = users[username];
        if (!u) return null;
        return {
          username,
          passwordHash: u.passwordHash,
          exp: u.exp,
          nivel: u.nivel,
          codigo: u.codigo,
          friends: [...u.friends],
          racha: u.racha || 0,
          mejorRacha: u.mejorRacha || 0
        };
      },

      async getUserByCodigo(codigo) {
        const nombre = Object.keys(users).find(n => users[n].codigo === codigo);
        return nombre ? { username: nombre, codigo } : null;
      },

      async codigoEnUso(codigo) {
        return Object.values(users).some(u => u.codigo === codigo);
      },

      async createUser(username, passwordHash, codigo) {
        users[username] = { passwordHash, exp: 0, nivel: 1, codigo, friends: [], racha: 0, mejorRacha: 0 };
        return { username, passwordHash, exp: 0, nivel: 1, codigo, friends: [], racha: 0, mejorRacha: 0 };
      },

      async updateUser(username, campos) {
        const u = users[username];
        if (!u) return;
        if (campos.exp !== undefined) u.exp = campos.exp;
        if (campos.nivel !== undefined) u.nivel = campos.nivel;
        if (campos.friends !== undefined) u.friends = [...campos.friends];
        if (campos.racha !== undefined) u.racha = campos.racha;
        if (campos.mejorRacha !== undefined) u.mejorRacha = campos.mejorRacha;
      },

      async addFriendMutual(a, b) {
        if (users[a] && !users[a].friends.includes(b)) users[a].friends.push(b);
        if (users[b] && !users[b].friends.includes(a)) users[b].friends.push(a);
      },

      async getRequest(de, para) {
        const r = (requests[para] || []).find(x => x.de === de && x.estado === 'pendiente');
        return r ? { de: r.de, para, estado: r.estado } : null;
      },

      async addRequest(de, para) {
        if (!requests[para]) requests[para] = [];
        if (!requests[para].some(x => x.de === de && x.estado === 'pendiente')) {
          requests[para].push({ de, estado: 'pendiente', fecha: new Date() });
        }
      },

      async deleteRequest(de, para) {
        if (!requests[para]) return;
        requests[para] = requests[para].filter(x => x.de !== de);
      },

      async listRequests(para) {
        return (requests[para] || []).filter(x => x.estado === 'pendiente').map(x => ({ de: x.de }));
      },

      async countUsers() {
        return Object.keys(users).length;
      },

      async createSession(username) {
        const token = crypto.randomBytes(32).toString('hex');
        sessions[token] = { username, creado: Date.now() };
        return token;
      },

      async getSession(token) {
        const s = sessions[token];
        if (!s) return null;
        if (Date.now() - s.creado > EXPIRACION_SESION_MS) {
          delete sessions[token];
          return null;
        }
        return { username: s.username };
      },

      async deleteSession(token) {
        delete sessions[token];
      },

      async getAllUsersForRanking() {
        const resultado = {};
        Object.keys(users).forEach(n => {
          resultado[n] = { exp: users[n].exp, nivel: users[n].nivel, racha: users[n].racha || 0, mejorRacha: users[n].mejorRacha || 0 };
        });
        return resultado;
      },

      // Solo para pruebas automatizadas: limpia datos de test
      async borrarUsuariosTest(prefijo) {
        Object.keys(users).forEach(n => { if (n.startsWith(prefijo)) delete users[n]; });
        Object.keys(requests).forEach(p => {
          requests[p] = requests[p].filter(x => !x.de.startsWith(prefijo));
          if (requests[p].length === 0) delete requests[p];
        });
        Object.keys(sessions).forEach(t => { if (sessions[t].username.startsWith(prefijo)) delete sessions[t]; });
      }
    };
  }

  // ================= POSTGRESQL =================
  const { Pool } = require('pg');
  const esLocal = /localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: esLocal ? false : { rejectUnauthorized: false },
    max: 5
  });

  const TABLAS = `
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      exp INTEGER NOT NULL DEFAULT 0,
      nivel INTEGER NOT NULL DEFAULT 1,
      codigo TEXT NOT NULL UNIQUE,
      friends TEXT NOT NULL DEFAULT '[]',
      creado TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS friend_requests (
      id SERIAL PRIMARY KEY,
      de TEXT NOT NULL,
      para TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      fecha TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(de, para)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      creado TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS racha INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mejor_racha INTEGER NOT NULL DEFAULT 0;
  `;

  function parseFriends(json) {
    try { const arr = JSON.parse(json); return Array.isArray(arr) ? arr : []; }
    catch { return []; }
  }

  return {
    esPersistente: () => true,

    async init() {
      await pool.query(TABLAS);
    },

    async getUser(username) {
      const r = await pool.query(
        'SELECT username, password_hash, exp, nivel, codigo, friends, racha, mejor_racha AS "mejorRacha" FROM users WHERE username = $1',
        [username]
      );
      if (r.rows.length === 0) return null;
      const f = r.rows[0];
      return {
        username: f.username,
        passwordHash: f.password_hash,
        exp: f.exp,
        nivel: f.nivel,
        codigo: f.codigo,
        friends: parseFriends(f.friends),
        racha: f.racha,
        mejorRacha: f.mejorRacha
      };
    },

    async getUserByCodigo(codigo) {
      const r = await pool.query(
        'SELECT username, codigo FROM users WHERE codigo = $1',
        [codigo]
      );
      return r.rows.length ? { username: r.rows[0].username, codigo: r.rows[0].codigo } : null;
    },

    async codigoEnUso(codigo) {
      const r = await pool.query('SELECT 1 FROM users WHERE codigo = $1', [codigo]);
      return r.rows.length > 0;
    },

      async createUser(username, passwordHash, codigo) {
        await pool.query(
          'INSERT INTO users (username, password_hash, codigo) VALUES ($1, $2, $3)',
          [username, passwordHash, codigo]
        );
        return { username, passwordHash, exp: 0, nivel: 1, codigo, friends: [], racha: 0, mejorRacha: 0 };
      },

      async updateUser(username, campos) {
        if (campos.exp !== undefined) {
          await pool.query('UPDATE users SET exp = $1 WHERE username = $2', [campos.exp, username]);
        }
        if (campos.nivel !== undefined) {
          await pool.query('UPDATE users SET nivel = $1 WHERE username = $2', [campos.nivel, username]);
        }
        if (campos.friends !== undefined) {
          await pool.query('UPDATE users SET friends = $1 WHERE username = $2', [JSON.stringify(campos.friends), username]);
        }
        if (campos.racha !== undefined) {
          await pool.query('UPDATE users SET racha = $1 WHERE username = $2', [campos.racha, username]);
        }
        if (campos.mejorRacha !== undefined) {
          await pool.query('UPDATE users SET mejor_racha = $1 WHERE username = $2', [campos.mejorRacha, username]);
        }
      },

    async addFriendMutual(a, b) {
      const ra = await pool.query('SELECT friends FROM users WHERE username = $1', [a]);
      if (ra.rows.length) {
        const fa = parseFriends(ra.rows[0].friends);
        if (!fa.includes(b)) {
          fa.push(b);
          await pool.query('UPDATE users SET friends = $1 WHERE username = $2', [JSON.stringify(fa), a]);
        }
      }
      const rb = await pool.query('SELECT friends FROM users WHERE username = $1', [b]);
      if (rb.rows.length) {
        const fb = parseFriends(rb.rows[0].friends);
        if (!fb.includes(a)) {
          fb.push(a);
          await pool.query('UPDATE users SET friends = $1 WHERE username = $2', [JSON.stringify(fb), b]);
        }
      }
    },

    async getRequest(de, para) {
      const r = await pool.query(
        "SELECT de, para, estado FROM friend_requests WHERE de = $1 AND para = $2 AND estado = 'pendiente'",
        [de, para]
      );
      return r.rows.length ? { de: r.rows[0].de, para: r.rows[0].para, estado: r.rows[0].estado } : null;
    },

    async addRequest(de, para) {
      await pool.query(
        "INSERT INTO friend_requests (de, para) VALUES ($1, $2) ON CONFLICT (de, para) DO NOTHING",
        [de, para]
      );
    },

    async deleteRequest(de, para) {
      await pool.query('DELETE FROM friend_requests WHERE de = $1 AND para = $2', [de, para]);
    },

    async listRequests(para) {
      const r = await pool.query(
        "SELECT de FROM friend_requests WHERE para = $1 AND estado = 'pendiente' ORDER BY fecha DESC",
        [para]
      );
      return r.rows.map(x => ({ de: x.de }));
    },

    async countUsers() {
      const r = await pool.query('SELECT COUNT(*)::int AS n FROM users');
      return r.rows[0].n;
    },

    async createSession(username) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query('INSERT INTO sessions (token, username) VALUES ($1, $2)', [token, username]);
      return token;
    },

    async getSession(token) {
      const r = await pool.query(
        "SELECT username FROM sessions WHERE token = $1 AND creado > now() - interval '30 days'",
        [token]
      );
      return r.rows.length ? { username: r.rows[0].username } : null;
    },

    async deleteSession(token) {
      await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    },

    async getAllUsersForRanking() {
      const r = await pool.query('SELECT username, exp, nivel, racha, mejor_racha AS "mejorRacha" FROM users');
      const resultado = {};
      r.rows.forEach(f => { resultado[f.username] = { exp: f.exp, nivel: f.nivel, racha: f.racha, mejorRacha: f.mejorRacha }; });
      return resultado;
    },

    // Solo para pruebas automatizadas: limpia datos de test
    async borrarUsuariosTest(prefijo) {
      await pool.query('DELETE FROM friend_requests WHERE de LIKE $1 OR para LIKE $1', [prefijo + '%']);
      await pool.query('DELETE FROM sessions WHERE username LIKE $1', [prefijo + '%']);
      await pool.query('DELETE FROM users WHERE username LIKE $1', [prefijo + '%']);
    }
  };
}

module.exports = crearCapaDatos;