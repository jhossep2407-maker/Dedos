// ===== DEDITOS - CLIENTE =====

const config = {
  socket: null,
  conectado: false,
  username: null,
  miCodigo: null,
  partida: null,      // vista publica de la partida
  miJugador: null,   // 'p1' | 'p2'
  manoSeleccionada: null // 'izq' | 'der' seleccionada para atacar
};

// ===== REFERENCIAS DOM =====
const dom = {};
function initDom() {
  const ids = [
    'tela-login', 'tela-registrar', 'tela-juego', 'tela-amigos',
    'form-login', 'form-registrar', 'username', 'password',
    'username-reg', 'password-reg', 'mostrar-registrar', 'mostrar-login',
    'username-display', 'nivel-display', 'exp-display', 'indicador-turno', 'btn-salir',
    'panel-login',
    'panel-partida', 'mi-codigo-amigo', 'btn-copiar-codigo-amigo',
    'btn-crear-partida', 'btn-unirse-partida', 'btn-amigos', 'estado-partida',
    'tablero-juego', 'nombre-p1', 'nombre-p2', 'mano-p1-izq', 'mano-p1-der',
    'mano-p2-izq', 'mano-p2-der', 'total-p1', 'total-p2', 'codigo-sala',
    'modo-actual', 'mensaje-central', 'acciones-juego', 'hint-accion', 'btn-dividir',
    'resultado', 'titulo-resultado', 'descripcion-resultado', 'btn-jugar-de-nuevo',
    'solicitudes-lista', 'amigos-lista', 'btn-volver-juego',
    'codigo-amigo-input', 'btn-agregar-amigo',
    'invitacion-overlay', 'invitacion-texto', 'btn-aceptar-inv', 'btn-rechazar-inv',
    'tela-ranking', 'mi-puesto', 'tabla-ranking', 'btn-ranking', 'btn-volver-juego2'
  ];
  ids.forEach(id => dom[id] = document.getElementById(id));
  const faltantes = ids.filter(id => !dom[id]);
  if (faltantes.length) console.error('IDs faltantes en HTML:', faltantes);
}

// ===== INIT INMEDIATO (el script va al final del body: DOM ya listo) =====
initDom();
inicializarSocket();

// ===== AUTO-LOGIN: restaurar sesión guardada (si existe) =====
(function restaurarSesion() {
  const tokenGuardado = localStorage.getItem('deditos_token');
  if (!tokenGuardado) return; // sin sesión guardada: mostrar login normal

  config.socket.emit('verificar-sesion', { token: tokenGuardado }, (res) => {
    if (res && res.success) {
      entrarAlJuego(res, true); // entra directo al juego, sin pedir datos
    } else {
      // Token inválido o expirado: limpiarlo y quedarse en el login
      localStorage.removeItem('deditos_token');
    }
  });
})();

// ===== SOCKET =====
function inicializarSocket() {
  config.socket = io();

  config.socket.on('connect', () => {
    config.conectado = true;
    console.log('Socket conectado:', config.socket.id);
  });

  config.socket.on('connect_error', () => {
    config.conectado = false;
    notificar('Error', 'No se pudo conectar con el servidor', 'error');
  });

  // Eventos de partida
  config.socket.on('partida-iniciada', (data) => {
    notificar('¡A jugar!', data.mensaje, 'exito');
    alIniciarPartida(data.partida);
  });

  config.socket.on('partida-actualizada', (data) => {
    config.partida = data.partida;
    renderPartida();
    dom['mensaje-central'].textContent = data.mensaje;
  });

  config.socket.on('partida-finalizada', (data) => {
    mostrarResultado(data);
    // Refrescar el ranking tras cada partida (EXP cambió)
    cargarRanking();
  });

  config.socket.on('error-juego', (data) => {
    notificar('Movimiento inválido', data.mensaje, 'error');
  });

  // Eventos de amistad
  config.socket.on('solicitud-amistad-recibida', (data) => {
    notificar('Nueva solicitud', `${data.de} quiere ser tu amigo`, 'alerta');
  });

  config.socket.on('amistad-aceptada', (data) => {
    notificar('Amigos', `${data.de} aceptó tu solicitud`, 'exito');
  });

  // Eventos de reto (invitación a partida)
  config.socket.on('invitacion-recibida', (data) => {
    mostrarInvitacion(data.de);
  });

  config.socket.on('invitacion-rechazada', (data) => {
    notificar('Reto rechazado', `${data.de} rechazó tu invitación`, 'error');
  });
}

