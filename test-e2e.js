// ===== TEST E2E COMPLETO - DEDITOS =====
// Prueba real con 2 navegadores headless jugando una partida completa
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const path = require('path');

const PUERTO = 3001;
const URL = `http://localhost:${PUERTO}`;

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
  await pag1.type('#username-reg', 'jugadoruno');
  await pag1.type('#password-reg', 'pass1234');
  await pag1.click('#form-registrar button[type=submit]');
  await esperar(1000);
  check('Pantalla juego visible tras registro', await pag1.$eval('#tela-juego', el => !el.classList.contains('hidden')));
  const user1 = await pag1.$eval('#username-display', el => el.textContent);
  check(`Username mostrado: "${user1}"`, user1 === 'jugadoruno');
  const cod1 = await pag1.$eval('#mi-codigo-amigo', el => el.textContent);
  check(`Código de amigo asignado: "${cod1}"`, cod1 && cod1 !== '---');

  // TEST 3: Registro jugador 2
  console.log('\n=== TEST 3: Registro jugador 2 ===');
  await pag2.click('#mostrar-registrar');
  await pag2.type('#username-reg', 'jugadordos');
  await pag2.type('#password-reg', 'pass1234');
  await pag2.click('#form-registrar button[type=submit]');
  await esperar(1000);
  check('Pantalla juego visible pag2', await pag2.$eval('#tela-juego', el => !el.classList.contains('hidden')));

  // TEST 4: Crear partida
  console.log('\n=== TEST 4: Crear partida (jugador 1) ===');
  await pag1.click('#btn-crear-partida');
  await esperar(800);
  const estadoP1 = await pag1.$eval('#estado-partida', el => el.textContent);
  console.log(`  Estado partida: ${estadoP1}`);
  const matchCodigo = estadoP1.match(/Código: ([A-Z0-9]{6})/);
  check('Código de partida generado', !!matchCodigo);
  const codigoPartida = matchCodigo ? matchCodigo[1] : null;
  console.log(`  Código: ${codigoPartida}`);

  // TEST 5: Unirse a la partida (jugador 2, maneja el prompt)
  console.log('\n=== TEST 5: Unirse a partida (jugador 2) ===');
  pag2.on('dialog', async dialog => { await dialog.accept(codigoPartida); });
  await pag2.click('#btn-unirse-partida');
  await esperar(1000);

  // Ambas páginas deben mostrar el tablero
  check('Tablero visible pag1', await pag1.$eval('#tablero-juego', el => !el.classList.contains('hidden')));
  check('Tablero visible pag2', await pag2.$eval('#tablero-juego', el => !el.classList.contains('hidden')));
  check('Nombres mostrados pag1', (await pag1.$eval('#nombre-p1', el => el.textContent)) === 'jugadoruno');
  check('Nombre p2 en pag2', (await pag2.$eval('#nombre-p2', el => el.textContent)) === 'jugadordos');

  // TEST 6: Jugar la partida completa
  console.log('\n=== TEST 6: Partida completa ===');
  let maxJugadas = 30;
  let jugadas = 0;
  let partidaTerminada = false;

  while (jugadas < maxJugadas && !partidaTerminada) {
    // ¿Terminó?
    const res1visible = await pag1.$eval('#resultado', el => !el.classList.contains('hidden'));
    if (res1visible) { partidaTerminada = true; break; }

    // Leer turno desde pag1
    const info = await pag1.evaluate(() => ({
      turno: config.partida ? config.partida.turnoActual : null,
      miUser: config.username,
      miJugador: config.miJugador,
      estado: config.partida ? config.partida.estado : null,
      enCurso: config.partida ? config.partida.enCurso : false
    }));
    if (!info.enCurso || !info.estado) { partidaTerminada = true; break; }

    const paginaActiva = info.turno === 'jugadoruno' ? pag1 : pag2;
    const miJugador = info.turno === 'jugadoruno' ? 'p1' : 'p2';
    const oponente = miJugador === 'p1' ? 'p2' : 'p1';

    // Manos vivas
    const manos = info.estado;
    const miViva = manos[miJugador].manos.izq.alive ? 'izq' : (manos[miJugador].manos.der.alive ? 'der' : null);
    const objViva = manos[oponente].manos.izq.alive ? 'izq' : (manos[oponente].manos.der.alive ? 'der' : null);
    if (!miViva || !objViva) { console.log('  [ERROR LOGICO] mano viva no encontrada'); break; }

    const turnoAntes = info.turno;
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

  const resultadoFinal = await pag1.evaluate(() => ({
    visible: !document.getElementById('resultado').classList.contains('hidden'),
    titulo: document.getElementById('titulo-resultado').textContent,
    desc: document.getElementById('descripcion-resultado').textContent,
    exp: document.getElementById('exp-display').textContent
  }));
  check(`Partida terminó (${jugadas} jugadas)`, resultadoFinal.visible);
  check(`Resultado mostrado: "${resultadoFinal.titulo}"`, resultadoFinal.titulo.includes('GANASTE') || resultadoFinal.titulo.includes('Perdiste'));

  const resultadoFinal2 = await pag2.evaluate(() => ({
    visible: !document.getElementById('resultado').classList.contains('hidden'),
    titulo: document.getElementById('titulo-resultado').textContent,
    exp: document.getElementById('exp-display').textContent
  }));
  check('Resultado visible también en pag2', resultadoFinal2.visible);

  // Uno ganó y otro perdió
  const gano1 = resultadoFinal.titulo.includes('GANASTE');
  const gano2 = resultadoFinal2.titulo.includes('GANASTE');
  check('Exactamente un ganador', gano1 !== gano2);
  check('Ganador tiene +100 EXP', (gano1 ? resultadoFinal.exp : resultadoFinal2.exp).includes('100'));

  // TEST 7: Login del usuario registrado (persistencia en servidor)
  console.log('\n=== TEST 7: Login de usuario ya registrado ===');
  const pag3 = await browser.newPage();
  pag3.on('pageerror', e => erroresConsola.pag1.push('PAG3: ' + e.message));
  await pag3.goto(URL, { waitUntil: 'networkidle0' });
  await pag3.type('#username', 'jugadoruno');
  await pag3.type('#password', 'pass1234');
  await pag3.click('#form-login button[type=submit]');
  await esperar(800);
  const loginOk = await pag3.$eval('#tela-juego', el => !el.classList.contains('hidden'));
  check('Login correcto con usuario registrado', loginOk);
  const expTrasLogin = await pag3.$eval('#exp-display', el => el.textContent);
  const expEsperada = gano1 ? '100' : '5'; // el perdedor recibe +5 EXP
  check(`EXP persiste tras login (esperado ${expEsperada}): "${expTrasLogin}"`, expTrasLogin.includes(expEsperada));
  await pag3.close();

  // TEST 8: Verificación final de errores de consola
  console.log('\n=== TEST 8: Errores de consola en TODA la sesión ===');
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