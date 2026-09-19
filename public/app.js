// ===== DEDITOS - CLIENTE =====

const config = {
  socket: null,
  conectado: false,
  username: null,
  miCodigo: null,
  partida: null,      // vista publica de la partida 1v1
  miJugador: null,   // 'p1' | 'p2'
  manoSeleccionada: null // 'izq' | 'der' seleccionada para atacar
};

// Estado del modo GRUPO (3-6 jugadores, apartado adicional)
const grupo = {
  partida: null,          // vista de la partida de grupo
  esperando: null,        // vista del grupo en espera
  manoSeleccionada: null,  // mano propia seleccionada para atacar
  seleccionados: [],      // amigos marcados en la pantalla de crear grupo
  invitacionPendiente: null, // { grupoId, de, jugadores }
  intervaloCuenta: null   // intervalo del contador de la sala de espera
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
    'tela-ranking', 'mi-puesto', 'tabla-ranking', 'btn-ranking', 'btn-volver-juego2',
    'btn-crear-grupo',
    'tela-grupo-crear', 'grupo-amigos-lista', 'grupo-contador', 'btn-grupo-confirmar', 'btn-grupo-volver',
    'tela-grupo-espera', 'grupo-espera-cuenta', 'grupo-espera-lista', 'btn-cancelar-grupo',
    'tela-grupo-juego', 'grupo-username-display', 'grupo-indicador-turno', 'grupo-mensaje',
    'mesa-circular', 'btn-grupo-dividir', 'btn-grupo-abandonar',
    'grupo-resultado', 'grupo-resultado-titulo', 'grupo-resultado-texto', 'btn-grupo-volver-menu',
    'grupo-invitacion-overlay', 'grupo-invitacion-texto', 'btn-grupo-aceptar', 'btn-grupo-rechazar'
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

  // ===== Eventos de GRUPO (modo 3-6 jugadores) =====
  config.socket.on('grupo-invitacion', (data) => {
    mostrarInvitacionGrupo(data);
  });

  config.socket.on('grupo-actualizado', (data) => {
    grupo.esperando = data.grupo;
    if (!dom['tela-grupo-espera'].classList.contains('hidden')) {
      renderGrupoEspera(data.grupo);
    }
  });

  config.socket.on('grupo-cancelado', (data) => {
    // Cerrar cualquier pantalla de grupo y volver al menú
    detenerCuentaGrupo();
    cerrarInvitacionGrupo();
    if (!dom['tela-grupo-espera'].classList.contains('hidden') ||
        !dom['tela-grupo-juego'].classList.contains('hidden')) {
      mostrarPantalla('tela-juego');
    }
    notificar('Grupo cancelado', data.motivo, 'error');
    grupo.esperando = null;
  });

  config.socket.on('grupo-partida-iniciada', (data) => {
    detenerCuentaGrupo();
    alIniciarPartidaGrupo(data.partida);
  });

  config.socket.on('grupo-partida-actualizada', (data) => {
    grupo.partida = data.partida;
    renderMesaGrupo();
    dom['grupo-mensaje'].textContent = data.mensaje;
  });

  config.socket.on('grupo-eliminado', (data) => {
    notificar('Eliminado', data.mensaje, 'error');
    dom['btn-grupo-abandonar'].hidden = false;
  });

  config.socket.on('grupo-partida-finalizada', (data) => {
    mostrarResultadoGrupo(data);
  });

  config.socket.on('grupo-error', (data) => {
    notificar('Inválido', data.mensaje, 'error');
  });
}