// ===== PANTALLAS =====
function mostrarPantalla(id) {
  ['tela-login', 'tela-juego', 'tela-amigos', 'tela-ranking'].forEach(t => {
    dom[t].classList.add('hidden');
  });
  dom[id].classList.remove('hidden');
}

// ===== LOGIN / REGISTRO =====
dom['form-login'].addEventListener('submit', (e) => {
  e.preventDefault();
  const username = dom['username'].value.trim();
  const password = dom['password'].value;
  if (!username || !password) return notificar('Error', 'Completa todos los campos', 'error');

  config.socket.emit('login', { username, password }, (res) => {
    if (res && res.success) {
      entrarAlJuego(res);
    } else {
      notificar('Error', (res && res.error) || 'Login fallido', 'error');
    }
  });
});

dom['form-registrar'].addEventListener('submit', (e) => {
  e.preventDefault();
  const username = dom['username-reg'].value.trim();
  const password = dom['password-reg'].value;
  if (!username || !password) return notificar('Error', 'Completa todos los campos', 'error');

  config.socket.emit('registrar', { username, password }, (res) => {
    if (res && res.success) {
      entrarAlJuego(res);
    } else {
      notificar('Error', (res && res.error) || 'Error al registrarse', 'error');
    }
  });
});

dom['mostrar-registrar'].addEventListener('click', () => {
  dom['panel-login'].classList.add('hidden');
  dom['tela-registrar'].classList.remove('hidden');
});

dom['mostrar-login'].addEventListener('click', () => {
  dom['tela-registrar'].classList.add('hidden');
  dom['panel-login'].classList.remove('hidden');
});

function entrarAlJuego(res, esRestauracion) {
  // Guardar token de sesión (persiste entre recargas del navegador)
  if (res.token) localStorage.setItem('deditos_token', res.token);
  config.username = res.usuario;
  config.miCodigo = res.codigo;
  dom['username-display'].textContent = res.usuario;
  dom['nivel-display'].textContent = `Nivel ${res.nivel}`;
  dom['exp-display'].textContent = `${res.exp} EXP`;
  dom['mi-codigo-amigo'].textContent = res.codigo;
  dom['estado-partida'].textContent = 'Crea una partida o únete con un código';
  mostrarPantalla('tela-juego');
  if (esRestauracion) {
    notificar('Sesión restaurada', `¡Hola de nuevo, ${res.usuario}!`, 'exito');
  } else {
    notificar('Bienvenido', `¡Hola ${res.usuario}!`, 'exito');
  }
}

// ===== PARTIDAS =====
dom['btn-crear-partida'].addEventListener('click', () => {
  config.socket.emit('crear-partida', { username: config.username }, (res) => {
    if (res && res.success) {
      dom['codigo-sala'].textContent = res.codigo;
      dom['estado-partida'].textContent = `Partida creada. Código: ${res.codigo} — esperando oponente...`;
      notificar('Partida creada', `Comparte el código ${res.codigo}`, 'exito');
    } else {
      notificar('Error', (res && res.error) || 'No se pudo crear', 'error');
    }
  });
});

dom['btn-unirse-partida'].addEventListener('click', () => {
  const codigo = prompt('Ingresa el código de la partida:');
  if (!codigo) return;
  config.socket.emit('unirse-partida', { username: config.username, codigo: codigo.toUpperCase().trim() }, (res) => {
    if (res && res.success) {
      dom['codigo-sala'].textContent = res.codigo;
    } else {
      notificar('Error', (res && res.error) || 'Código inválido', 'error');
    }
  });
});

function alIniciarPartida(partida) {
  config.partida = partida;
  config.miJugador = partida.p1 === config.username ? 'p1' : 'p2';
  config.manoSeleccionada = null;
  mostrarPantalla('tela-juego'); // por si estábamos en la pantalla de amigos
  dom['panel-partida'].classList.add('hidden');
  dom['tablero-juego'].classList.remove('hidden');
  dom['acciones-juego'].classList.remove('hidden');
  dom['codigo-sala'].textContent = partida.codigo;
  dom['nombre-p1'].textContent = partida.p1;
  dom['nombre-p2'].textContent = partida.p2;
  dom['resultado'].classList.add('hidden');
  renderPartida();
}

