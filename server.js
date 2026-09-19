const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./db')(process.env.DATABASE_URL);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir archivos estaticos del frontend
app.use(express.static(path.join(__dirname, 'public')));

// ===== ESTADO DEL SERVIDOR =====
// Persistente (PostgreSQL vía db.js): usuarios, solicitudes, sesiones
// Efímero (memoria, por naturaleza): partidas activas, retos, presencia online
const games = {};          // { codigo: partida } - partidas 1v1
const onlineSockets = {};   // { username: Set<socketId> } - sesiones conectadas
const pendingInvites = {};  // { receptor: emisor } - retos 1v1 pendientes

// ===== MOTOR DE GRUPOS (apartado ADICIONAL - no modifica el 1v1) =====
const grupos = {};          // grupos en espera: { id: { id, creador, invitados: [{username, estado}], expira } }
const grupoGames = {};      // partidas de grupo: { id: { id, asientos: [{username, manos, vivo, activo}], turnoActual, enCurso } }
const grupoInvites = {};    // invitaciones a grupo: { receptor: { grupoId, de } }

const GRUPO_MIN = 3;   // incluyendo al creador
const GRUPO_MAX = 6;
const EXP_GANADOR_GRUPO = 150;
const EXP_PERDEDOR_GRUPO = 10;
const TIEMPO_ESPERA_GRUPO_MS = parseInt(process.env.GRUPO_TIMEOUT_MS || '60000', 10);

const SALT_ROUNDS = 10;

// ===== FUNCIONES AUXILIARES =====

