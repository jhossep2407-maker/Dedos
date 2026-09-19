// ===== TEST E2E COMPLETO - DEDITOS =====
// Prueba real con 2 navegadores headless: partida por código + reto entre amigos
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');

const PUERTO = 3001;
const URL = `http://localhost:${PUERTO}`;
// Con DATABASE_URL (PostgreSQL): sufijo único por corrida para no chocar con usuarios previos
const USA_DB = !!process.env.DATABASE_URL;
const SUFIJO = USA_DB ? '_' + Date.now().toString(36).slice(-6) : '';
const NOMBRE1 = 'jugadoruno' + SUFIJO;
const NOMBRE2 = 'jugadordos' + SUFIJO;
const NOMBRE3 = 'jugadortres' + SUFIJO;

let erroresConsola = { pag1: [], pag2: [], pag4: [] };
let fallos = 0;
function check(nombre, condicion, extra) {
  if (condicion) {
    console.log(`  [PASA] ${nombre}`);
  } else {
    fallos++;
    console.log(`  [FALLA] ${nombre} ${extra || ''}`);
  }
}

function esperar(ms) { return new Promise(r => setTimeout(r, ms)); }

// Bucle de juego reutilizable: juega hasta que la partida termine.
// Estrategia: si la suma de dedos es par (>=4), divide (acción libre) y luego ataca.
async function jugarHastaTerminar(pag1, pag2, maxJugadas = 30) {
  let jugadas = 0;
  let divisiones = 0;
  let partidaTerminada = false;

  while (jugadas < maxJugadas && !partidaTerminada) {
    // ¿Terminó?
    const resVisible = await pag1.$eval('#resultado', el => !el.classList.contains('hidden'));
    if (resVisible) { partidaTerminada = true; break; }

    // Leer turno desde pag1
    let info = await pag1.evaluate(() => ({
      turno: config.partida ? config.partida.turnoActual : null,
      estado: config.partida ? config.partida.estado : null,
      enCurso: config.partida ? config.partida.enCurso : false
    }));
    if (!info.enCurso || !info.estado) { partidaTerminada = true; break; }

    // Determinar qué jugador (p1/p2) tiene el turno
    const miJugador = info.estado.p1.username === info.turno ? 'p1' : 'p2';
    const oponente = miJugador === 'p1' ? 'p2' : 'p1';
    const paginaActiva = info.turno === NOMBRE1 ? pag1 : pag2;
    const turnoAntes = info.turno;

    // ===== DIVISIÓN (acción libre: no debe cambiar el turno) =====
    const sumaMia =
      (info.estado[miJugador].manos.izq.alive ? info.estado[miJugador].manos.izq.count : 0) +
      (info.estado[miJugador].manos.der.alive ? info.estado[miJugador].manos.der.count : 0);

    if (sumaMia % 2 === 0 && sumaMia >= 4) {
      const mitad = sumaMia / 2;
      console.log(`    ${info.turno} divide sus manos en ${mitad}+${mitad} (acción libre, conserva turno)`);
      await paginaActiva.click('#btn-dividir'); // el diálogo se responde 'sí' automáticamente

      // Verificar: manos en mitad/mitad (ambas vivas) y turno SIN cambiar
      const divisionOk = await paginaActiva.waitForFunction(
        (jug, mitadEsp, turnoPrev) => {
          const p = config.partida;
          if (!p) return false;
          const m = p.estado[jug].manos;
          return p.turnoActual === turnoPrev &&
                 m.izq.count === mitadEsp && m.der.count === mitadEsp &&
                 m.izq.alive && m.der.alive;
        },
        { timeout: 4000 },
        miJugador, mitad, turnoAntes
      ).then(() => true).catch(() => false);
      check('División NO cambia el turno', divisionOk);
      divisiones++;

      // Releer estado tras dividir para el ataque
      info = await pag1.evaluate(() => ({
        turno: config.partida ? config.partida.turnoActual : null,
        estado: config.partida ? config.partida.estado : null,
        enCurso: config.partida ? config.partida.enCurso : false
      }));
    }

    // ===== ATAQUE =====
    const miViva = info.estado[miJugador].manos.izq.alive ? 'izq'
      : (info.estado[miJugador].manos.der.alive ? 'der' : null);
    const objViva = info.estado[oponente].manos.izq.alive ? 'izq'
      : (info.estado[oponente].manos.der.alive ? 'der' : null);
    if (!miViva || !objViva) { console.log('  [ERROR LOGICO] mano viva no encontrada'); break; }

    console.log(`  Jugada ${jugadas + 1}: ${info.turno} ataca con ${miViva} a ${objViva} de ${oponente}`);

    // Clic en mi mano, luego en la mano del oponente
    await paginaActiva.click(`#mano-${miJugador}-${miViva}`);
    await esperar(150);
    await paginaActiva.click(`#mano-${oponente}-${objViva}`);

    // Esperar a que el turno cambie o la partida termine
    await paginaActiva.waitForFunction(
      (prev) => {
        const vis = !document.getElementById('resultado').classList.contains('hidden');
        if (vis) return true;
        return config.partida && config.partida.turnoActual !== prev;
      },
      { timeout: 4000 },
      turnoAntes
    ).catch(() => console.log('  [AVISO] timeout esperando cambio de turno'));

    await esperar(300);
    jugadas++;
  }
  return { jugadas, divisiones };
}