// ===== RENDER DE PARTIDA =====
function renderPartida() {
  const p = config.partida;
  if (!p || !p.enCurso) return;

  ['p1', 'p2'].forEach(j => {
    const manos = p.estado[j].manos;
    ['izq', 'der'].forEach(lado => {
      const el = dom[`mano-${j}-${lado}`];
      const mano = manos[lado];
      el.querySelector('.dedos').textContent = mano.count;
      el.querySelector('.estado').textContent = mano.alive ? 'Viva' : 'MUERTA';
      el.classList.toggle('muerta', !mano.alive);
      el.classList.toggle('seleccionada', config.miJugador === j && config.manoSeleccionada === lado);
    });
    dom[`total-${j}`].textContent =
      (manos.izq.alive ? manos.izq.count : 0) + (manos.der.alive ? manos.der.count : 0);
  });

  const esMiTurno = p.turnoActual === config.username;
  dom['indicador-turno'].textContent = esMiTurno ? 'ES TU TURNO' : `Turno de: ${p.turnoActual}`;
  dom['indicador-turno'].classList.toggle('tu-turno', esMiTurno);
  dom['hint-accion'].textContent = esMiTurno
    ? (config.manoSeleccionada ? 'Ahora toca la mano ENEMIGA a atacar' : 'Toca una de TUS manos')
    : 'Espera tu turno...';

  // Botón dividir: mi turno + suma par >= 2
  const misManos = p.estado[config.miJugador].manos;
  const suma = (misManos.izq.alive ? misManos.izq.count : 0) + (misManos.der.alive ? misManos.der.count : 0);
  dom['btn-dividir'].disabled = !(esMiTurno && suma % 2 === 0 && suma >= 2);
}

// ===== INTERACCIÓN: ATACAR =====
document.querySelectorAll('.mano').forEach(el => {
  el.addEventListener('click', () => {
    const p = config.partida;
    if (!p || !p.enCurso) return;
    if (p.turnoActual !== config.username) return;

    // id = mano-p1-izq etc
    const match = el.id.match(/^mano-(p1|p2)-(izq|der)$/);
    if (!match) return;
    const jugador = match[1];
    const lado = match[2];
    const mano = p.estado[jugador].manos[lado];
    if (!mano.alive) return notificar('Inválido', 'Esa mano está muerta', 'error');

    if (jugador === config.miJugador) {
      // Seleccionar mano atacante
      config.manoSeleccionada = lado;
      renderPartida();
    } else {
      // Atacar mano enemiga
      if (!config.manoSeleccionada) {
        return notificar('Espera', 'Primero selecciona TU mano atacante', 'alerta');
      }
      const atacante = config.manoSeleccionada;
      config.manoSeleccionada = null;
      config.socket.emit('atacar', {
        username: config.username,
        codigo: p.codigo,
        manoAtacante: atacante,
        manoObjetivo: lado
      });
    }
  });
});

// ===== DIVIDIR (acción libre: no pierdes el turno) =====
dom['btn-dividir'].addEventListener('click', () => {
  const p = config.partida;
  if (!p || !p.enCurso) return;
  const confirma = prompt('Divides tus dedos en mitades iguales (revive manos muertas).\nNo pierdes tu turno: después podrás atacar.\n¿Confirmar división? (sí/no)');
  if (!confirma || !confirma.toLowerCase().startsWith('s')) return;
  config.socket.emit('dividir-manos', { username: config.username, codigo: p.codigo });
  config.manoSeleccionada = null;
});

// ===== RESULTADO =====
function mostrarResultado(data) {
  config.partida = null;
  dom['tablero-juego'].classList.add('hidden');
  dom['acciones-juego'].classList.add('hidden');
  dom['resultado'].classList.remove('hidden');

  const gane = data.ganador === config.username;
  dom['titulo-resultado'].textContent = gane ? '¡GANASTE!' : 'Perdiste...';
  dom['descripcion-resultado'].textContent =
    `Ganador: ${data.ganador} (${data.motivo}). ` +
    `Tus EXP: +${gane ? data.expGanador : data.expPerdedor}`;

  const perfil = gane ? data.perfilGanador : data.perfilPerdedor;
  if (perfil) {
    dom['exp-display'].textContent = `${perfil.exp} EXP`;
    dom['nivel-display'].textContent = `Nivel ${perfil.nivel}`;
  }
  notificar(gane ? '¡Victoria!' : 'Derrota', data.motivo, gane ? 'exito' : 'error');
}

dom['btn-jugar-de-nuevo'].addEventListener('click', () => {
  dom['resultado'].classList.add('hidden');
  dom['panel-partida'].classList.remove('hidden');
  dom['estado-partida'].textContent = 'Crea una partida o únete con un código';
});

