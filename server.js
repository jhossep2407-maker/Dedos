const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir archivos estaticos del frontend
app.use(express.static(path.join(__dirname, 'public')));

// ===== BASE DE DATOS EN MEMORIA =====
const users = {};          // { username: { passwordHash, exp, nivel, friends[], codigo } }
const games = {};          // { codigo: partida }
const friendRequests = {}; // { username: [{de, estado, fecha}] }
const onlineSockets = {};   // { username: socketId } - usuarios conectados
const pendingInvites = {};  // { receptor: emisor } - retos pendientes

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

function finalizarPartida(partida, ganador, motivo) {
  const perdedor = ganador === partida.p1 ? partida.p2 : partida.p1;
  partida.enCurso = false;

  const EXP_GANADOR = 100;
  const EXP_PERDEDOR = 5;

  if (users[ganador]) {
    users[ganador].exp += EXP_GANADOR;
    users[ganador].nivel = calcularNivel(users[ganador].exp);
  }
  if (users[perdedor]) {
    users[perdedor].exp += EXP_PERDEDOR;
    users[perdedor].nivel = calcularNivel(users[perdedor].exp);
  }

  emitirAPartida(partida, 'partida-finalizada', {
    ganador,
    perdedor,
    motivo,
    expGanador: EXP_GANADOR,
    expPerdedor: EXP_PERDEDOR,
    perfilGanador: users[ganador] ? { exp: users[ganador].exp, nivel: users[ganador].nivel } : null,
    perfilPerdedor: users[perdedor] ? { exp: users[perdedor].exp, nivel: users[perdedor].nivel } : null
  });

  delete games[partida.codigo];
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
      if (users[username]) return fn({ error: 'Ese usuario ya existe' });

      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      let codigo = generarCodigo();
      while (Object.values(users).some(u => u.codigo === codigo)) codigo = generarCodigo();

      users[username] = {
        passwordHash,
        exp: 0,
        nivel: 1,
        friends: [],
        codigo
      };

      usuarioActual = username;
      registrarSesion(socket, username);
      console.log(`[OK] Registrado: ${username}`);
      fn({
        success: true,
        usuario: username,
        nivel: 1,
        exp: 0,
        codigo
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

      const user = users[username];
      if (!user) return fn({ error: 'Usuario no encontrado' });

      const valido = await bcrypt.compare(password, user.passwordHash);
      if (!valido) return fn({ error: 'Contraseña incorrecta' });

      usuarioActual = username;
      registrarSesion(socket, username);
      console.log(`[OK] Login: ${username}`);
      fn({
        success: true,
        usuario: username,
        nivel: user.nivel,
        exp: user.exp,
        codigo: user.codigo
      });
    } catch (err) {
      console.error('[ERR] login:', err.message);
      if (typeof callback === 'function') callback({ error: 'Error interno del servidor' });
    }
  });

  // ---------- CREAR PARTIDA ----------
  socket.on('crear-partida', (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username } = data || {};
    if (!username || !users[username]) return fn({ error: 'Debes iniciar sesión primero' });

    // Abandonar partida previa si existe
    const previa = Object.values(games).find(g => g.p1 === username || g.p2 === username);
    if (previa && previa.enCurso) {
      return fn({ error: 'Ya tienes una partida en curso' });
    }
    if (previa) delete games[previa.codigo];

    const partida = nuevaPartida(username, `user:${username}`);
    console.log(`[OK] Partida creada: ${partida.codigo} por ${username}`);
    fn({ success: true, codigo: partida.codigo });
  });

  // ---------- UNIRSE A PARTIDA ----------
  socket.on('unirse-partida', (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username, codigo } = data || {};
    if (!username || !users[username]) return fn({ error: 'Debes iniciar sesión primero' });

    const partida = games[codigo];
    if (!partida) return fn({ error: 'No existe una partida con ese código' });
    if (partida.enCurso) return fn({ error: 'La partida ya está completa' });
    if (partida.p1 === username) return fn({ error: 'No puedes unirte a tu propia partida' });

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

    const manos = partida.estado[jugador].manos;
    const suma = sumaDedosVivos(manos);

    if (suma % 2 !== 0) {
      return socket.emit('error-juego', { mensaje: 'La suma de tus dedos no es par' });
    }
    if (suma < 2) {
      return socket.emit('error-juego', { mensaje: 'No tienes suficientes dedos para dividir' });
    }

    const mitad = suma / 2;
    manos.izq = { count: mitad, alive: true };
    manos.der = { count: mitad, alive: true };

    // Cambiar turno
    const oponente = jugador === 'p1' ? 'p2' : 'p1';
    partida.turnoActual = partida.estado[oponente].username;

    emitirAPartida(partida, 'partida-actualizada', {
      partida: vistaPublicaPartida(partida),
      mensaje: `${username} dividió sus manos en ${mitad} y ${mitad}`
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
  socket.on('solicitar-amigos', (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username } = data || {};
    const user = users[username];
    if (!user) return fn({ error: 'Usuario no válido' });

    const amigos = user.friends.map(nombre => ({
      nombre,
      online: usuarioConectado(nombre),
      codigo: users[nombre] ? users[nombre].codigo : '---'
    }));

    const solicitudes = (friendRequests[username] || [])
      .filter(r => r.estado === 'pendiente')
      .map(r => ({ de: r.de, fecha: r.fecha }));

    fn({ success: true, amigos, solicitudes });
  });

  // ---------- AMIGOS: AGREGAR ----------
  socket.on('agregar-amigo', (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username, codigoAmigo } = data || {};
    const user = users[username];
    if (!user) return fn({ error: 'Usuario no válido' });

    // Buscar usuario por codigo
    const nombreObjetivo = Object.keys(users).find(
      nombre => users[nombre].codigo === String(codigoAmigo).toUpperCase().trim()
    );

    if (!nombreObjetivo) return fn({ error: 'No existe ningún usuario con ese código' });
    if (nombreObjetivo === username) return fn({ error: 'No puedes agregarte a ti mismo' });
    if (user.friends.includes(nombreObjetivo)) return fn({ error: 'Ya son amigos' });

    if (!friendRequests[nombreObjetivo]) friendRequests[nombreObjetivo] = [];
    if (friendRequests[nombreObjetivo].some(r => r.de === username)) {
      return fn({ error: 'Ya enviaste una solicitud a este usuario' });
    }

    friendRequests[nombreObjetivo].push({ de: username, estado: 'pendiente', fecha: new Date() });

    // Notificar en tiempo real si está conectado
    io.to(`user:${nombreObjetivo}`).emit('solicitud-amistad-recibida', { de: username });

    console.log(`[OK] Solicitud de amistad: ${username} -> ${nombreObjetivo}`);
    fn({ success: true, mensaje: `Solicitud enviada a ${nombreObjetivo}` });
  });

  // ---------- AMIGOS: ACEPTAR ----------
  socket.on('aceptar-amistad', (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username, de } = data || {};
    const user = users[username];
    if (!user) return fn({ error: 'Usuario no válido' });

    const solicitudes = friendRequests[username] || [];
    const idx = solicitudes.findIndex(r => r.de === de && r.estado === 'pendiente');
    if (idx === -1) return fn({ error: 'No tienes solicitud de este usuario' });

    solicitudes.splice(idx, 1);
    if (!user.friends.includes(de)) user.friends.push(de);
    if (users[de] && !users[de].friends.includes(username)) users[de].friends.push(username);

    // Notificar a ambos
    io.to(`user:${de}`).emit('amistad-aceptada', { de: username });
    fn({ success: true, mensaje: `¡Ahora son amigos ${username} y ${de}!` });
  });

  // ---------- AMIGOS: RETAR A PARTIDA ----------
  socket.on('invitar-amigo', (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username, amigo } = data || {};
    if (!username || !users[username]) return fn({ error: 'Debes iniciar sesión' });
    if (!amigo || !users[amigo]) return fn({ error: 'Ese usuario no existe' });
    if (!users[username].friends.includes(amigo)) return fn({ error: 'Ese usuario no es tu amigo' });
    if (amigo === username) return fn({ error: 'No puedes retarte a ti mismo' });
    if (!usuarioConectado(amigo)) return fn({ error: `${amigo} no está conectado` });

    // Nadie en partida en curso
    const ocupado = Object.values(games).find(
      g => g.enCurso && (g.p1 === username || g.p2 === username || g.p1 === amigo || g.p2 === amigo)
    );
    if (ocupado) return fn({ error: 'Alguno de los dos ya está en una partida' });

    // Limpiar partida en espera del invitador (ya no la necesita)
    const enEspera = Object.values(games).find(g => !g.enCurso && g.p1 === username);
    if (enEspera) delete games[enEspera.codigo];

    pendingInvites[amigo] = username;
    io.to(`user:${amigo}`).emit('invitacion-recibida', { de: username });
    console.log(`[OK] Reto: ${username} -> ${amigo}`);
    fn({ success: true, mensaje: `Reto enviado a ${amigo}. Esperando respuesta...` });
  });

  // ---------- AMIGOS: RESPONDER RETO ----------
  socket.on('responder-invitacion', (data, callback) => {
    const fn = typeof callback === 'function' ? callback : () => {};
    const { username, de, aceptar } = data || {};
    if (!username || !users[username]) return fn({ error: 'Debes iniciar sesión' });

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

    // Nadie en partida en curso
    const ocupado = Object.values(games).find(
      g => g.enCurso && (g.p1 === de || g.p2 === de || g.p1 === username || g.p2 === username)
    );
    if (ocupado) return fn({ error: 'Alguno de los dos ya está en una partida' });

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

  // ---------- DESCONEXIÓN ----------
  socket.on('disconnect', () => {
    console.log(`[-] Desconexion: ${socket.id}`);
    if (usuarioActual) {
      // Multi-sesión: quitar solo ESTA sesión; limpiar solo si era la última
      const sesiones = onlineSockets[usuarioActual];
      if (sesiones) {
        sesiones.delete(socket.id);
        if (sesiones.size > 0) return; // el usuario sigue conectado en otra pestaña/dispositivo
        delete onlineSockets[usuarioActual];
      }

      // Si estaba en partida, el oponente gana
      const partida = Object.values(games).find(
        g => g.enCurso && (g.p1 === usuarioActual || g.p2 === usuarioActual)
      );
      if (partida) {
        const ganador = partida.p1 === usuarioActual ? partida.p2 : partida.p1;
        finalizarPartida(partida, ganador, `${usuarioActual} se desconectó`);
      }

      // Si esperaba oponente, eliminar su partida huérfana
      const huerfana = Object.values(games).find(
        g => !g.enCurso && g.p1 === usuarioActual
      );
      if (huerfana) delete games[huerfana.codigo];

      // Limpiar retos pendientes relacionados con este usuario
      if (pendingInvites[usuarioActual]) delete pendingInvites[usuarioActual];
      Object.keys(pendingInvites).forEach(receptor => {
        if (pendingInvites[receptor] === usuarioActual) delete pendingInvites[receptor];
      });
    }
  });
});

// ===== RUTAS HTTP DE SALUD =====
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    usuarios: Object.keys(users).length,
    partidas: Object.keys(games).length,
    conectados: Object.keys(onlineSockets).length
  });
});

// ===== INICIAR (solo si se ejecuta directamente, no al requerirlo en tests) =====
const PORT = process.env.PORT || 3001;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Servidor Deditos corriendo en http://localhost:${PORT}`);
  });
}

// Exportar lógica pura para pruebas automatizadas
module.exports = { ejecutarAtaque, estadoInicialManos, calcularNivel, generarCodigo, io };