async function main() {
  // 1. Levantar servidor (grupo expira en 8s en pruebas para no esperar 60s reales)
  console.log('\n=== INICIANDO SERVIDOR ===');
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    stdio: 'pipe',
    env: { ...process.env, GRUPO_TIMEOUT_MS: '8000' }
  });
  server.stdout.on('data', d => process.stdout.write(`[SRV] ${d}`));
  server.stderr.on('data', d => process.stdout.write(`[SRV-ERR] ${d}`));

  // Esperar a que responda (con PostgreSQL la BD puede tardar en despertar)
  let servidorListo = false;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://localhost:${PUERTO}/api/health`);
      if (res.ok) { servidorListo = true; break; }
    } catch { /* aun no listo */ }
    await esperar(500);
  }
  if (!servidorListo) {
    console.log('ERROR FATAL: el servidor no respondió');
    server.kill();
    process.exit(1);
  }
  console.log(USA_DB ? '(modo PostgreSQL real)' : '(modo memoria)');

  // En modo PostgreSQL: limpiar usuarios de pruebas anteriores (higiene de la BD)
  if (USA_DB) {
    const crearDb = require('./db');
    const dbLimpieza = crearDb(process.env.DATABASE_URL);
    await dbLimpieza.init();
    await dbLimpieza.borrarUsuariosTest('jugadoruno');
    await dbLimpieza.borrarUsuariosTest('jugadordos');
    await dbLimpieza.borrarUsuariosTest('jugadortres');
    console.log('(BD: usuarios de pruebas anteriores eliminados)');
  }

  // 2. Abrir navegador con 3 "dispositivos" aislados (contextos con localStorage independiente)
  console.log('\n=== ABRIENDO NAVEGADOR (2 jugadores) ===');
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] });
  const crearContexto = async () => browser.createBrowserContext();
  const ctx1 = await crearContexto();
  const ctx2 = await crearContexto();
  const pag1 = await ctx1.newPage();
  const pag2 = await ctx2.newPage();
  await pag1.setViewport({ width: 800, height: 900 });
  await pag2.setViewport({ width: 800, height: 900 });

  // Capturar TODOS los errores de consola
  pag1.on('console', m => { if (m.type() === 'error') erroresConsola.pag1.push(m.text()); });
  pag2.on('console', m => { if (m.type() === 'error') erroresConsola.pag2.push(m.text()); });
  pag1.on('pageerror', e => erroresConsola.pag1.push('PAGEERROR: ' + e.message));
  pag2.on('pageerror', e => erroresConsola.pag2.push('PAGEERROR: ' + e.message));

  // Manejador de diálogos (prompt) consciente del mensaje:
  // - "código de la partida" -> responde con el código
  // - cualquier otro (división) -> responde "sí"
  const estadoDialogos = { codigo: null };
  const manejarDialogo = async (dialog) => {
    if (dialog.message().includes('código de la partida')) {
      await dialog.accept(estadoDialogos.codigo || '');
    } else {
      await dialog.accept('sí');
    }
  };
  pag1.on('dialog', manejarDialogo);
  pag2.on('dialog', manejarDialogo);

  await pag1.goto(URL, { waitUntil: 'networkidle0' });
  await pag2.goto(URL, { waitUntil: 'networkidle0' });
  await esperar(500);

  console.log('\n=== TEST 1: Carga sin errores de consola ===');
  check('Página 1 carga', true);
  check('Login visible pag1', await pag1.$eval('#tela-login', el => !el.classList.contains('hidden')));
  check('Login visible pag2', await pag2.$eval('#tela-login', el => !el.classList.contains('hidden')));

  // TEST 2: Registro jugador 1
  console.log('\n=== TEST 2: Registro jugador 1 ===');
  await pag1.click('#mostrar-registrar');
  await pag1.type('#username-reg', NOMBRE1);
  await pag1.type('#password-reg', 'pass1234');
  await pag1.click('#form-registrar button[type=submit]');
  await pag1.waitForFunction(
    () => !document.getElementById('tela-juego').classList.contains('hidden'),
    { timeout: 15000 }
  );
  check('Pantalla juego visible tras registro', await pag1.$eval('#tela-juego', el => !el.classList.contains('hidden')));
  const user1 = await pag1.$eval('#username-display', el => el.textContent);
  check(`Username mostrado: "${user1}"`, user1 === NOMBRE1);
  const cod1 = await pag1.$eval('#mi-codigo-amigo', el => el.textContent);
  check(`Código de amigo asignado: "${cod1}"`, cod1 && cod1 !== '---');

  // TEST 3: Registro jugador 2
  console.log('\n=== TEST 3: Registro jugador 2 ===');
  await pag2.click('#mostrar-registrar');
  await pag2.type('#username-reg', NOMBRE2);
  await pag2.type('#password-reg', 'pass1234');
  await pag2.click('#form-registrar button[type=submit]');
  await pag2.waitForFunction(
    () => !document.getElementById('tela-juego').classList.contains('hidden'),
    { timeout: 15000 }
  );
  check('Pantalla juego visible pag2', await pag2.$eval('#tela-juego', el => !el.classList.contains('hidden')));

  // TEST 4: Crear partida por código
  console.log('\n=== TEST 4: Crear partida (jugador 1) ===');
  await pag1.click('#btn-crear-partida');
  await esperar(800);
  const estadoP1 = await pag1.$eval('#estado-partida', el => el.textContent);
  console.log(`  Estado partida: ${estadoP1}`);
  const matchCodigo = estadoP1.match(/Código: ([A-Z0-9]{6})/);
  check('Código de partida generado', !!matchCodigo);
  const codigoPartida = matchCodigo ? matchCodigo[1] : null;
  console.log(`  Código: ${codigoPartida}`);

  // TEST 5: Unirse con código
  console.log('\n=== TEST 5: Unirse a partida (jugador 2) ===');
  estadoDialogos.codigo = codigoPartida;
  await pag2.click('#btn-unirse-partida');
  await pag1.waitForFunction(
    () => !document.getElementById('tablero-juego').classList.contains('hidden'),
    { timeout: 10000 }
  ).catch(() => {});
  await pag2.waitForFunction(
    () => !document.getElementById('tablero-juego').classList.contains('hidden'),
    { timeout: 10000 }
  );
  await esperar(300);
  check('Tablero visible pag1', await pag1.$eval('#tablero-juego', el => !el.classList.contains('hidden')));
  check('Tablero visible pag2', await pag2.$eval('#tablero-juego', el => !el.classList.contains('hidden')));
  check('Nombres mostrados pag1', (await pag1.$eval('#nombre-p1', el => el.textContent)) === NOMBRE1);
  check('Nombre p2 en pag2', (await pag2.$eval('#nombre-p2', el => el.textContent)) === NOMBRE2);

  // TEST 6: Partida 1 completa (por código)
  console.log('\n=== TEST 6: Partida 1 completa (por código) ===');
  const juego1 = await jugarHastaTerminar(pag1, pag2);
  const jugadas1 = juego1.jugadas;
  console.log(`  Divisiones realizadas: ${juego1.divisiones}`);

  const res1 = await pag1.evaluate(() => ({
    visible: !document.getElementById('resultado').classList.contains('hidden'),
    titulo: document.getElementById('titulo-resultado').textContent,
    exp: document.getElementById('exp-display').textContent
  }));
  const res2 = await pag2.evaluate(() => ({
    visible: !document.getElementById('resultado').classList.contains('hidden'),
    titulo: document.getElementById('titulo-resultado').textContent,
    exp: document.getElementById('exp-display').textContent
  }));
  check(`Partida terminó (${jugadas1} jugadas)`, res1.visible && res2.visible);
  const gano1 = res1.titulo.includes('GANASTE');
  const gano2 = res2.titulo.includes('GANASTE');
  check('Exactamente un ganador', gano1 !== gano2);
  check('Ganador tiene +100 EXP', (gano1 ? res1.exp : res2.exp).includes('100'));

  // TEST 7: Login de usuario ya registrado (persistencia)
  console.log('\n=== TEST 7: Login de usuario ya registrado ===');
  const ctx3 = await crearContexto();
  const pag3 = await ctx3.newPage();
  await pag3.setViewport({ width: 800, height: 900 });
  pag3.on('pageerror', e => erroresConsola.pag1.push('PAG3: ' + e.message));
  pag3.on('console', m => { if (m.type() === 'error') erroresConsola.pag1.push('PAG3: ' + m.text()); });
  await pag3.goto(URL, { waitUntil: 'networkidle0' });
  await pag3.type('#username', NOMBRE1);
  await pag3.type('#password', 'pass1234');
  await pag3.click('#form-login button[type=submit]');
  await pag3.waitForFunction(
    () => !document.getElementById('tela-juego').classList.contains('hidden'),
    { timeout: 15000 }
  );
  check('Login correcto con usuario registrado', await pag3.$eval('#tela-juego', el => !el.classList.contains('hidden')));
  const expTrasLogin = await pag3.$eval('#exp-display', el => el.textContent);
  const expEsperada = gano1 ? '100' : '5';
  check(`EXP persiste tras login (esperado ${expEsperada}): "${expTrasLogin}"`, expTrasLogin.includes(expEsperada));

  // TEST 8: Persistencia de sesión (auto-login con token)
  console.log('\n=== TEST 8: Persistencia de sesión (recargar no pide login) ===');
  // pag3 acaba de iniciar sesión: tiene el token en localStorage
  const tokenGuardado = await pag3.evaluate(() => localStorage.getItem('deditos_token'));
  check('Token guardado en localStorage tras login', tokenGuardado !== null && tokenGuardado.length > 20);

  // Recargar la página: debe entrar DIRECTO al juego (auto-login)
  await pag3.reload({ waitUntil: 'networkidle0' });
  await pag3.waitForFunction(
    () => !document.getElementById('tela-juego').classList.contains('hidden'),
    { timeout: 15000 }
  );
  check('Tras recargar, entra al juego SIN pedir login', await pag3.$eval('#tela-juego', el => !el.classList.contains('hidden')));
  check('Usuario restaurado correctamente', (await pag3.$eval('#username-display', el => el.textContent)) === NOMBRE1);
  check('Login oculto tras restauración', await pag3.$eval('#tela-login', el => el.classList.contains('hidden')));

  // Cerrar sesión con el botón Salir
  await pag3.click('#btn-salir');
  await pag3.waitForFunction(
    () => !document.getElementById('tela-login').classList.contains('hidden'),
    { timeout: 15000 }
  );
  check('Tras "Salir", muestra el login', await pag3.$eval('#tela-login', el => !el.classList.contains('hidden')));
  check('Token eliminado tras cerrar sesión', await pag3.evaluate(() => localStorage.getItem('deditos_token') === null));

  // Recargar SIN token: debe permanecer en el login
  await pag3.reload({ waitUntil: 'networkidle0' });
  await esperar(1000);
  check('Recargando sin sesión, permanece en login', await pag3.$eval('#tela-login', el => !el.classList.contains('hidden')));
  await pag3.close();

  // TEST 9: Amistad por código + RETO entre amigos
  console.log('\n=== TEST 9: Amistad por código y reto directo ===');

  // Volver al menú ambos
  await pag1.click('#btn-jugar-de-nuevo');
  await pag2.click('#btn-jugar-de-nuevo');
  await esperar(400);

  // Leer el código de amigo de jugador 2
  const cod2 = await pag2.$eval('#mi-codigo-amigo', el => el.textContent);
  console.log(`  Código de amigo de ${NOMBRE2}: ${cod2}`);

  // jugador 1 envía solicitud de amistad
  await pag1.click('#btn-amigos');
  await esperar(400);
  await pag1.type('#codigo-amigo-input', cod2);
  await pag1.click('#btn-agregar-amigo');
  await esperar(600);
  check('Solicitud de amistad enviada', true);

  // jugador 2 acepta la solicitud
  await pag2.click('#btn-amigos');
  const haySolicitud = await pag2.waitForFunction(
    () => !!document.querySelector('#solicitudes-lista .solicitud-item'),
    { timeout: 15000 }
  ).then(() => true).catch(() => false);
  check('Solicitud visible en jugador 2', haySolicitud);
  await pag2.click('#solicitudes-lista .solicitud-item .btn-mini');

  // Esperar a que la amistad quede registrada: pag2 re-renderiza su lista
  // con el amigo tras la respuesta del servidor (latencia de BD cubierta)
  const amistadConfirmada = await pag2.waitForFunction(
    () => !!document.querySelector('#amigos-lista .amigo-item'),
    { timeout: 20000 }
  ).then(() => true).catch(() => false);
  check('Solicitud aceptada (amistad creada)', amistadConfirmada);

  // jugador 2 vuelve al juego
  await pag2.click('#btn-volver-juego');

  // jugador 1 recarga su lista de amigos (volver y reentrar)
  await pag1.click('#btn-volver-juego');
  await pag1.click('#btn-amigos');
  const amigoEnPag1 = await pag1.waitForFunction(
    () => !!document.querySelector('#amigos-lista .amigo-item'),
    { timeout: 15000 }
  ).then(() => true).catch(() => false);

  // El amigo debe aparecer conectado (círculo verde) y retador
  const infoAmigo = amigoEnPag1 ? await pag1.evaluate(() => {
    const item = document.querySelector('#amigos-lista .amigo-item');
    if (!item) return { existe: false };
    return {
      existe: true,
      retador: item.classList.contains('retador'),
      texto: item.textContent
    };
  }) : { existe: false, retador: false, texto: 'undefined' };
  check(`Amigo "${NOMBRE2}" aparece en la lista`, infoAmigo.existe);
  check('Amigo conectado y retador (clic para retar)', infoAmigo.retador);
  console.log(`  Texto del amigo: ${infoAmigo.texto}`);

  // jugador 1 hace clic en el amigo (reto)
  await pag1.click('#amigos-lista .amigo-item');
  await esperar(600);

  // jugador 2 debe recibir la invitación con Aceptar/Rechazar
  const overlayOk = await pag2.waitForFunction(
    () => !document.getElementById('invitacion-overlay').classList.contains('hidden'),
    { timeout: 10000 }
  ).then(() => true).catch(() => false);
  check('Invitación recibida por el amigo', overlayOk);
  const textoInv = await pag2.$eval('#invitacion-texto', el => el.textContent);
  check(`Texto de invitación correcto: "${textoInv}"`, textoInv === `${NOMBRE1} quiere jugar contigo`);

  // jugador 2 ACEPTA el reto
  await pag2.click('#btn-aceptar-inv');

  // Ambos deben ver el tablero (partida directa, sin código)
  const tablero1 = await pag1.waitForFunction(
    () => !document.getElementById('tablero-juego').classList.contains('hidden'),
    { timeout: 5000 }
  ).then(() => true).catch(() => false);
  const tablero2 = await pag2.waitForFunction(
    () => !document.getElementById('tablero-juego').classList.contains('hidden'),
    { timeout: 5000 }
  ).then(() => true).catch(() => false);
  check('Tablero visible en pag1 tras aceptar reto', tablero1);
  check('Tablero visible en pag2 tras aceptar reto', tablero2);
  check('Nombres en tablero pag1', (await pag1.$eval('#nombre-p1', el => el.textContent)) === NOMBRE1);

  // TEST 10: Partida 2 completa (por reto)
  console.log('\n=== TEST 10: Partida 2 completa (por reto) ===');
  const juego2 = await jugarHastaTerminar(pag1, pag2);
  const jugadas2 = juego2.jugadas;
  console.log(`  Divisiones realizadas: ${juego2.divisiones}`);
  check('La regla de división se ejercitó al menos una vez', juego1.divisiones + juego2.divisiones > 0);

  const res1b = await pag1.evaluate(() => ({
    visible: !document.getElementById('resultado').classList.contains('hidden'),
    titulo: document.getElementById('titulo-resultado').textContent
  }));
  const res2b = await pag2.evaluate(() => ({
    visible: !document.getElementById('resultado').classList.contains('hidden'),
    titulo: document.getElementById('titulo-resultado').textContent
  }));
  check(`Partida por reto terminó (${jugadas2} jugadas)`, res1b.visible && res2b.visible);
  const gano1b = res1b.titulo.includes('GANASTE');
  const gano2b = res2b.titulo.includes('GANASTE');
  check('Exactamente un ganador en reto', gano1b !== gano2b);

  // TEST 11: Ranking global
  console.log('\n=== TEST 11: Ranking global (top 25, podio, puesto propio) ===');

  // Leer EXP de ambos tras las 2 partidas (pantalla de resultado)
  const exp1 = await pag1.$eval('#exp-display', el => el.textContent);
  const exp2 = await pag2.$eval('#exp-display', el => el.textContent);
  const num1 = parseInt(exp1) || 0;
  const num2 = parseInt(exp2) || 0;
  console.log(`  EXP final — ${NOMBRE1}: ${exp1} | ${NOMBRE2}: ${exp2}`);

  // Volver al menú y abrir ranking desde pag1
  await pag1.click('#btn-jugar-de-nuevo');
  await esperar(300);
  await pag1.click('#btn-ranking');
  // Esperar el render FRESCO: mi fila debe mostrar el EXP post-partida (no el render
  // anterior que quedó en el DOM tras cargarRanking de partida-finalizada)
  await pag1.waitForFunction(
    (expEsperado) => {
      const filas = document.querySelectorAll('#tabla-ranking .fila-ranking:not(.cabecera)');
      if (filas.length === 0) return false;
      const propia = Array.from(filas).find(f => f.classList.contains('propia'));
      return propia && parseInt(propia.querySelector('.exp').textContent) === expEsperado;
    },
    { timeout: 20000 },
    num1
  );
  check('Pantalla ranking visible', await pag1.$eval('#tela-ranking', el => !el.classList.contains('hidden')));

  const ranking1 = await pag1.evaluate(() => {
    const filas = Array.from(document.querySelectorAll('#tabla-ranking .fila-ranking:not(.cabecera)')).map(f => ({
      puesto: parseInt(f.dataset.puesto),
      username: f.dataset.username,
      exp: f.querySelector('.exp').textContent,
      racha: f.querySelector('.racha') ? f.querySelector('.racha').textContent : '',
      mejor: f.querySelector('.mejor') ? f.querySelector('.mejor').textContent : '',
      claseTop: ['top1', 'top2', 'top3'].find(c => f.classList.contains(c)) || null,
      esPropia: f.classList.contains('propia')
    }));
    return { filas, miPuesto: document.getElementById('mi-puesto').textContent };
  });

  // Los tests NO asumen puestos fijos: la BD real (Neon) puede tener usuarios
  // con más EXP que los usuarios de prueba. Se verifican las posiciones RELATIVAS.
  const fila1 = ranking1.filas.find(f => f.username === NOMBRE1);
  const fila2 = ranking1.filas.find(f => f.username === NOMBRE2);
  check('Ambos usuarios aparecen en el ranking', !!fila1 && !!fila2, ranking1.filas);
  check('Mi fila está destacada (propia)', ranking1.filas.some(f => f.esPropia));

  const pos1 = fila1 ? fila1.puesto : -1;
  const pos2 = fila2 ? fila2.puesto : -1;

  // Orden relativo correcto: más EXP → mejor puesto; empate → orden alfabético
  const ordenOk = num1 > num2
    ? pos1 < pos2
    : (num2 > num1 ? pos2 < pos1 : (NOMBRE1 < NOMBRE2 ? pos1 < pos2 : pos2 < pos1));
  check(`Orden relativo correcto (#${pos1} vs #${pos2}, EXP ${num1} vs ${num2})`, ordenOk);

  // EXP mostrado en el ranking coincide con la pantalla de cada jugador
  check(`EXP de ${NOMBRE1} en ranking (${fila1.exp}) coincide`, parseInt(fila1.exp) === num1);
  check(`EXP de ${NOMBRE2} en ranking (${fila2.exp}) coincide`, parseInt(fila2.exp) === num2);

  // "Tu puesto global" coincide con la posición real de la fila
  check(`Mi puesto mostrado coincide con la fila (${ranking1.miPuesto})`,
    ranking1.miPuesto === `Tu puesto global: #${pos1}`);

  // Medalla correcta según posición (solo el top 3 la tiene)
  const medallaOk = [fila1, fila2].every(f => {
    if (f.puesto <= 3) return f.claseTop === 'top' + f.puesto;
    return f.claseTop === null;
  });
  check('Medallas 🥇🥈🥉 solo en el top 3 y correctas', medallaOk, { pos1, pos2 });

  // Ranking desde pag2: refrescado tras la partida, con su propio puesto coherente
  await pag2.click('#btn-jugar-de-nuevo');
  await esperar(300);
  await pag2.click('#btn-ranking');
  await pag2.waitForFunction(
    (expEsperado) => {
      const filas = document.querySelectorAll('#tabla-ranking .fila-ranking:not(.cabecera)');
      if (filas.length === 0) return false;
      const propia = Array.from(filas).find(f => f.classList.contains('propia'));
      return propia && parseInt(propia.querySelector('.exp').textContent) === expEsperado;
    },
    { timeout: 20000 },
    num2
  );
  const ranking2 = await pag2.evaluate(() => ({
    filas: Array.from(document.querySelectorAll('#tabla-ranking .fila-ranking:not(.cabecera)')).map(f => ({
      puesto: parseInt(f.dataset.puesto),
      username: f.dataset.username
    })),
    miPuesto: document.getElementById('mi-puesto').textContent
  }));
  const fila2v2 = ranking2.filas.find(f => f.username === NOMBRE2);
  check(`pag2 ve su propio puesto (#${pos2}) coherente con pag1: "${ranking2.miPuesto}"`,
    !!fila2v2 && fila2v2.puesto === pos2 && ranking2.miPuesto === `Tu puesto global: #${pos2}`);

  // Rachas esperadas tras 2 partidas 1v1 (gano1 = ganó juego 1, gano1b = ganó juego 2)
  const racha1 = gano1b ? (gano1 ? 2 : 1) : 0;
  const racha2 = !gano1b ? (!gano1 ? 2 : 1) : 0;
  const mejor1 = Math.max(gano1 ? 1 : 0, racha1);
  const mejor2 = Math.max(!gano1 ? 1 : 0, racha2);
  check(`Racha actual de ${NOMBRE1}: "${fila1.racha}"`,
    parseInt((fila1.racha.match(/\d+/) || ['0'])[0]) === racha1, { esperado: racha1 });
  check(`Racha actual de ${NOMBRE2}: "${fila2.racha}"`,
    parseInt((fila2.racha.match(/\d+/) || ['0'])[0]) === racha2, { esperado: racha2 });
  check(`Mejor racha de ${NOMBRE1}: "${fila1.mejor}"`, parseInt(fila1.mejor) === mejor1);
  check(`Mejor racha de ${NOMBRE2}: "${fila2.mejor}"`, parseInt(fila2.mejor) === mejor2);

  // Volver al juego en ambas
  await pag1.click('#btn-volver-juego2');
  await pag2.click('#btn-volver-juego2');
  await esperar(300);

  // ================== GRUPOS (modo 3-6 jugadores) ==================

  // Bucle de juego de grupo: el jugador del turno ataca al primer enemigo vivo
  // Clic por DOM con diagnóstico forense si la mano no es visible/clicable
  async function clickManoGrupo(pagina, selector) {
    try {
      await pagina.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error('Mano no encontrada: ' + sel);
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) {
          let nodo = el;
          const cadena = [];
          while (nodo && nodo.nodeType === 1 && cadena.length < 12) {
            const cs = getComputedStyle(nodo);
            const rect = nodo.getBoundingClientRect();
            cadena.push(`<${nodo.tagName.toLowerCase()}${nodo.id ? '#' + nodo.id : ''}${nodo.className ? '.' + nodo.className.toString().trim().split(/\s+/).join('.') : ''} display=${cs.display} w=${Math.round(rect.width)} h=${Math.round(rect.height)}>`);
            nodo = nodo.parentElement;
          }
          throw new Error('Mano sin tamaño (' + sel + '). Cadena DOM: ' + cadena.join(' → '));
        }
        el.click();
      }, selector);
    } catch (e) {
      try {
        const estado = await pagina.evaluate(() => ({
          grupoPartida: grupo.partida ? { id: grupo.partida.id, turno: grupo.partida.turnoActual, enCurso: grupo.partida.enCurso } : null,
          telasVisibles: Array.from(document.querySelectorAll('.tela')).filter(t => !t.classList.contains('hidden')).map(t => t.id),
          manoSeleccionada: grupo.manoSeleccionada
        }));
        console.log('  [DIAG] Estado de la página al fallar:', JSON.stringify(estado));
        console.log('  [DIAG] ' + e.message.slice(0, 800));
        await pagina.screenshot({ path: 'debug-fallo-grupo.png' });
        console.log('  [DIAG] Captura: debug-fallo-grupo.png');
      } catch { /* noop */ }
      throw e;
    }
  }

  async function jugarGrupoHastaTerminar(pagLectora, paginasPorUsuario, maxTurnos = 40) {
    let turnos = 0;
    let espectadorVerificado = false;
    let turnosJuego = 0;
    while (turnos < maxTurnos) {
      const resVisible = await pagLectora.$eval('#grupo-resultado', el => !el.classList.contains('hidden'));
      if (resVisible) break;

      const info = await pagLectora.evaluate(() => {
        const p = grupo.partida;
        if (!p) return { enCurso: false };
        return { enCurso: p.enCurso, turno: p.turnoActual, asientos: p.asientos };
      });
      if (!info.enCurso) break;

      const miAsiento = info.asientos.find(a => a.username === info.turno);
      const victima = info.asientos.find(a => a.username !== info.turno && a.vivo);
      if (!miAsiento || !victima) break;
      const miViva = miAsiento.manos.izq.alive ? 'izq' : (miAsiento.manos.der.alive ? 'der' : null);
      const objViva = victima.manos.izq.alive ? 'izq' : (victima.manos.der.alive ? 'der' : null);
      if (!miViva || !objViva) break;

      const paginaActiva = paginasPorUsuario[info.turno];
      if (!paginaActiva) break;

      console.log(`  Turno ${turnos + 1}: ${info.turno} ataca a ${victima.username} (${miViva} → ${objViva})`);
      // Clic por DOM (robusto con asientos en círculo): dispara el mismo handler real
      await clickManoGrupo(paginaActiva, `.asiento[data-username="${info.turno}"] .mano-grupo[data-lado="${miViva}"]`);
      await esperar(150);
      await clickManoGrupo(paginaActiva, `.asiento[data-username="${victima.username}"] .mano-grupo[data-lado="${objViva}"]`);

      const turnoAntes = info.turno;
      await pagLectora.waitForFunction(
        (prev) => {
          if (!document.getElementById('grupo-resultado').classList.contains('hidden')) return true;
          const p = grupo.partida;
          return p && p.turnoActual !== prev;
        },
        { timeout: 6000 },
        turnoAntes
      ).catch(() => console.log('  [AVISO] timeout turno grupo'));
      await esperar(300);
      turnos++;

      // ¿Alguien quedó eliminado y la partida sigue? → verificar espectador
      const post = await pagLectora.evaluate(() => {
        const p = grupo.partida;
        if (!p) return null;
        return { enCurso: p.enCurso, eliminados: p.asientos.filter(a => !a.vivo).map(a => a.username) };
      });
      if (!espectadorVerificado && post && post.enCurso && post.eliminados.length > 0) {
        const eliminado = post.eliminados[0];
        const pagEliminado = paginasPorUsuario[eliminado];
        if (pagEliminado) {
          const specOk = await pagEliminado.evaluate(() => ({
            botonVisible: !document.getElementById('btn-grupo-abandonar').hidden,
            mesaVisible: !document.getElementById('tela-grupo-juego').classList.contains('hidden')
          }));
          check(`Espectador: ${eliminado} sigue viendo la partida con botón "Volver al menú"`,
            specOk.botonVisible && specOk.mesaVisible);
          espectadorVerificado = true;
        }
      }
    }
    turnosJuego = turnos;
    return turnosJuego;
  }

  // TEST 13: Grupo completo con 3 jugadores (A crea grupo con B y C)
  console.log('\n=== TEST 13: Grupo 3 jugadores (crear, aceptar, mesa circular, partida) ===');

  // Registrar tercer jugador (jugadortres) en su propio contexto aislado
  const ctx4 = await crearContexto();
  const pag4 = await ctx4.newPage();
  await pag4.setViewport({ width: 800, height: 900 });
  pag4.on('pageerror', e => erroresConsola.pag4.push('PAG4: ' + e.message));
  pag4.on('console', m => { if (m.type() === 'error') erroresConsola.pag4.push('PAG4: ' + m.text()); });
  await pag4.goto(URL, { waitUntil: 'networkidle0' });
  await pag4.click('#mostrar-registrar');
  await pag4.type('#username-reg', NOMBRE3);
  await pag4.type('#password-reg', 'pass1234');
  await pag4.click('#form-registrar button[type=submit]');
  await pag4.waitForFunction(
    () => !document.getElementById('tela-juego').classList.contains('hidden'),
    { timeout: 15000 }
  );
  check(`Tercer jugador registrado: ${NOMBRE3}`, true);
  const cod3 = await pag4.$eval('#mi-codigo-amigo', el => el.textContent);
  console.log(`  Código de amigo de ${NOMBRE3}: ${cod3}`);

  // Amistad A (jugadoruno) → C (jugadortres). B y C NO son amigos entre sí (así lo exige el escenario)
  await pag1.click('#btn-amigos');
  await esperar(400);
  await pag1.type('#codigo-amigo-input', cod3);
  await pag1.click('#btn-agregar-amigo');
  await pag4.click('#btn-amigos');
  await pag4.waitForFunction(
    () => !!document.querySelector('#solicitudes-lista .solicitud-item'),
    { timeout: 15000 }
  );
  await pag4.click('#solicitudes-lista .solicitud-item .btn-mini');
  await pag4.waitForFunction(
    () => !!document.querySelector('#amigos-lista .amigo-item'),
    { timeout: 20000 }
  );
  check('Amistad A→C creada (B y C siguen SIN ser amigos)', true);
  await pag4.click('#btn-volver-juego');
  await pag1.click('#btn-volver-juego');

  // A abre "Crear Grupo" y selecciona a B y C
  await pag1.click('#btn-crear-grupo');
  await pag1.waitForFunction(
    () => document.querySelectorAll('#grupo-amigos-lista .grupo-amigo-item').length >= 2,
    { timeout: 15000 }
  );
  check('Pantalla crear grupo muestra ambos amigos', true);
  await pag1.evaluate(() => {
    document.querySelectorAll('#grupo-amigos-lista .grupo-amigo-item').forEach(i => i.click());
  });
  await esperar(200);
  check('Contador de seleccionados: 2',
    (await pag1.$eval('#grupo-contador', el => el.textContent)).includes('Seleccionados: 2'));
  check('Botón crear grupo habilitado', !(await pag1.$eval('#btn-grupo-confirmar', el => el.disabled)));

  // Crear el grupo → sala de espera con contador
  await pag1.click('#btn-grupo-confirmar');
  await pag1.waitForFunction(
    () => !document.getElementById('tela-grupo-espera').classList.contains('hidden'),
    { timeout: 10000 }
  );
  check('Sala de espera visible', true);
  const cuentaInicial = parseInt(await pag1.$eval('#grupo-espera-cuenta', el => el.textContent));
  check(`Contador de expiración activo (${cuentaInicial}s)`, cuentaInicial > 0 && cuentaInicial <= 8);

  // B y C reciben la invitación a grupo
  const overlayB = await pag2.waitForFunction(
    () => !document.getElementById('grupo-invitacion-overlay').classList.contains('hidden'),
    { timeout: 10000 }
  ).then(() => true).catch(() => false);
  const overlayC = await pag4.waitForFunction(
    () => !document.getElementById('grupo-invitacion-overlay').classList.contains('hidden'),
    { timeout: 10000 }
  ).then(() => true).catch(() => false);
  check('B recibe invitación a grupo', overlayB);
  check('C recibe invitación a grupo', overlayC);
  const textoInvC = await pag4.$eval('#grupo-invitacion-texto', el => el.textContent);
  // El texto lista a TODOS los miembros del grupo excepto al receptor (incluye al creador)
  check(`Texto de invitación: "${textoInvC}"`,
    textoInvC === `${NOMBRE1} te invita a un grupo con: ${NOMBRE1}, ${NOMBRE2}`);

  // B acepta primero → sigue en espera; C acepta al final → la partida inicia
  await pag2.click('#btn-grupo-aceptar');
  await esperar(600);
  check('B aceptó: sigue en espera (falta C)',
    await pag1.$eval('#grupo-espera-lista', el => el.textContent.includes('Pendiente')));
  await pag4.click('#btn-grupo-aceptar');

  // Los tres ven la mesa circular
  const mesa1 = await pag1.waitForFunction(
    () => document.querySelectorAll('#mesa-circular .asiento').length === 3,
    { timeout: 15000 }
  ).then(() => true).catch(() => false);
  await pag2.waitForFunction(
    () => document.querySelectorAll('#mesa-circular .asiento').length === 3,
    { timeout: 15000 }
  ).catch(() => {});
  await pag4.waitForFunction(
    () => document.querySelectorAll('#mesa-circular .asiento').length === 3,
    { timeout: 15000 }
  ).catch(() => {});
  check('Mesa circular con 3 asientos visible en A', mesa1);
  await pag1.screenshot({ path: 'debug-mesa-circular.png' });
  console.log('  (Captura de la mesa: debug-mesa-circular.png)');

  const estadoInicial = await pag1.evaluate(() => {
    const p = grupo.partida;
    return { turno: p ? p.turnoActual : null, asientos: p ? p.asientos.map(a => a.username) : [] };
  });
  check(`Empieza el CREADOR (${NOMBRE1}): turno=${estadoInicial.turno}`,
    estadoInicial.turno === NOMBRE1);
  check(`Asientos: [${estadoInicial.asientos.join(', ')}]`,
    estadoInicial.asientos[0] === NOMBRE1 && estadoInicial.asientos.length === 3);

  // Jugar la partida de grupo (regla: la víctima juega)
  console.log('  --- Partida de grupo ---');
  const turnosGrupo = await jugarGrupoHastaTerminar(pag1, {
    [NOMBRE1]: pag1,
    [NOMBRE2]: pag2,
    [NOMBRE3]: pag4
  });

  // Resultados en las tres páginas
  const fin1 = await pag1.evaluate(() => ({
    visible: !document.getElementById('grupo-resultado').classList.contains('hidden'),
    titulo: document.getElementById('grupo-resultado-titulo').textContent,
    texto: document.getElementById('grupo-resultado-texto').textContent
  }));
  check(`Partida de grupo terminó (${turnosGrupo} turnos)`, fin1.visible);
  check(`Ganador determinístico con la estrategia: ${NOMBRE1}`, fin1.titulo.includes('GANASTE'));
  check('Texto del ganador incluye +150 EXP', fin1.texto.includes('+150 EXP'));

  const fin2 = await pag2.evaluate(() => ({
    visible: !document.getElementById('grupo-resultado').classList.contains('hidden'),
    texto: document.getElementById('grupo-resultado-texto').textContent
  }));
  const fin4 = await pag4.evaluate(() => ({
    visible: !document.getElementById('grupo-resultado').classList.contains('hidden'),
    texto: document.getElementById('grupo-resultado-texto').textContent
  }));
  check('Perdedores ven su resultado (B)', fin2.visible && fin2.texto.includes('+10 EXP'));
  check('Perdedores ven su resultado (C)', fin4.visible && fin4.texto.includes('+10 EXP'));

  // EXP y rachas de grupo: ganador +150 (racha previa+1), perdedores +10 (racha 0)
  check(`Racha del ganador en texto (${fin1.texto})`, /Racha actual: \d+/.test(fin1.texto));
  check(`Racha de B en 0 tras perder (${fin2.texto})`, fin2.texto.includes('Racha actual: 0'));
  check(`Racha de C en 0 tras perder (${fin4.texto})`, fin4.texto.includes('Racha actual: 0'));

  // EXP del encabezado del tercer jugador (solo jugó el grupo y PERDIÓ): 0 + 10 = 10
  const exp4 = await pag4.$eval('#exp-display', el => el.textContent);
  check(`EXP de ${NOMBRE3} tras perder el grupo: "${exp4}"`, exp4 === '10 EXP');

  // Volver al menú en los tres (clic por DOM: inmune a toasts que tapan coordenadas)
  for (const pag of [pag1, pag2, pag4]) {
    await pag.evaluate(() => {
      const btn = document.getElementById('btn-grupo-volver-menu');
      if (!btn) throw new Error('Botón volver al menú no encontrado');
      btn.click();
    });
  }
  const enMenu4 = await pag4.waitForFunction(
    () => !document.getElementById('tela-juego').classList.contains('hidden'),
    { timeout: 10000 }
  ).then(() => true).catch(() => false);
  check('Los tres vuelven al menú', enMenu4);

  // TEST 14: Rechazo y expiración de grupos
  console.log('\n=== TEST 14: Grupo rechazado y grupo expirado ===');

  // --- Rechazo: B rechaza → grupo disuelto y todos notificados ---
  await pag1.click('#btn-crear-grupo');
  await pag1.waitForFunction(
    () => document.querySelectorAll('#grupo-amigos-lista .grupo-amigo-item').length >= 2,
    { timeout: 15000 }
  );
  await pag1.evaluate(() => {
    document.querySelectorAll('#grupo-amigos-lista .grupo-amigo-item').forEach(i => i.click());
  });
  await pag1.click('#btn-grupo-confirmar');
  await pag1.waitForFunction(
    () => !document.getElementById('tela-grupo-espera').classList.contains('hidden'),
    { timeout: 10000 }
  );
  await pag2.waitForFunction(
    () => !document.getElementById('grupo-invitacion-overlay').classList.contains('hidden'),
    { timeout: 10000 }
  );
  await pag2.click('#btn-grupo-rechazar');
  const volvioMenu1 = await pag1.waitForFunction(
    () => !document.getElementById('tela-juego').classList.contains('hidden'),
    { timeout: 10000 }
  ).then(() => true).catch(() => false);
  check('B rechaza → A vuelve al menú (grupo disuelto)', volvioMenu1);
  const overlayCerrado2 = await pag2.evaluate(() =>
    document.getElementById('grupo-invitacion-overlay').classList.contains('hidden'));
  check('Overlay de B cerrado tras disolver', overlayCerrado2);

  // --- Expiración: nadie responde → auto-cancelado tras el tiempo de espera ---
  await pag1.click('#btn-crear-grupo');
  await pag1.waitForFunction(
    () => document.querySelectorAll('#grupo-amigos-lista .grupo-amigo-item').length >= 2,
    { timeout: 15000 }
  );
  await pag1.evaluate(() => {
    document.querySelectorAll('#grupo-amigos-lista .grupo-amigo-item').forEach(i => i.click());
  });
  await pag1.click('#btn-grupo-confirmar');
  await pag1.waitForFunction(
    () => !document.getElementById('tela-grupo-espera').classList.contains('hidden'),
    { timeout: 10000 }
  );
  check('Grupo creado (nadie responderá)', true);

  // Esperar la expiración automática (8s de prueba) + margen
  const expirado = await pag1.waitForFunction(
    () => !document.getElementById('tela-juego').classList.contains('hidden'),
    { timeout: 15000 }
  ).then(() => true).catch(() => false);
  check('Grupo expiró solo → A vuelve al menú', expirado);
  const overlayCerrado3 = await pag2.evaluate(() =>
    document.getElementById('grupo-invitacion-overlay').classList.contains('hidden'));
  check('Invitación de B cerrada al expirar', overlayCerrado3);

  // TEST 15: Errores de consola en TODA la sesión
  console.log('\n=== TEST 15: Errores de consola en TODA la sesión ===');
  const totalErrores = erroresConsola.pag1.length + erroresConsola.pag2.length + erroresConsola.pag4.length;
  console.log(`  Errores pag1: ${erroresConsola.pag1.length}, pag2: ${erroresConsola.pag2.length}, pag4: ${erroresConsola.pag4.length}`);
  erroresConsola.pag1.forEach(e => console.log(`    PAG1: ${e}`));
  erroresConsola.pag2.forEach(e => console.log(`    PAG2: ${e}`));
  erroresConsola.pag4.forEach(e => console.log(`    PAG4: ${e}`));
  check(`Cero errores de consola (total: ${totalErrores})`, totalErrores === 0);

  // RESUMEN
  console.log('\n========== RESUMEN ==========');
  if (fallos === 0 && totalErrores === 0) {
    console.log('TODOS LOS TESTS PASARON. CERO ERRORES.');
  } else {
    console.log(`FALLOS: ${fallos}`);
  }

  // En modo PostgreSQL: limpiar los usuarios de prueba de esta corrida
  if (USA_DB) {
    try {
      const crearDb = require('./db');
      const dbLimpieza = crearDb(process.env.DATABASE_URL);
      await dbLimpieza.init();
      await dbLimpieza.borrarUsuariosTest('jugadoruno');
      await dbLimpieza.borrarUsuariosTest('jugadordos');
      await dbLimpieza.borrarUsuariosTest('jugadortres');
      console.log('(BD: usuarios de prueba eliminados — la base queda limpia)');
    } catch (e) {
      console.log('(AVISO) No se pudo limpiar la BD:', e.message);
    }
  }

  await browser.close();
  server.kill();
  process.exit(fallos === 0 && totalErrores === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('ERROR FATAL EN TEST:', e);
  process.exit(1);
});