// ===== AMIGOS =====
dom['btn-amigos'].addEventListener('click', () => {
  mostrarPantalla('tela-amigos');
  cargarAmigos();
});

dom['btn-volver-juego'].addEventListener('click', () => {
  mostrarPantalla('tela-juego');
});

function cargarAmigos() {
  config.socket.emit('solicitar-amigos', { username: config.username }, (res) => {
    if (!res || !res.success) return;
    // Solicitudes
    dom['solicitudes-lista'].innerHTML = '';
    res.solicitudes.forEach(s => {
      const div = document.createElement('div');
      div.className = 'solicitud-item';
      div.innerHTML = `<span class="nombre-solicitante">${s.de}</span>`;
      const btn = document.createElement('button');
      btn.textContent = 'Aceptar';
      btn.className = 'btn-mini';
      btn.addEventListener('click', () => {
        config.socket.emit('aceptar-amistad', { username: config.username, de: s.de }, (r) => {
          if (r && r.success) {
            notificar('Amigos', `¡${s.de} y tú ahora son amigos!`, 'exito');
            cargarAmigos();
          } else {
            notificar('Error', (r && r.error) || 'Error al aceptar', 'error');
          }
        });
      });
      div.appendChild(btn);
      dom['solicitudes-lista'].appendChild(div);
    });
    if (res.solicitudes.length === 0) {
      dom['solicitudes-lista'].innerHTML = '<p class="vacio">Sin solicitudes pendientes</p>';
    }

    // Amigos
    dom['amigos-lista'].innerHTML = '';
    res.amigos.forEach(a => {
      const div = document.createElement('div');
      div.className = `amigo-item ${a.online ? 'activo retador' : 'inactivo'}`;
      div.innerHTML = `
        <div class="circulo-estado-amigo ${a.online ? 'circulo-verde' : 'circulo-rojo'}"></div>
        <div class="nombre-amigo">${a.nombre}</div>
        <div class="estado-texto">${a.online ? 'En línea — clic para retar' : 'Desconectado'}</div>
      `;
      div.addEventListener('click', () => {
        if (!a.online) {
          return notificar('Desconectado', `${a.nombre} no está en línea`, 'error');
        }
        // Retar al amigo a una partida
        config.socket.emit('invitar-amigo', { username: config.username, amigo: a.nombre }, (r) => {
          if (r && r.success) {
            notificar('Reto enviado', r.mensaje, 'exito');
            mostrarPantalla('tela-juego'); // esperar desde la pantalla del juego
          } else {
            notificar('Error', (r && r.error) || 'No se pudo enviar el reto', 'error');
          }
        });
      });
      dom['amigos-lista'].appendChild(div);
    });
    if (res.amigos.length === 0) {
      dom['amigos-lista'].innerHTML = '<p class="vacio">Aún no tienes amigos. ¡Agrega uno con su código!</p>';
    }
  });
}

// ===== RETOS DE AMIGOS (invitaciones) =====
let invitadorPendiente = null;

function mostrarInvitacion(de) {
  invitadorPendiente = de;
  dom['invitacion-texto'].textContent = `${de} quiere jugar contigo`;
  dom['invitacion-overlay'].classList.remove('hidden');
}

function cerrarInvitacion() {
  invitadorPendiente = null;
  dom['invitacion-overlay'].classList.add('hidden');
}

dom['btn-aceptar-inv'].addEventListener('click', () => {
  if (!invitadorPendiente) return;
  const de = invitadorPendiente;
  cerrarInvitacion();
  config.socket.emit('responder-invitacion', { username: config.username, de, aceptar: true }, (res) => {
    if (res && res.success && res.aceptado) {
      notificar('¡A jugar!', `Aceptaste el reto de ${de}`, 'exito');
      // 'partida-iniciada' llega del servidor y muestra el tablero
    } else {
      notificar('Error', (res && res.error) || 'No se pudo aceptar el reto', 'error');
    }
  });
});

dom['btn-rechazar-inv'].addEventListener('click', () => {
  if (!invitadorPendiente) return;
  const de = invitadorPendiente;
  cerrarInvitacion();
  config.socket.emit('responder-invitacion', { username: config.username, de, aceptar: false });
  notificar('Reto', `Rechazaste el reto de ${de}`, 'alerta');
});

