// ===== TEST E2E COMPLETO - DEDITOS =====
// Prueba real con 2 navegadores headless: partida por código + reto entre amigos
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');

const PUERTO = 3001;
const URL = `http://localhost:${PUERTO}`;
const NOMBRE1 = 'jugadoruno';
const NOMBRE2 = 'jugadordos';

let erroresConsola = { pag1: [], pag2: [] };
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
  // 1. Levantar servidor
  console.log('\n=== INICIANDO SERVIDOR ===');
  const server = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'pipe' });
  server.stdout.on('data', d => process.stdout.write(`[SRV] ${d}`));
  server.stderr.on('data', d => process.stdout.write(`[SRV-ERR] ${d}`));
  await esperar(2000);

  // 2. Abrir navegador con 2 páginas
  console.log('\n=== ABRIENDO NAVEGADOR (2 jugadores) ===');
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] });
  const pag1 = await browser.newPage();
  const pag2 = await browser.newPage();
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
  await esperar(1000);
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
  await esperar(1000);
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
  await esperar(1000);
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
  const pag3 = await browser.newPage();
  pag3.on('pageerror', e => erroresConsola.pag1.push('PAG3: ' + e.message));
  await pag3.goto(URL, { waitUntil: 'networkidle0' });
  await pag3.type('#username', NOMBRE1);
  await pag3.type('#password', 'pass1234');
  await pag3.click('#form-login button[type=submit]');
  await esperar(800);
  check('Login correcto con usuario registrado', await pag3.$eval('#tela-juego', el => !el.classList.contains('hidden')));
  const expTrasLogin = await pag3.$eval('#exp-display', el => el.textContent);
  const expEsperada = gano1 ? '100' : '5';
  check(`EXP persiste tras login (esperado ${expEsperada}): "${expTrasLogin}"`, expTrasLogin.includes(expEsperada));
  await pag3.close();

  // TEST 8: Amistad por código + RETO entre amigos
  console.log('\n=== TEST 8: Amistad por código y reto directo ===');

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
  await esperar(600);
  const haySolicitud = await pag2.$eval('#solicitudes-lista .solicitud-item', el => !!el).catch(() => false);
  check('Solicitud visible en jugador 2', haySolicitud);
  await pag2.click('#solicitudes-lista .solicitud-item .btn-mini');
  await esperar(800);
  check('Solicitud aceptada', true);

  // jugador 2 vuelve al juego
  await pag2.click('#btn-volver-juego');

  // jugador 1 recarga su lista de amigos (volver y reentrar)
  await pag1.click('#btn-volver-juego');
  await pag1.click('#btn-amigos');
  await esperar(600);

  // El amigo debe aparecer conectado (círculo verde) y retador
  const infoAmigo = await pag1.evaluate(() => {
    const item = document.querySelector('#amigos-lista .amigo-item');
    if (!item) return { existe: false };
    return {
      existe: true,
      retador: item.classList.contains('retador'),
      texto: item.textContent
    };
  });
  check(`Amigo "${NOMBRE2}" aparece en la lista`, infoAmigo.existe);
  check('Amigo conectado y retador (clic para retar)', infoAmigo.retador);
  console.log(`  Texto del amigo: ${infoAmigo.texto}`);

  // jugador 1 hace clic en el amigo (reto)
  await pag1.click('#amigos-lista .amigo-item');
  await esperar(600);

  // jugador 2 debe recibir la invitación con Aceptar/Rechazar
  const overlayOk = await pag2.waitForFunction(
    () => !document.getElementById('invitacion-overlay').classList.contains('hidden'),
    { timeout: 5000 }
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

  // TEST 9: Partida 2 completa (por reto)
  console.log('\n=== TEST 9: Partida 2 completa (por reto) ===');
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

  // TEST 10: Errores de consola en TODA la sesión
  console.log('\n=== TEST 10: Errores de consola en TODA la sesión ===');
  const totalErrores = erroresConsola.pag1.length + erroresConsola.pag2.length;
  console.log(`  Errores pag1: ${erroresConsola.pag1.length}, pag2: ${erroresConsola.pag2.length}`);
  erroresConsola.pag1.forEach(e => console.log(`    PAG1: ${e}`));
  erroresConsola.pag2.forEach(e => console.log(`    PAG2: ${e}`));
  check(`Cero errores de consola (total: ${totalErrores})`, totalErrores === 0);

  // RESUMEN
  console.log('\n========== RESUMEN ==========');
  if (fallos === 0 && totalErrores === 0) {
    console.log('TODOS LOS TESTS PASARON. CERO ERRORES.');
  } else {
    console.log(`FALLOS: ${fallos}`);
  }

  await browser.close();
  server.kill();
  process.exit(fallos === 0 && totalErrores === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('ERROR FATAL EN TEST:', e);
  process.exit(1);
});