function generarCodigo(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let codigo = '';
  for (let i = 0; i < len; i++) {
    codigo += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return codigo;
}

function calcularNivel(exp) {
  if (exp < 100) return 1;
  if (exp < 400) return 2;
  if (exp < 1000) return 3;
  if (exp < 2000) return 4;
  if (exp < 3500) return 5;
  return Math.floor(Math.sqrt(exp / 100)) + 1;
}

function estadoInicialManos() {
  return {
    izq: { count: 1, alive: true },
    der: { count: 1, alive: true }
  };
}

function nuevaPartida(p1Username, socketP1Id) {
  let codigo = generarCodigo();
  while (games[codigo]) codigo = generarCodigo();
  games[codigo] = {
    codigo,
    p1: p1Username,
    p2: null,
    sockets: { p1: socketP1Id, p2: null },
    estado: {
      p1: { username: p1Username, manos: estadoInicialManos() },
      p2: null
    },
    turnoActual: null,
    enCurso: false
  };
  return games[codigo];
}

function vistaPublicaPartida(partida) {
  return {
    codigo: partida.codigo,
    p1: partida.p1,
    p2: partida.p2,
    estado: partida.estado,
    turnoActual: partida.turnoActual,
    enCurso: partida.enCurso
  };
}

function emitirAPartida(partida, evento, datos) {
  if (partida.sockets.p1) io.to(partida.sockets.p1).emit(evento, datos);
  if (partida.sockets.p2) io.to(partida.sockets.p2).emit(evento, datos);
}

function manosVivas(manos) {
  return (manos.izq.alive ? 1 : 0) + (manos.der.alive ? 1 : 0);
}

function sumaDedosVivos(manos) {
  return (manos.izq.alive ? manos.izq.count : 0) + (manos.der.alive ? manos.der.count : 0);
}

// Registrar una sesión de usuario (soporta múltiples pestañas/dispositivos)
function registrarSesion(socket, username) {
  if (!onlineSockets[username]) onlineSockets[username] = new Set();
  onlineSockets[username].add(socket.id);
  socket.join(`user:${username}`); // sala personal: los eventos llegan a todas las sesiones
}

function usuarioConectado(username) {
  return !!(onlineSockets[username] && onlineSockets[username].size > 0);
}

// (Las sesiones con token ahora viven en la capa de datos db.js)

// Salida de un usuario desde un socket (desconexión o cierre de sesión).
// Si le quedan otras sesiones activas, el usuario sigue en línea.
function manejarSalida(socket, username) {
  socket.leave(`user:${username}`);
  const sesiones = onlineSockets[username];
  if (sesiones) {
    sesiones.delete(socket.id);
    if (sesiones.size > 0) return; // sigue activo en otra pestaña/dispositivo
    delete onlineSockets[username];
  }

  // Si estaba en partida, el oponente gana
  const partida = Object.values(games).find(
    g => g.enCurso && (g.p1 === username || g.p2 === username)
  );
  if (partida) {
    const ganador = partida.p1 === username ? partida.p2 : partida.p1;
    finalizarPartida(partida, ganador, `${username} salió de la partida`);
  }

  // Si esperaba oponente, eliminar su partida huérfana
  const huerfana = Object.values(games).find(g => !g.enCurso && g.p1 === username);
  if (huerfana) delete games[huerfana.codigo];

  // Limpiar retos pendientes relacionados con este usuario
  if (pendingInvites[username]) delete pendingInvites[username];
  Object.keys(pendingInvites).forEach(receptor => {
    if (pendingInvites[receptor] === username) delete pendingInvites[receptor];
  });

  // ===== LIMPIEZA DE GRUPOS =====

  // Si es creador de un grupo en espera → disolverlo
  Object.values(grupos).forEach(grupo => {
    if (grupo.creador === username) {
      disolverGrupo(grupo.id, 'El creador se desconectó');
    } else if (grupo.invitados.some(i => i.username === username && i.estado === 'pendiente')) {
      disolverGrupo(grupo.id, `${username} se desconectó antes de responder`);
    }
  });
  if (grupoInvites[username]) delete grupoInvites[username];

  // Si estaba en una partida de grupo:
  //  - vivo → queda eliminado (y el turno pasa al siguiente si era suyo)
  //  - ya eliminado (espectador) → nada
  const gJuego = Object.values(grupoGames).find(
    g => g.enCurso && g.asientos.some(a => a.username === username)
  );
  if (gJuego) {
    const yo = gJuego.asientos.find(a => a.username === username);
    yo.activo = false; // ya no recibirá más emisiones
    if (yo.vivo) {
      yo.vivo = false;
      const vivos = gJuego.asientos.filter(a => a.vivo);
      if (vivos.length <= 1) {
        finalizarGrupo(gJuego, vivos[0].username, `${username} se desconectó`);
      } else {
        if (gJuego.turnoActual === username) {
          const idx = gJuego.asientos.indexOf(yo);
          gJuego.turnoActual = siguienteTurnoGrupo(gJuego.asientos, idx);
        }
        emitirAGrupo(gJuego, 'grupo-partida-actualizada', {
          partida: vistaPublicaGrupo(gJuego),
          mensaje: `${username} se desconectó y quedó eliminado`
        });
      }
    }
  }
}

// Construir el ranking global (función pura, testable).
// Devuelve: top N con puestos, el puesto global del usuario que consulta y,
// si está FUERA del top, su propia fila (yo) para mostrarla aparte.
function construirRanking(usersObj, username, limite = 25) {
  const todos = Object.entries(usersObj)
    .map(([nombre, u]) => ({
      username: nombre,
      exp: u.exp,
      nivel: u.nivel,
      racha: u.racha || 0,
      mejorRacha: u.mejorRacha || 0
    }))
    .sort((a, b) => b.exp - a.exp || a.username.localeCompare(b.username));

  const top = todos.slice(0, limite).map((u, i) => ({ puesto: i + 1, ...u }));

  let miPuesto = null;
  let yo = null;
  if (username && usersObj[username]) {
    miPuesto = todos.findIndex(u => u.username === username) + 1;
    if (miPuesto > limite) {
      const u = usersObj[username];
      yo = {
        puesto: miPuesto,
        username,
        exp: u.exp,
        nivel: u.nivel,
        racha: u.racha || 0,
        mejorRacha: u.mejorRacha || 0
      };
    }
  }
  return { top, miPuesto, yo };
}

// Asíncrona: actualiza el EXP en la capa de datos antes de notificar a los jugadores.
// Nunca lanza excepciones (los llamadores no necesitan await).
async function finalizarPartida(partida, ganador, motivo) {
  try {
    const perdedor = ganador === partida.p1 ? partida.p2 : partida.p1;
    partida.enCurso = false;
    delete games[partida.codigo]; // eliminar de inmediato: no se aceptan más jugadas

    const EXP_GANADOR = 100;
    const EXP_PERDEDOR = 5;

    let perfilGanador = null;
    let perfilPerdedor = null;

    try {
      const ug = await db.getUser(ganador);
      if (ug) {
        const nuevoExp = ug.exp + EXP_GANADOR;
        const nuevoNivel = calcularNivel(nuevoExp);
        const racha = (ug.racha || 0) + 1;
        const mejorRacha = Math.max(racha, ug.mejorRacha || 0);
        await db.updateUser(ganador, { exp: nuevoExp, nivel: nuevoNivel, racha, mejorRacha });
        perfilGanador = { exp: nuevoExp, nivel: nuevoNivel, racha, mejorRacha };
      }
      const up = await db.getUser(perdedor);
      if (up) {
        const nuevoExp = up.exp + EXP_PERDEDOR;
        const nuevoNivel = calcularNivel(nuevoExp);
        await db.updateUser(perdedor, { exp: nuevoExp, nivel: nuevoNivel, racha: 0 });
        perfilPerdedor = { exp: nuevoExp, nivel: nuevoNivel, racha: 0, mejorRacha: up.mejorRacha || 0 };
      }
      // Log de finalización (útil en producción)
      console.log(`[OK] 1v1 finalizada: gana ${ganador} (+${EXP_GANADOR}), pierde ${perdedor} (+${EXP_PERDEDOR})`);
    } catch (err) {
      console.error('[ERR] actualizando EXP en la base de datos:', err.message);
    }

    emitirAPartida(partida, 'partida-finalizada', {
      ganador,
      perdedor,
      motivo,
      expGanador: EXP_GANADOR,
      expPerdedor: EXP_PERDEDOR,
      perfilGanador,
      perfilPerdedor
    });
  } catch (err) {
    console.error('[ERR] finalizarPartida:', err.message);
  }
}

// Validar y ejecutar un ataque. Devuelve {error} o aplica cambios.
function ejecutarAtaque(partida, jugador, manoAtacante, manoObjetivo) {
  const estadoJugador = partida.estado[jugador];
  const oponente = jugador === 'p1' ? 'p2' : 'p1';
  const estadoOponente = partida.estado[oponente];

  // Validaciones
  if (!estadoJugador.manos[manoAtacante].alive) return { error: 'Tu mano atacante está muerta' };
  if (!estadoOponente.manos[manoObjetivo].alive) return { error: 'La mano objetivo ya está muerta' };

  const dedosAtacante = estadoJugador.manos[manoAtacante].count;
  const manoObj = estadoOponente.manos[manoObjetivo];
  const total = dedosAtacante + manoObj.count;

  if (total === 5) {
    // Muerte exacta
    manoObj.alive = false;
    manoObj.count = 5;
  } else if (total > 5) {
    // Muerte + exceso a la otra mano (la revive si estaba muerta)
    const exceso = total - 5;
    manoObj.alive = false;
    manoObj.count = 5;

    const otraMano = manoObjetivo === 'izq' ? 'der' : 'izq';
    const manoOtra = estadoOponente.manos[otraMano];
    if (manoOtra.alive) {
      const nuevoTotal = manoOtra.count + exceso;
      if (nuevoTotal >= 5) {
        // El exceso también mata la otra mano
        manoOtra.alive = false;
        manoOtra.count = Math.min(nuevoTotal, 5);
      } else {
        manoOtra.count = nuevoTotal;
      }
    } else {
      // La otra mano estaba muerta: REVIVE con el exceso
      manoOtra.alive = true;
      manoOtra.count = exceso;
    }
  } else {
    // Suma normal
    manoObj.count = total;
  }

  return { ok: true };
}

// Aplicar división de manos (ACCIÓN LIBRE: no consume turno).
// Reparte la suma de dedos vivos en mitades iguales y revive manos muertas.
function ejecutarDivision(manos) {
  const suma = sumaDedosVivos(manos);

  if (suma % 2 !== 0) return { error: 'La suma de tus dedos no es par' };
  if (suma < 2) return { error: 'No tienes suficientes dedos para dividir' };

  const mitad = suma / 2;
  manos.izq = { count: mitad, alive: true };
  manos.der = { count: mitad, alive: true };
  return { ok: true, mitad };
}

// ===== FUNCIONES PURAS DEL MOTOR DE GRUPO =====

// Daño a una mano con las mismas reglas de Deditos (versión pura para grupos):
// total=5 muere exacta; total>5 muere y el exceso pasa a la otra mano
// (la REVIVE si estaba muerta; si la mata, ambas mueren).
function danioMano(manos, ladoObjetivo, dedosAtacante) {
  const mano = manos[ladoObjetivo];
  const total = dedosAtacante + mano.count;

  if (total === 5) {
    mano.alive = false;
    mano.count = 5;
  } else if (total > 5) {
    const exceso = total - 5;
    mano.alive = false;
    mano.count = 5;
    const otroLado = ladoObjetivo === 'izq' ? 'der' : 'izq';
    const otra = manos[otroLado];
    if (otra.alive) {
      const nuevoTotal = otra.count + exceso;
      if (nuevoTotal >= 5) {
        otra.alive = false;
        otra.count = Math.min(nuevoTotal, 5);
      } else {
        otra.count = nuevoTotal;
      }
    } else {
      otra.alive = true;
      otra.count = exceso;
    }
  } else {
    mano.count = total;
  }
  return { ok: true };
}

// Turno de grupo: la VÍCTIMA juega; si quedó eliminada, sigue el próximo
// jugador vivo en el orden de la mesa (sentido horario desde su asiento).
function siguienteTurnoGrupo(asientos, indiceVictima) {
  if (asientos[indiceVictima].vivo) return asientos[indiceVictima].username;
  for (let i = 1; i <= asientos.length; i++) {
    const idx = (indiceVictima + i) % asientos.length;
    if (asientos[idx].vivo) return asientos[idx].username;
  }
  return null;
}

// ¿Está en una partida activa (1v1 o de grupo)?
function enPartidaActiva(username) {
  const en1v1 = Object.values(games).some(g => g.enCurso && (g.p1 === username || g.p2 === username));
  const enGrupo = Object.values(grupoGames).some(
    g => g.enCurso && g.asientos.some(a => a.username === username)
  );
  return en1v1 || enGrupo;
}

// ¿Está en un grupo en espera (como creador o invitado)?
function enGrupoEspera(username) {
  return Object.values(grupos).some(
    g => g.creador === username || g.invitados.some(i => i.username === username)
  );
}

function vistaPublicaGrupo(partida) {
  return {
    id: partida.id,
    asientos: partida.asientos.map(a => ({ username: a.username, manos: a.manos, vivo: a.vivo })),
    turnoActual: partida.turnoActual,
    enCurso: partida.enCurso
  };
}

function vistaGrupoEspera(grupo) {
  return {
    id: grupo.id,
    creador: grupo.creador,
    invitados: grupo.invitados.map(i => ({ username: i.username, estado: i.estado })),
    segundos: Math.max(0, Math.round((grupo.expira - Date.now()) / 1000))
  };
}

function emitirAGrupo(partida, evento, datos) {
  partida.asientos.forEach(a => {
    if (a.activo !== false) io.to(`user:${a.username}`).emit(evento, datos);
  });
}

// Disolver un grupo en espera y notificar a todos los involucrados
function disolverGrupo(id, motivo) {
  const grupo = grupos[id];
  if (!grupo) return;
  delete grupos[id];
  grupo.invitados.forEach(i => {
    if (grupoInvites[i.username] && grupoInvites[i.username].grupoId === id) {
      delete grupoInvites[i.username];
    }
  });
  const todos = [grupo.creador, ...grupo.invitados.map(i => i.username)];
  todos.forEach(n => io.to(`user:${n}`).emit('grupo-cancelado', { grupoId: id, motivo }));
  console.log(`[..] Grupo ${id} disuelto: ${motivo}`);
}

// Todos aceptaron → crear la partida de grupo
function iniciarGrupo(grupo) {
  delete grupos[grupo.id];
  const asientos = [
    { username: grupo.creador, manos: estadoInicialManos(), vivo: true, activo: true },
    ...grupo.invitados.map(i => ({ username: i.username, manos: estadoInicialManos(), vivo: true, activo: true }))
  ];
  const partida = { id: grupo.id, asientos, turnoActual: grupo.creador, enCurso: true };
  grupoGames[grupo.id] = partida;
  console.log(`[OK] Grupo ${grupo.id}: ${asientos.map(a => a.username).join(' vs ')}. Empieza ${grupo.creador} (creador)`);
  emitirAGrupo(partida, 'grupo-partida-iniciada', {
    partida: vistaPublicaGrupo(partida),
    mensaje: `¡Grupo completo! Empieza ${grupo.creador}`
  });
}

// Expiración automática del grupo (60s por defecto)
function expirarGrupo(id) {
  if (grupos[id]) disolverGrupo(id, 'Se agotó el tiempo de espera (nadie respondió)');
}

// Finalizar partida de grupo: 1 ganador (+150, racha+1), resto (+10, racha=0)
async function finalizarGrupo(partida, ganador, motivo) {
  partida.enCurso = false;
  delete grupoGames[partida.id];

  const perfiles = {};
  for (const a of partida.asientos) {
    try {
      const u = await db.getUser(a.username);
      if (!u) continue;
      if (a.username === ganador) {
        const nuevoExp = u.exp + EXP_GANADOR_GRUPO;
        const racha = (u.racha || 0) + 1;
        const mejorRacha = Math.max(racha, u.mejorRacha || 0);
        await db.updateUser(a.username, {
          exp: nuevoExp, nivel: calcularNivel(nuevoExp), racha, mejorRacha
        });
        perfiles[a.username] = { exp: nuevoExp, nivel: calcularNivel(nuevoExp), racha, expGanada: EXP_GANADOR_GRUPO };
      } else {
        const nuevoExp = u.exp + EXP_PERDEDOR_GRUPO;
        const nuevoNivel = calcularNivel(nuevoExp);
        await db.updateUser(a.username, {
          exp: nuevoExp, nivel: nuevoNivel, racha: 0
        });
        perfiles[a.username] = { exp: nuevoExp, nivel: nuevoNivel, racha: 0, expGanada: EXP_PERDEDOR_GRUPO };
      }
    } catch (err) {
      console.error('[ERR] actualizando EXP de grupo:', err.message);
    }
  }

  console.log(`[OK] Grupo ${partida.id} terminado. Ganador: ${ganador} (+${EXP_GANADOR_GRUPO} EXP)`);
  emitirAGrupo(partida, 'grupo-partida-finalizada', {
    ganador,
    motivo,
    perfiles,
    expGanador: EXP_GANADOR_GRUPO,
    expPerdedor: EXP_PERDEDOR_GRUPO
  });
}

// ===== SOCKET.IO =====

io.on('connection', (socket) => {
  console.log(`[+] Conexion: ${socket.id}`);
  let usuarioActual = null; // username asociado a este socket

  // ---------- REGISTRO ----------
  socket.on('registrar', async (data, callback) => {
    try {
      const fn = typeof callback === 'function' ? callback : () => {};
      const { username, password } = data || {};
      if (!username || !password) return fn({ error: 'Usuario y contraseña requeridos' });
      if (typeof username !== 'string' || username.length < 3 || username.length > 20) {
        return fn({ error: 'El usuario debe tener entre 3 y 20 caracteres' });
      }
      if (typeof password !== 'string' || password.length < 4) {
        return fn({ error: 'La contraseña debe tener al menos 4 caracteres' });
      }
      const existente = await db.getUser(username);
      if (existente) return fn({ error: 'Ese usuario ya existe' });

      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      let codigo = generarCodigo();
      while (await db.codigoEnUso(codigo)) codigo = generarCodigo();

      await db.createUser(username, passwordHash, codigo);

      usuarioActual = username;
      registrarSesion(socket, username);
      const token = await db.createSession(username);
      console.log(`[OK] Registrado: ${username}`);
      fn({
        success: true,
        usuario: username,
        nivel: 1,
        exp: 0,
        codigo,
        token
      });
    } catch (err) {
      console.error('[ERR] registrar:', err.message);
      if (typeof callback === 'function') callback({ error: 'Error interno del servidor' });
    }
  });

  // ---------- LOGIN ----------
  socket.on('login', async (data, callback) => {
    try {
      const fn = typeof callback === 'function' ? callback : () => {};
      const { username, password } = data || {};
      if (!username || !password) return fn({ error: 'Usuario y contraseña requeridos' });

      const user = await db.getUser(username);
      if (!user) return fn({ error: 'Usuario no encontrado' });

      const valido = await bcrypt.compare(password, user.passwordHash);
      if (!valido) return fn({ error: 'Contraseña incorrecta' });

      usuarioActual = username;
      registrarSesion(socket, username);
      const token = await db.createSession(username);
      console.log(`[OK] Login: ${username}`);
      fn({
        success: true,
        usuario: username,
        nivel: user.nivel,
        exp: user.exp,
        codigo: user.codigo,
        token
      });
    } catch (err) {
      console.error('[ERR] login:', err.message);
      if (typeof callback === 'function') callback({ error: 'Error interno del servidor' });
    }
  });

  // ---------- VERIFICAR SESIÓN (auto-login con token) ----------
  socket.on('verificar-sesion', async (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { token } = data || {};
    const sesion = token ? await db.getSession(token) : null;
    if (!sesion) return fn({ error: 'Sesión no válida o expirada' });

    const username = sesion.username;
    const user = await db.getUser(username);
    if (!user) return fn({ error: 'El usuario de esta sesión ya no existe' });

    usuarioActual = username;
    registrarSesion(socket, username);
    console.log(`[OK] Sesión restaurada: ${username}`);
    fn({
      success: true,
      usuario: username,
      nivel: user.nivel,
      exp: user.exp,
      codigo: user.codigo
    });
  });

  // ---------- CERRAR SESIÓN ----------
  socket.on('cerrar-sesion', async (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { token } = data || {};

    if (token) {
      const sesion = await db.getSession(token);
      await db.deleteSession(token); // limpiar siempre (aunque esté expirada)

      // Si ESTE socket era ese usuario, desregistrar su presencia
      if (sesion && usuarioActual && usuarioActual === sesion.username) {
        manejarSalida(socket, usuarioActual);
        usuarioActual = null;
      }
    }
    fn({ success: true });
  });

  // ---------- CREAR PARTIDA ----------
  socket.on('crear-partida', async (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username } = data || {};
    const user = username ? await db.getUser(username) : null;
    if (!user) return fn({ error: 'Debes iniciar sesión primero' });

    // Abandonar partida previa si existe
    const previa = Object.values(games).find(g => g.p1 === username || g.p2 === username);
    if (previa && previa.enCurso) {
      return fn({ error: 'Ya tienes una partida en curso' });
    }
    if (previa) delete games[previa.codigo];

    // Protección de modo grupo: no crear 1v1 mientras se juega o espera un grupo
    const enGrupoJuego = Object.values(grupoGames).some(
      g => g.enCurso && g.asientos.some(a => a.username === username)
    );
    if (enGrupoJuego) return fn({ error: 'Estás en una partida de grupo' });
    if (enGrupoEspera(username)) return fn({ error: 'Estás esperando un grupo' });

    const partida = nuevaPartida(username, `user:${username}`);
    console.log(`[OK] Partida creada: ${partida.codigo} por ${username}`);
    fn({ success: true, codigo: partida.codigo });
  });

  // ---------- UNIRSE A PARTIDA ----------
  socket.on('unirse-partida', async (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username, codigo } = data || {};
    const userQueSeUne = username ? await db.getUser(username) : null;
    if (!userQueSeUne) return fn({ error: 'Debes iniciar sesión primero' });

    const partida = games[codigo];
    if (!partida) return fn({ error: 'No existe una partida con ese código' });
    if (partida.enCurso) return fn({ error: 'La partida ya está completa' });
    if (partida.p1 === username) return fn({ error: 'No puedes unirte a tu propia partida' });

    // Protección de modo grupo: no unirse a un 1v1 mientras se juega o espera un grupo
    const enGrupoJuego2 = Object.values(grupoGames).some(
      g => g.enCurso && g.asientos.some(a => a.username === username)
    );
    if (enGrupoJuego2) return fn({ error: 'Estás en una partida de grupo' });
    if (enGrupoEspera(username)) return fn({ error: 'Estás esperando un grupo' });

    partida.p2 = username;
    partida.sockets.p2 = `user:${username}`;
    partida.estado.p2 = { username, manos: estadoInicialManos() };
    partida.enCurso = true;

    // Turno inicial aleatorio
    partida.turnoActual = Math.random() < 0.5 ? partida.p1 : partida.p2;

    console.log(`[OK] Partida ${codigo} completa: ${partida.p1} vs ${partida.p2}. Empieza ${partida.turnoActual}`);

    emitirAPartida(partida, 'partida-iniciada', {
      partida: vistaPublicaPartida(partida),
      mensaje: `¡Partida iniciada! Empieza ${partida.turnoActual}`
    });

    fn({ success: true, codigo: partida.codigo });
  });

  // ---------- ATACAR ----------
  socket.on('atacar', (data) => {
    const { username, codigo, manoAtacante, manoObjetivo } = data || {};
    const partida = games[codigo];
    if (!partida || !partida.enCurso) return;

    if (partida.turnoActual !== username) {
      return socket.emit('error-juego', { mensaje: 'No es tu turno' });
    }

    const jugador = partida.p1 === username ? 'p1' : partida.p2 === username ? 'p2' : null;
    if (!jugador) return socket.emit('error-juego', { mensaje: 'No perteneces a esta partida' });

    if (!['izq', 'der'].includes(manoAtacante) || !['izq', 'der'].includes(manoObjetivo)) {
      return socket.emit('error-juego', { mensaje: 'Mano inválida' });
    }

    const resultado = ejecutarAtaque(partida, jugador, manoAtacante, manoObjetivo);
    if (resultado.error) {
      return socket.emit('error-juego', { mensaje: resultado.error });
    }

    // Verificar victoria
    const oponente = jugador === 'p1' ? 'p2' : 'p1';
    const atacante = partida.estado[jugador].username;
    if (manosVivas(partida.estado[oponente].manos) === 0) {
      return finalizarPartida(partida, atacante, `${atacante} dejó al oponente sin manos vivas`);
    }

    // Cambiar turno
    partida.turnoActual = partida.estado[oponente].username;

    emitirAPartida(partida, 'partida-actualizada', {
      partida: vistaPublicaPartida(partida),
      mensaje: `${atacante} atacó con su mano ${manoAtacante} a la mano ${manoObjetivo}`
    });
  });

  // ---------- DIVIDIR MANOS ----------
  socket.on('dividir-manos', (data) => {
    const { username, codigo } = data || {};
    const partida = games[codigo];
    if (!partida || !partida.enCurso) return;

    if (partida.turnoActual !== username) {
      return socket.emit('error-juego', { mensaje: 'No es tu turno' });
    }

    const jugador = partida.p1 === username ? 'p1' : partida.p2 === username ? 'p2' : null;
    if (!jugador) return socket.emit('error-juego', { mensaje: 'No perteneces a esta partida' });

    const resultado = ejecutarDivision(partida.estado[jugador].manos);
    if (resultado.error) {
      return socket.emit('error-juego', { mensaje: resultado.error });
    }

    // La división es una ACCIÓN LIBRE: el jugador conserva su turno y debe atacar
    emitirAPartida(partida, 'partida-actualizada', {
      partida: vistaPublicaPartida(partida),
      mensaje: `${username} dividió sus manos en ${resultado.mitad} y ${resultado.mitad}. ¡Sigue su turno, debe atacar!`
    });
  });

  // ---------- ABANDONAR PARTIDA ----------
  socket.on('salir-partida', (data) => {
    const { username, codigo } = data || {};
    const partida = games[codigo];
    if (!partida) return;

    if (partida.enCurso) {
      const ganador = partida.p1 === username ? partida.p2 : partida.p1;
      finalizarPartida(partida, ganador, `${username} abandonó la partida`);
    } else {
      delete games[codigo];
    }
  });

  // ---------- AMIGOS: LISTA ----------
  socket.on('solicitar-amigos', async (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username } = data || {};
    const user = await db.getUser(username);
    if (!user) return fn({ error: 'Usuario no válido' });

    const amigos = await Promise.all(user.friends.map(async nombre => ({
      nombre,
      online: usuarioConectado(nombre),
      codigo: (await db.getUser(nombre)) ? (await db.getUser(nombre)).codigo : '---'
    })));

    const solicitudes = await db.listRequests(username);
    fn({ success: true, amigos, solicitudes });
  });

  // ---------- RANKING GLOBAL ----------
  socket.on('solicitar-ranking', async (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username } = data || {};
    const usuariosParaRanking = await db.getAllUsersForRanking();
    fn({ success: true, ...construirRanking(usuariosParaRanking, username, 25) });
  });

  // ---------- AMIGOS: AGREGAR ----------
  socket.on('agregar-amigo', async (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username, codigoAmigo } = data || {};
    const user = await db.getUser(username);
    if (!user) return fn({ error: 'Usuario no válido' });

    // Buscar usuario por código
    const objetivo = await db.getUserByCodigo(String(codigoAmigo).toUpperCase().trim());
    const nombreObjetivo = objetivo ? objetivo.username : null;

    if (!nombreObjetivo) return fn({ error: 'No existe ningún usuario con ese código' });
    if (nombreObjetivo === username) return fn({ error: 'No puedes agregarte a ti mismo' });
    if (user.friends.includes(nombreObjetivo)) return fn({ error: 'Ya son amigos' });

    const yaEnviada = await db.getRequest(username, nombreObjetivo);
    if (yaEnviada) return fn({ error: 'Ya enviaste una solicitud a este usuario' });

    await db.addRequest(username, nombreObjetivo);

    // Notificar en tiempo real si está conectado
    io.to(`user:${nombreObjetivo}`).emit('solicitud-amistad-recibida', { de: username });

    console.log(`[OK] Solicitud de amistad: ${username} -> ${nombreObjetivo}`);
    fn({ success: true, mensaje: `Solicitud enviada a ${nombreObjetivo}` });
  });

  // ---------- AMIGOS: ACEPTAR ----------
  socket.on('aceptar-amistad', async (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username, de } = data || {};
    const user = await db.getUser(username);
    if (!user) return fn({ error: 'Usuario no válido' });

    const solicitud = await db.getRequest(de, username);
    if (!solicitud) return fn({ error: 'No tienes solicitud de este usuario' });

    await db.deleteRequest(de, username);
    await db.addFriendMutual(username, de);

    // Notificar a ambos
    io.to(`user:${de}`).emit('amistad-aceptada', { de: username });
    console.log(`[OK] Amistad: ${username} y ${de} ahora son amigos`);
    fn({ success: true, mensaje: `¡Ahora son amigos ${username} y ${de}!` });
  });

  // ---------- AMIGOS: RETAR A PARTIDA ----------
  socket.on('invitar-amigo', async (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username, amigo } = data || {};
    const user = await db.getUser(username);
    if (!user) return fn({ error: 'Debes iniciar sesión' });
    const amigoUser = await db.getUser(amigo);
    if (!amigoUser) return fn({ error: 'Ese usuario no existe' });
    if (!user.friends.includes(amigo)) return fn({ error: 'Ese usuario no es tu amigo' });
    if (amigo === username) return fn({ error: 'No puedes retarte a ti mismo' });
    if (!usuarioConectado(amigo)) return fn({ error: `${amigo} no está conectado` });

    // Nadie en partida en curso (1v1 o grupo) ni esperando un grupo
    const ocupado = Object.values(games).find(
      g => g.enCurso && (g.p1 === username || g.p2 === username || g.p1 === amigo || g.p2 === amigo)
    );
    if (ocupado) return fn({ error: 'Alguno de los dos ya está en una partida' });
    if (enPartidaActiva(username) || enPartidaActiva(amigo)) {
      return fn({ error: 'Alguno de los dos ya está en una partida' });
    }
    if (enGrupoEspera(username)) return fn({ error: 'Estás esperando un grupo' });
    if (enGrupoEspera(amigo)) return fn({ error: `${amigo} está esperando un grupo` });

    // Limpiar partida en espera del invitador (ya no la necesita)
    const enEspera = Object.values(games).find(g => !g.enCurso && g.p1 === username);
    if (enEspera) delete games[enEspera.codigo];

    pendingInvites[amigo] = username;
    io.to(`user:${amigo}`).emit('invitacion-recibida', { de: username });
    console.log(`[OK] Reto: ${username} -> ${amigo}`);
    fn({ success: true, mensaje: `Reto enviado a ${amigo}. Esperando respuesta...` });
  });

  // ---------- AMIGOS: RESPONDER RETO ----------
  socket.on('responder-invitacion', async (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username, de, aceptar } = data || {};
    const user = await db.getUser(username);
    if (!user) return fn({ error: 'Debes iniciar sesión' });

    // Solo se puede responder a un reto real y pendiente
    if (pendingInvites[username] !== de) {
      return fn({ error: 'No tienes un reto pendiente de ese usuario' });
    }
    delete pendingInvites[username];

    if (!aceptar) {
      io.to(`user:${de}`).emit('invitacion-rechazada', { de: username });
      console.log(`[..] Reto rechazado: ${username} rechazó a ${de}`);
      return fn({ success: true, aceptado: false });
    }

    // Aceptado: el invitador debe seguir conectado (en alguna sesión)
    if (!usuarioConectado(de)) return fn({ error: `${de} ya no está conectado` });

    // Nadie en partida en curso (1v1 o grupo) ni esperando un grupo
    const ocupado = Object.values(games).find(
      g => g.enCurso && (g.p1 === de || g.p2 === de || g.p1 === username || g.p2 === username)
    );
    if (ocupado) return fn({ error: 'Alguno de los dos ya está en una partida' });
    if (enPartidaActiva(username)) return fn({ error: 'Ya estás en una partida' });
    if (enPartidaActiva(de)) return fn({ error: `${de} ya está en una partida` });
    if (enGrupoEspera(username)) return fn({ error: 'Estás esperando un grupo' });
    if (enGrupoEspera(de)) return fn({ error: `${de} está esperando un grupo` });

    // Crear la partida privada directamente (las salas personales llegan a todas las sesiones)
    const partida = nuevaPartida(de, `user:${de}`);
    partida.p2 = username;
    partida.sockets.p2 = `user:${username}`;
    partida.estado.p2 = { username, manos: estadoInicialManos() };
    partida.enCurso = true;
    partida.turnoActual = Math.random() < 0.5 ? de : username;

    console.log(`[OK] Partida por reto ${partida.codigo}: ${de} vs ${username}. Empieza ${partida.turnoActual}`);
    emitirAPartida(partida, 'partida-iniciada', {
      partida: vistaPublicaPartida(partida),
      mensaje: `¡${username} aceptó el reto! Empieza ${partida.turnoActual}`
    });

    fn({ success: true, aceptado: true, codigo: partida.codigo });
  });

  // ==================== EVENTOS DE GRUPO (apartado adicional) ====================

  // ---------- GRUPO: CREAR ----------
  socket.on('crear-grupo', async (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username, invitados } = data || {};
    const user = await db.getUser(username);
    if (!user) return fn({ error: 'Debes iniciar sesión' });

    if (!Array.isArray(invitados) || invitados.length < GRUPO_MIN - 1 || invitados.length > GRUPO_MAX - 1) {
      return fn({ error: `El grupo necesita entre ${GRUPO_MIN} y ${GRUPO_MAX} jugadores en total (tú + tus invitados)` });
    }
    if (invitados.some(n => n === username)) {
      return fn({ error: 'No puedes invitarte a ti mismo' });
    }
    if (new Set(invitados).size !== invitados.length) {
      return fn({ error: 'Hay invitados repetidos' });
    }
    if (enPartidaActiva(username) || enGrupoEspera(username)) {
      return fn({ error: 'Ya estás en una partida o esperando un grupo' });
    }

    // Validar cada invitado: existe, es amigo del creador, está conectado y libre
    for (const nombre of invitados) {
      const invUser = await db.getUser(nombre);
      if (!invUser) return fn({ error: `El usuario "${nombre}" no existe` });
      if (!user.friends.includes(nombre)) {
        return fn({ error: `"${nombre}" no es tu amigo (los invitados deben ser TUS amigos)` });
      }
      if (!usuarioConectado(nombre)) return fn({ error: `${nombre} no está conectado` });
      if (enPartidaActiva(nombre)) return fn({ error: `${nombre} ya está en una partida` });
      if (enGrupoEspera(nombre)) return fn({ error: `${nombre} ya está esperando otro grupo` });
    }

    // Crear el grupo
    let id = generarCodigo();
    while (grupos[id] || grupoGames[id] || games[id]) id = generarCodigo();
    grupos[id] = {
      id,
      creador: username,
      invitados: invitados.map(n => ({ username: n, estado: 'pendiente' })),
      expira: Date.now() + TIEMPO_ESPERA_GRUPO_MS
    };

    // Enviar invitaciones a todos
    const jugadores = [username, ...invitados];
    invitados.forEach(n => {
      grupoInvites[n] = { grupoId: id, de: username };
      io.to(`user:${n}`).emit('grupo-invitacion', {
        de: username,
        grupoId: id,
        jugadores,
        segundos: Math.round(TIEMPO_ESPERA_GRUPO_MS / 1000)
      });
    });

    setTimeout(() => expirarGrupo(id), TIEMPO_ESPERA_GRUPO_MS + 300);

    console.log(`[OK] Grupo ${id} creado por ${username} con ${invitados.join(', ')}`);
    fn({ success: true, grupo: vistaGrupoEspera(grupos[id]) });
  });

  // ---------- GRUPO: RESPONDER INVITACIÓN ----------
  socket.on('responder-grupo', async (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username, grupoId, aceptar } = data || {};
    const inv = grupoInvites[username];
    const grupo = grupos[grupoId];

    if (!inv || !grupo || inv.grupoId !== grupoId) {
      return fn({ error: 'No tienes invitación pendiente para este grupo' });
    }
    delete grupoInvites[username];

    if (!aceptar) {
      disolverGrupo(grupoId, `${username} rechazó la invitación`);
      return fn({ success: true, aceptado: false });
    }

    // Si quedó ocupado en otra partida mientras esperaba responder → disolver por él
    if (enPartidaActiva(username)) {
      disolverGrupo(grupoId, `${username} está ocupado en otra partida`);
      return fn({ success: true, aceptado: false, motivo: 'Estás en otra partida' });
    }

    const item = grupo.invitados.find(i => i.username === username);
    item.estado = 'aceptado';

    // Notificar el nuevo estado a todos los involucrados
    const vista = vistaGrupoEspera(grupo);
    [grupo.creador, ...grupo.invitados.map(i => i.username)].forEach(n => {
      io.to(`user:${n}`).emit('grupo-actualizado', { grupo: vista });
    });

    // IMPORTANTÍSIMO: responder al cliente ANTES de iniciar la partida.
    // Así, quien acepta de último procesa su callback (sala de espera) antes
    // de que llegue 'grupo-partida-iniciada' (que lo lleva al juego).
    fn({ success: true, aceptado: true });

    // ¿Todos aceptaron? → iniciar la partida de grupo
    if (grupo.invitados.every(i => i.estado === 'aceptado')) {
      iniciarGrupo(grupo);
    }
  });

  // ---------- GRUPO: CANCELAR (solo el creador, en espera) ----------
  socket.on('cancelar-grupo', (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username, grupoId } = data || {};
    const grupo = grupos[grupoId];
    if (!grupo) return fn({ error: 'Ese grupo ya no existe' });
    if (grupo.creador !== username) return fn({ error: 'Solo el creador puede cancelar el grupo' });
    disolverGrupo(grupoId, 'El creador canceló el grupo');
    fn({ success: true });
  });

  // ---------- GRUPO: ATACAR ----------
  socket.on('grupo-atacar', (data) => {
    const { username, grupoId, oponente, manoAtacante, manoObjetivo } = data || {};
    const g = grupoGames[grupoId];
    if (!g || !g.enCurso) return;

    if (g.turnoActual !== username) {
      return io.to(`user:${username}`).emit('grupo-error', { mensaje: 'No es tu turno' });
    }
    const atacante = g.asientos.find(a => a.username === username);
    const victima = g.asientos.find(a => a.username === oponente);
    if (!atacante || !atacante.vivo) {
      return io.to(`user:${username}`).emit('grupo-error', { mensaje: 'No estás activo en esta partida' });
    }
    if (!victima) {
      return io.to(`user:${username}`).emit('grupo-error', { mensaje: 'Ese jugador no está en el grupo' });
    }
    if (victima.username === atacante.username) {
      return io.to(`user:${username}`).emit('grupo-error', { mensaje: 'No puedes atacarte a ti mismo' });
    }
    if (!victima.vivo) {
      return io.to(`user:${username}`).emit('grupo-error', { mensaje: 'Ese jugador ya está eliminado' });
    }
    if (!['izq', 'der'].includes(manoAtacante) || !['izq', 'der'].includes(manoObjetivo)) {
      return io.to(`user:${username}`).emit('grupo-error', { mensaje: 'Mano inválida' });
    }
    if (!atacante.manos[manoAtacante].alive) {
      return io.to(`user:${username}`).emit('grupo-error', { mensaje: 'Tu mano atacante está muerta' });
    }
    if (!victima.manos[manoObjetivo].alive) {
      return io.to(`user:${username}`).emit('grupo-error', { mensaje: 'La mano objetivo ya está muerta' });
    }

    // Aplicar el daño (mismas reglas de Deditos)
    danioMano(victima.manos, manoObjetivo, atacante.manos[manoAtacante].count);

    const mensajes = [`${username} atacó a ${victima.username} con su mano ${manoAtacante}`];
    const idxVictima = g.asientos.indexOf(victima);

    // ¿La víctima quedó eliminada?
    if (manosVivas(victima.manos) === 0 && victima.vivo) {
      victima.vivo = false;
      io.to(`user:${victima.username}`).emit('grupo-eliminado', {
        mensaje: 'Quedaste eliminado. Verás el resto de la partida como espectador.'
      });
      mensajes.push(`${victima.username} quedó ELIMINADO`);
    }

    // ¿Queda un solo vivo? → victoria
    const vivos = g.asientos.filter(a => a.vivo);
    if (vivos.length <= 1) {
      return finalizarGrupo(g, vivos[0].username, `${vivos[0].username} eliminó a todos los demás`);
    }

    // Regla de turno: la VÍCTIMA juega; si fue eliminada, el próximo vivo en la mesa
    g.turnoActual = siguienteTurnoGrupo(g.asientos, idxVictima);

    emitirAGrupo(g, 'grupo-partida-actualizada', {
      partida: vistaPublicaGrupo(g),
      mensaje: mensajes.join('. ')
    });
  });

  // ---------- GRUPO: DIVIDIR (acción libre, igual que en 1v1) ----------
  socket.on('grupo-dividir', (data) => {
    const { username, grupoId } = data || {};
    const g = grupoGames[grupoId];
    if (!g || !g.enCurso) return;
    if (g.turnoActual !== username) {
      return io.to(`user:${username}`).emit('grupo-error', { mensaje: 'No es tu turno' });
    }
    const asiento = g.asientos.find(a => a.username === username);
    if (!asiento || !asiento.vivo) return;

    const resultado = ejecutarDivision(asiento.manos);
    if (resultado.error) {
      return io.to(`user:${username}`).emit('grupo-error', { mensaje: resultado.error });
    }

    // Acción libre: NO cambia el turno
    emitirAGrupo(g, 'grupo-partida-actualizada', {
      partida: vistaPublicaGrupo(g),
      mensaje: `${username} dividió sus manos en ${resultado.mitad} y ${resultado.mitad}. ¡Sigue su turno, debe atacar!`
    });
  });

  // ---------- GRUPO: ABANDONAR (solo eliminados/espectadores) ----------
  socket.on('abandonar-grupo', (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username, grupoId } = data || {};
    const g = grupoGames[grupoId];
    if (!g) return fn({ success: true }); // la partida ya terminó
    const asiento = g.asientos.find(a => a.username === username);
    if (!asiento) return fn({ error: 'No perteneces a este grupo' });
    if (asiento.vivo && g.enCurso) {
      return fn({ error: 'Sigues en juego: primero debes quedar eliminado' });
    }
    asiento.activo = false; // deja de recibir actualizaciones
    fn({ success: true });
  });

  // ---------- DESCONEXIÓN ----------
  socket.on('disconnect', () => {
    console.log(`[-] Desconexion: ${socket.id}`);
    if (usuarioActual) {
      manejarSalida(socket, usuarioActual);
      usuarioActual = null;
    }
  });
});

// ===== RUTAS HTTP DE SALUD =====
app.get('/api/health', async (req, res) => {
  try {
    const usuarios = await db.countUsers();
    res.json({
      ok: true,
      almacenamiento: db.esPersistente() ? 'postgresql' : 'memoria',
      usuarios,
      partidas: Object.keys(games).length,
      conectados: Object.keys(onlineSockets).length
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== INICIAR (solo si se ejecuta directamente, no al requerirlo en tests) =====
const PORT = process.env.PORT || 3001;
if (require.main === module) {
  db.init()
    .then(() => {
      server.listen(PORT, () => {
        console.log(`Servidor Deditos corriendo en http://localhost:${PORT} (almacenamiento: ${db.esPersistente() ? 'PostgreSQL' : 'memoria'})`);
      });
    })
    .catch(err => {
      console.error('ERROR al inicializar la capa de datos:', err.message);
      process.exit(1);
    });
}

// Exportar lógica pura para pruebas automatizadas
module.exports = { ejecutarAtaque, ejecutarDivision, construirRanking, danioMano, siguienteTurnoGrupo, estadoInicialManos, calcularNivel, generarCodigo, io };