// ===== PANTALLAS =====
function mostrarPantalla(id) {
  ['tela-login', 'tela-juego', 'tela-amigos', 'tela-ranking',
   'tela-grupo-crear', 'tela-grupo-espera', 'tela-grupo-juego'].forEach(t => {
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

  const perfil = gane ? data.perfilGanador : data.perfilPerdedor;
  if (perfil) {
    dom['exp-display'].textContent = `${perfil.exp} EXP`;
    dom['nivel-display'].textContent = `Nivel ${perfil.nivel}`;
  }
  dom['descripcion-resultado'].textContent =
    `Ganador: ${data.ganador} (${data.motivo}). ` +
    `Tus EXP: +${gane ? data.expGanador : data.expPerdedor}. ` +
    (perfil && perfil.racha !== undefined ? `Racha actual: ${perfil.racha} 🔥` : '');
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
  cabecera.className = 'fila-ranking cabecera ranking-6col';
  cabecera.innerHTML = `
    <span class="puesto">#</span>
    <span class="usuario">USUARIO</span>
    <span class="exp">EXP</span>
    <span class="nivel">NIVEL</span>
    <span class="racha">RACHA</span>
    <span class="mejor">MEJOR</span>
  `;
  tabla.appendChild(cabecera);

  const medallas = { 1: '🥇', 2: '🥈', 3: '🥉' };

  const crearFila = (u, propio, fueraTop) => {
    const fila = document.createElement('div');
    fila.className = 'fila-ranking ranking-6col';
    if (u.puesto <= 3 && !fueraTop) fila.classList.add(`top${u.puesto}`);
    if (propio) fila.classList.add('propia');
    fila.dataset.puesto = u.puesto;
    fila.dataset.username = u.username;
    fila.innerHTML = `
      <span class="puesto">${fueraTop ? u.puesto : (medallas[u.puesto] || u.puesto)}</span>
      <span class="usuario">${u.username}</span>
      <span class="exp">${u.exp}</span>
      <span class="nivel">Nv ${u.nivel}</span>
      <span class="racha">${(u.racha || 0) > 0 ? '🔥 ' + u.racha : '0'}</span>
      <span class="mejor">${u.mejorRacha || 0}</span>
    `;
    return fila;
  };

  // Top 25
  datos.top.forEach(u => {
    tabla.appendChild(crearFila(u, u.username === config.username, false));
  });

  // Si estoy FUERA del top: separador + mi fila destacada
  if (datos.yo) {
    const sep = document.createElement('div');
    sep.className = 'separador-ranking';
    sep.textContent = '· · ·';
    tabla.appendChild(sep);
    tabla.appendChild(crearFila(datos.yo, true, true));
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

// ==================================================================
// ===== MODO GRUPO (3-6 jugadores) — apartado adicional ============
// ==================================================================

// ---- Invitación a grupo ----
function mostrarInvitacionGrupo(data) {
  grupo.invitacionPendiente = data;
  const otros = (data.jugadores || []).filter(j => j !== config.username);
  dom['grupo-invitacion-texto'].textContent = `${data.de} te invita a un grupo con: ${otros.join(', ')}`;
  dom['grupo-invitacion-overlay'].classList.remove('hidden');
}

function cerrarInvitacionGrupo() {
  grupo.invitacionPendiente = null;
  dom['grupo-invitacion-overlay'].classList.add('hidden');
}

dom['btn-grupo-aceptar'].addEventListener('click', () => {
  const inv = grupo.invitacionPendiente;
  if (!inv) return;
  const data = inv;
  cerrarInvitacionGrupo();
  config.socket.emit('responder-grupo', { username: config.username, grupoId: data.grupoId, aceptar: true }, (res) => {
    if (res && res.success) {
      if (res.aceptado) {
        // Protección anti-carrera: si 'grupo-partida-iniciada' llegó antes que este
        // callback, ya estamos en el juego → NO volver a la sala de espera
        const juegoActivo = grupo.partida && !dom['tela-grupo-juego'].classList.contains('hidden');
        if (juegoActivo) {
          notificar('¡Aceptaste!', '¡Grupo completo, a jugar!', 'exito');
          return;
        }
        notificar('¡Aceptaste!', 'Esperando a que los demás acepten...', 'exito');
        grupo.esperando = {
          id: data.grupoId,
          creador: data.de,
          invitados: (data.jugadores || []).filter(j => j !== data.de)
            .map(j => ({ username: j, estado: j === config.username ? 'aceptado' : 'pendiente' })),
          segundos: data.segundos || 60
        };
        mostrarPantalla('tela-grupo-espera');
        renderGrupoEspera(grupo.esperando);
        iniciarCuentaGrupo(grupo.esperando.segundos);
      } else {
        notificar('Grupo', res.motivo || 'El grupo se disolvió', 'error');
      }
    } else {
      notificar('Error', (res && res.error) || 'No se pudo aceptar', 'error');
    }
  });
});

dom['btn-grupo-rechazar'].addEventListener('click', () => {
  const inv = grupo.invitacionPendiente;
  if (!inv) return;
  const grupoId = inv.grupoId;
  cerrarInvitacionGrupo();
  config.socket.emit('responder-grupo', { username: config.username, grupoId, aceptar: false });
  notificar('Grupo', 'Rechazaste la invitación al grupo', 'alerta');
});

// ---- Pantalla: crear grupo ----
dom['btn-crear-grupo'].addEventListener('click', () => {
  grupo.seleccionados = [];
  mostrarPantalla('tela-grupo-crear');
  cargarAmigosGrupo();
});

function cargarAmigosGrupo() {
  config.socket.emit('solicitar-amigos', { username: config.username }, (res) => {
    if (!res || !res.success) return;
    const lista = dom['grupo-amigos-lista'];
    lista.innerHTML = '';
    if (res.amigos.length === 0) {
      lista.innerHTML = '<p class="vacio">No tienes amigos aún. ¡Agrega algunos primero!</p>';
      actualizarContadorGrupo(0);
      return;
    }
    res.amigos.forEach(a => {
      const item = document.createElement('div');
      item.className = 'grupo-amigo-item' + (a.online ? '' : ' desconectado');
      item.dataset.username = a.nombre;
      item.innerHTML = `
        <span class="grupo-amigo-check"></span>
        <span class="grupo-amigo-nombre">${a.nombre}</span>
        <span class="estado-texto">${a.online ? 'En línea' : 'Desconectado'}</span>
      `;
      if (a.online) {
        item.addEventListener('click', () => {
          const idx = grupo.seleccionados.indexOf(a.nombre);
          if (idx === -1) grupo.seleccionados.push(a.nombre);
          else grupo.seleccionados.splice(idx, 1);
          item.classList.toggle('seleccionado', idx === -1);
          actualizarContadorGrupo(grupo.seleccionados.length);
        });
      }
      lista.appendChild(item);
    });
    actualizarContadorGrupo(0);
  });
}

function actualizarContadorGrupo(n) {
  dom['grupo-contador'].textContent = `Seleccionados: ${n} (mínimo 2 además de ti)`;
  dom['btn-grupo-confirmar'].disabled = !(n >= 2 && n <= 5);
}

dom['btn-grupo-confirmar'].addEventListener('click', () => {
  if (grupo.seleccionados.length < 2) return;
  config.socket.emit('crear-grupo', { username: config.username, invitados: [...grupo.seleccionados] }, (res) => {
    if (res && res.success) {
      grupo.esperando = res.grupo;
      mostrarPantalla('tela-grupo-espera');
      renderGrupoEspera(res.grupo);
      iniciarCuentaGrupo(res.grupo.segundos);
      notificar('Grupo creado', 'Esperando respuestas...', 'exito');
    } else {
      notificar('Error', (res && res.error) || 'No se pudo crear el grupo', 'error');
    }
  });
});

dom['btn-grupo-volver'].addEventListener('click', () => mostrarPantalla('tela-juego'));

// ---- Sala de espera ----
function renderGrupoEspera(g) {
  const lista = dom['grupo-espera-lista'];
  lista.innerHTML = '';

  const filaCreador = document.createElement('div');
  filaCreador.className = 'grupo-espera-item';
  filaCreador.innerHTML = `
    <span class="grupo-amigo-nombre">${g.creador}</span>
    <span class="estado-grupo aceptado">CREADOR</span>
  `;
  lista.appendChild(filaCreador);

  g.invitados.forEach(i => {
    const fila = document.createElement('div');
    fila.className = 'grupo-espera-item';
    fila.innerHTML = `
      <span class="grupo-amigo-nombre">${i.username}</span>
      <span class="estado-grupo ${i.estado === 'aceptado' ? 'aceptado' : 'pendiente'}">
        ${i.estado === 'aceptado' ? '✔ Aceptó' : '⏳ Pendiente'}
      </span>
    `;
    lista.appendChild(fila);
  });

  // Solo el creador puede cancelar
  dom['btn-cancelar-grupo'].style.display = (g.creador === config.username) ? 'block' : 'none';
}

function iniciarCuentaGrupo(segundos) {
  detenerCuentaGrupo();
  let restante = segundos;
  dom['grupo-espera-cuenta'].textContent = restante;
  grupo.intervaloCuenta = setInterval(() => {
    restante--;
    if (restante <= 0) {
      detenerCuentaGrupo();
      dom['grupo-espera-cuenta'].textContent = '0';
      return;
    }
    dom['grupo-espera-cuenta'].textContent = restante;
  }, 1000);
}

function detenerCuentaGrupo() {
  if (grupo.intervaloCuenta) {
    clearInterval(grupo.intervaloCuenta);
    grupo.intervaloCuenta = null;
  }
}

dom['btn-cancelar-grupo'].addEventListener('click', () => {
  if (!grupo.esperando) return;
  config.socket.emit('cancelar-grupo', { username: config.username, grupoId: grupo.esperando.id }, (res) => {
    if (res && !res.success) notificar('Error', res.error, 'error');
  });
});

// ---- Partida de grupo: mesa circular ----
function alIniciarPartidaGrupo(partida) {
  grupo.partida = partida;
  grupo.manoSeleccionada = null;
  dom['grupo-username-display'].textContent = config.username;
  dom['grupo-resultado'].classList.add('hidden');
  dom['mesa-circular'].style.display = ''; // restaurar la mesa (oculta al mostrar resultado)
  dom['btn-grupo-abandonar'].hidden = true;
  dom['grupo-mensaje'].textContent = '';
  mostrarPantalla('tela-grupo-juego');
  renderMesaGrupo();
}

function renderMesaGrupo() {
  const p = grupo.partida;
  if (!p) return;
  const cont = dom['mesa-circular'];
  cont.innerHTML = '';

  // Mesa redonda (fondo)
  const tabla = document.createElement('div');
  tabla.className = 'mesa-tabla';
  cont.appendChild(tabla);

  const N = p.asientos.length;
  const miIdx = p.asientos.findIndex(a => a.username === config.username);
  const w = cont.clientWidth || 640;
  const h = cont.clientHeight || 560;
  const cx = w / 2;
  const cy = h / 2;
  const radio = Math.min(w, h) * 0.42;

  const esMiTurno = p.turnoActual === config.username;
  const miAsiento = p.asientos[miIdx];
  const estoyEliminado = miAsiento && !miAsiento.vivo;

  p.asientos.forEach((a, i) => {
    // Mi asiento queda ABAJO; los demás en sentido horario
    const angulo = Math.PI / 2 + ((i - miIdx) * 2 * Math.PI / N);
    const x = cx + radio * Math.cos(angulo);
    const y = cy + radio * Math.sin(angulo);

    const asiento = document.createElement('div');
    asiento.className = 'asiento'
      + (a.username === config.username ? ' yo' : '')
      + (a.vivo ? '' : ' eliminado')
      + (a.username === p.turnoActual && p.enCurso ? ' turno' : '');
    asiento.dataset.username = a.username;
    asiento.style.left = `${x}px`;
    asiento.style.top = `${y}px`;

    const nombre = document.createElement('div');
    nombre.className = 'asiento-nombre';
    nombre.textContent = a.username + (a.username === config.username ? ' (tú)' : '');
    asiento.appendChild(nombre);

    const manosDiv = document.createElement('div');
    manosDiv.className = 'manos';
    ['izq', 'der'].forEach(lado => {
      const mano = a.manos[lado];
      const manoEl = document.createElement('div');
      manoEl.className = 'mano-grupo'
        + (mano.alive ? '' : ' muerta')
        + (a.username === config.username && grupo.manoSeleccionada === lado ? ' seleccionada' : '');
      manoEl.dataset.lado = lado;
      manoEl.innerHTML = `<span class="dedos">${mano.count}</span>`;
      manosDiv.appendChild(manoEl);
    });
    asiento.appendChild(manosDiv);

    const estado = document.createElement('div');
    estado.className = 'estado-asiento';
    estado.textContent = a.vivo ? '' : 'ELIMINADO';
    asiento.appendChild(estado);

    cont.appendChild(asiento);
  });

  // Indicador de turno
  dom['grupo-indicador-turno'].textContent = !p.enCurso
    ? 'Partida terminada'
    : (esMiTurno ? 'ES TU TURNO' : `Turno de: ${p.turnoActual}`);
  dom['grupo-indicador-turno'].classList.toggle('tu-turno', esMiTurno && p.enCurso);

  // Botón dividir (acción libre): mi turno, vivo, suma par >= 2
  if (miAsiento) {
    const suma = (miAsiento.manos.izq.alive ? miAsiento.manos.izq.count : 0) +
                 (miAsiento.manos.der.alive ? miAsiento.manos.der.count : 0);
    dom['btn-grupo-dividir'].disabled = !(p.enCurso && esMiTurno && !estoyEliminado && suma % 2 === 0 && suma >= 2);
  } else {
    dom['btn-grupo-dividir'].disabled = true;
  }

  // Botón "Volver al menú": solo espectadores (eliminados) o partida terminada
  dom['btn-grupo-abandonar'].hidden = !(estoyEliminado || !p.enCurso);
}

// Clic en manos de la mesa (delegación de eventos)
dom['mesa-circular'].addEventListener('click', (e) => {
  const manoEl = e.target.closest('.mano-grupo');
  if (!manoEl) return;
  const p = grupo.partida;
  if (!p || !p.enCurso) return;

  const asientoEl = manoEl.closest('.asiento');
  const dueno = asientoEl.dataset.username;
  const lado = manoEl.dataset.lado;
  const asientoDueno = p.asientos.find(a => a.username === dueno);
  if (!asientoDueno) return;

  const esMiTurno = p.turnoActual === config.username;
  const miAsiento = p.asientos.find(a => a.username === config.username);
  if (!esMiTurno || !miAsiento || !miAsiento.vivo) return;

  if (dueno === config.username) {
    // Seleccionar mi mano atacante
    if (!asientoDueno.manos[lado].alive) {
      return notificar('Inválido', 'Esa mano está muerta', 'error');
    }
    if (grupo.manoSeleccionada === lado) {
      grupo.manoSeleccionada = null; // clic de nuevo = deseleccionar
    } else {
      grupo.manoSeleccionada = lado;
    }
    renderMesaGrupo();
  } else {
    // Atacar mano de otro jugador
    if (!asientoDueno.vivo) return;
    if (!asientoDueno.manos[lado].alive) {
      return notificar('Inválido', 'Esa mano está muerta', 'error');
    }
    if (!grupo.manoSeleccionada) {
      return notificar('Espera', 'Primero selecciona TU mano atacante', 'alerta');
    }
    const manoAtacante = grupo.manoSeleccionada;
    grupo.manoSeleccionada = null;
    config.socket.emit('grupo-atacar', {
      username: config.username,
      grupoId: p.id,
      oponente: dueno,
      manoAtacante,
      manoObjetivo: lado
    });
    renderMesaGrupo();
  }
});

// Dividir en grupo (acción libre: no consume turno)
dom['btn-grupo-dividir'].addEventListener('click', () => {
  const p = grupo.partida;
  if (!p || !p.enCurso) return;
  const confirma = prompt('Divides tus dedos en mitades iguales (revive manos muertas).\nNo pierdes tu turno: después podrás atacar.\n¿Confirmar división? (sí/no)');
  if (!confirma || !confirma.toLowerCase().startsWith('s')) return;
  config.socket.emit('grupo-dividir', { username: config.username, grupoId: p.id });
  grupo.manoSeleccionada = null;
});

// Espectador: salir de la partida de grupo
dom['btn-grupo-abandonar'].addEventListener('click', () => {
  const p = grupo.partida;
  if (!p) return volverMenuGrupo();
  config.socket.emit('abandonar-grupo', { username: config.username, grupoId: p.id }, (res) => {
    if (res && res.success) volverMenuGrupo();
    else notificar('Error', (res && res.error) || 'No se pudo salir', 'error');
  });
});

// Resultado de la partida de grupo
function mostrarResultadoGrupo(data) {
  const perfil = (data.perfiles && data.perfiles[config.username]) || {};
  const gane = data.ganador === config.username;

  dom['grupo-resultado-titulo'].textContent = gane ? '¡GANASTE EL GRUPO!' : 'Quedaste eliminado';
  dom['grupo-resultado-texto'].textContent =
    `Ganador: ${data.ganador}. Ganaste +${perfil.expGanada} EXP. ` +
    `Racha actual: ${perfil.racha !== undefined ? perfil.racha : 0} 🔥`;
  dom['grupo-resultado'].classList.remove('hidden');
  dom['mesa-circular'].style.display = 'none'; // el resultado queda visible sin scroll
  dom['btn-grupo-dividir'].disabled = true;
  dom['btn-grupo-abandonar'].hidden = true;
  dom['grupo-indicador-turno'].textContent = 'Partida terminada';
  dom['grupo-indicador-turno'].classList.remove('tu-turno');
  grupo.partida = null;

  // Actualizar el EXP/nivel del encabezado principal
  if (perfil.exp !== undefined) {
    dom['exp-display'].textContent = `${perfil.exp} EXP`;
  }
  if (perfil.nivel !== undefined) {
    dom['nivel-display'].textContent = `Nivel ${perfil.nivel}`;
  }

  notificar(gane ? '¡Victoria!' : 'Derrota', `${data.ganador} ganó el grupo`, gane ? 'exito' : 'error');
}

dom['btn-grupo-volver-menu'].addEventListener('click', volverMenuGrupo);

function volverMenuGrupo() {
  grupo.partida = null;
  grupo.manoSeleccionada = null;
  dom['grupo-resultado'].classList.add('hidden');
  mostrarPantalla('tela-juego');
  dom['estado-partida'].textContent = 'Crea una partida o únete con un código';
  cargarRanking(); // refrescar EXP/rachas del ranking
}

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