dom['btn-agregar-amigo'].addEventListener('click', () => {
  const codigoAmigo = dom['codigo-amigo-input'].value.trim();
  if (!codigoAmigo) return notificar('Error', 'Ingresa un código', 'error');
  config.socket.emit('agregar-amigo', { username: config.username, codigoAmigo }, (res) => {
    if (res && res.success) {
      notificar('Enviado', res.mensaje, 'exito');
      dom['codigo-amigo-input'].value = '';
    } else {
      notificar('Error', (res && res.error) || 'Error al enviar solicitud', 'error');
    }
  });
});

// ===== RANKING GLOBAL =====

// Última respuesta del servidor (para re-renderizar sin volver a pedir)
let ultimoRanking = null;

function cargarRanking() {
  if (!config.username) return;
  config.socket.emit('solicitar-ranking', { username: config.username }, (res) => {
    if (res && res.success) {
      ultimoRanking = res;
      renderRanking(res);
    }
  });
}

function renderRanking(datos) {
  dom['mi-puesto'].textContent = datos.miPuesto
    ? `Tu puesto global: #${datos.miPuesto}`
    : 'Tu puesto global: --';

  const tabla = dom['tabla-ranking'];
  tabla.innerHTML = '';

  // Cabecera
  const cabecera = document.createElement('div');
  cabecera.className = 'fila-ranking cabecera';
  cabecera.innerHTML = `
    <span class="puesto">#</span>
    <span class="usuario">USUARIO</span>
    <span class="exp">EXP</span>
    <span class="nivel">NIVEL</span>
  `;
  tabla.appendChild(cabecera);

  // Top 25 con medallas para el podio
  const medallas = { 1: '🥇', 2: '🥈', 3: '🥉' };
  datos.top.forEach(u => {
    const fila = document.createElement('div');
    fila.className = 'fila-ranking';
    if (u.puesto <= 3) fila.classList.add(`top${u.puesto}`);
    if (u.username === config.username) fila.classList.add('propia');
    fila.dataset.puesto = u.puesto;
    fila.dataset.username = u.username;
    fila.innerHTML = `
      <span class="puesto">${medallas[u.puesto] || u.puesto}</span>
      <span class="usuario">${u.username}</span>
      <span class="exp">${u.exp}</span>
      <span class="nivel">Nv ${u.nivel}</span>
    `;
    tabla.appendChild(fila);
  });

  // Si estoy FUERA del top: separador + mi fila destacada
  if (datos.yo) {
    const sep = document.createElement('div');
    sep.className = 'separador-ranking';
    sep.textContent = '· · ·';
    tabla.appendChild(sep);

    const fila = document.createElement('div');
    fila.className = 'fila-ranking propia';
    fila.dataset.puesto = datos.yo.puesto;
    fila.dataset.username = datos.yo.username;
    fila.innerHTML = `
      <span class="puesto">${datos.yo.puesto}</span>
      <span class="usuario">${datos.yo.username}</span>
      <span class="exp">${datos.yo.exp}</span>
      <span class="nivel">Nv ${datos.yo.nivel}</span>
    `;
    tabla.appendChild(fila);
  }
}

// Abrir la pantalla de ranking (siempre trae datos frescos)
dom['btn-ranking'].addEventListener('click', () => {
  mostrarPantalla('tela-ranking');
  cargarRanking();
});

dom['btn-volver-juego2'].addEventListener('click', () => {
  mostrarPantalla('tela-juego');
});

// ===== COPIAR CÓDIGO =====
dom['btn-copiar-codigo-amigo'].addEventListener('click', () => {
  navigator.clipboard.writeText(config.miCodigo || '').then(() => {
    notificar('Copiado', 'Tu código de amigo está en el portapapeles', 'exito');
  });
});

// ===== SALIR =====
// ===== SALIR (cerrar sesión de verdad: borra el token) =====
dom['btn-salir'].addEventListener('click', () => {
  const token = localStorage.getItem('deditos_token');
  if (token) {
    config.socket.emit('cerrar-sesion', { token });
  }
  localStorage.removeItem('deditos_token');
  location.reload(); // al recargar ya no hay token -> aparece el login
});

// ===== NOTIFICACIONES =====
function notificar(titulo, mensaje, tipo) {
  const notif = document.createElement('div');
  notif.className = `notificacion ${tipo}`;
  notif.innerHTML = `<strong>${titulo}</strong><span>${mensaje}</span>`;
  document.body.appendChild(notif);
  setTimeout(() => notif.classList.add('visible'), 10);
  setTimeout(() => {
    notif.classList.remove('visible');
    setTimeout(() => notif.remove(), 300);
  }, 3000);
}
