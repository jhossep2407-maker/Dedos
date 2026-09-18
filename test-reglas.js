// ===== TEST DE REGLAS DEL JUEGO (lógica pura del servidor) =====
const { ejecutarAtaque } = require('./server');

let fallos = 0;
function check(nombre, condicion, extra) {
  if (condicion) {
    console.log(`  [PASA] ${nombre}`);
  } else {
    fallos++;
    console.log(`  [FALLA] ${nombre} ${extra ? JSON.stringify(extra) : ''}`);
  }
}

function partidaFicticia(manosP1, manosP2) {
  return {
    estado: {
      p1: { username: 'jugadorA', manos: manosP1 },
      p2: { username: 'jugadorB', manos: manosP2 }
    }
  };
}

console.log('\n=== TEST 1: Escenario del usuario: exceso REVIVE mano muerta ===');
// A: solo izq viva con 3 | B: solo izq viva con 3
{
  const p = partidaFicticia(
    { izq: { count: 3, alive: true }, der: { count: 5, alive: false } },
    { izq: { count: 3, alive: true }, der: { count: 5, alive: false } }
  );
  const res = ejecutarAtaque(p, 'p1', 'izq', 'izq');
  check('Ataque válido (sin error)', !res.error, res);
  check('Mano izq de B murió', p.estado.p2.manos.izq.alive === false);
  check('Mano der de B REVIVIÓ', p.estado.p2.manos.der.alive === true);
  check('Mano der de B revivió con 1 dedo (el exceso)', p.estado.p2.manos.der.count === 1, p.estado.p2.manos.der);
  const vivasB = (p.estado.p2.manos.izq.alive ? 1 : 0) + (p.estado.p2.manos.der.alive ? 1 : 0);
  check('B sigue con 1 mano viva (la partida NO termina)', vivasB === 1);
}

console.log('\n=== TEST 2: Exceso se suma a mano viva sin matarla ===');
// A: izq 4 | B: izq 2, der 3 → 4+2=6 → B.izq muere, exceso 1 → B.der = 4
{
  const p = partidaFicticia(
    { izq: { count: 4, alive: true }, der: { count: 1, alive: true } },
    { izq: { count: 2, alive: true }, der: { count: 3, alive: true } }
  );
  const res = ejecutarAtaque(p, 'p1', 'izq', 'izq');
  check('Ataque válido', !res.error, res);
  check('B.izq murió', p.estado.p2.manos.izq.alive === false);
  check('B.der quedó con 4', p.estado.p2.manos.der.count === 4, p.estado.p2.manos.der);
  check('B.der sigue viva', p.estado.p2.manos.der.alive === true);
}

console.log('\n=== TEST 3: Muerte exacta (=5) sin exceso ===');
// A: izq 4 | B: izq 1, der 4 → 4+1=5 → B.izq muere exacta
{
  const p = partidaFicticia(
    { izq: { count: 4, alive: true }, der: { count: 1, alive: true } },
    { izq: { count: 1, alive: true }, der: { count: 4, alive: true } }
  );
  const res = ejecutarAtaque(p, 'p1', 'izq', 'izq');
  check('Ataque válido', !res.error, res);
  check('B.izq murió', p.estado.p2.manos.izq.alive === false);
  check('B.der intacta con 4', p.estado.p2.manos.der.count === 4 && p.estado.p2.manos.der.alive === true);
}

console.log('\n=== TEST 4: Exceso mata también la otra mano viva ===');
// A: izq 4 | B: izq 2, der 4 → 4+4=8 → B.der muere, exceso 3 → B.izq 2+3=5 → muere
{
  const p = partidaFicticia(
    { izq: { count: 4, alive: true }, der: { count: 1, alive: true } },
    { izq: { count: 2, alive: true }, der: { count: 4, alive: true } }
  );
  const res = ejecutarAtaque(p, 'p1', 'izq', 'der');
  check('Ataque válido', !res.error, res);
  check('B.der murió', p.estado.p2.manos.der.alive === false);
  check('B.izq también murió por el exceso', p.estado.p2.manos.izq.alive === false);
  const vivasB = (p.estado.p2.manos.izq.alive ? 1 : 0) + (p.estado.p2.manos.der.alive ? 1 : 0);
  check('B queda sin manos (el servidor debe declarar victoria de A)', vivasB === 0);
}

console.log('\n=== TEST 5: Suma normal sin muerte ===');
// A: izq 2 | B: izq 1 → 3
{
  const p = partidaFicticia(
    { izq: { count: 2, alive: true }, der: { count: 1, alive: true } },
    { izq: { count: 1, alive: true }, der: { count: 1, alive: true } }
  );
  const res = ejecutarAtaque(p, 'p1', 'izq', 'izq');
  check('Ataque válido', !res.error, res);
  check('B.izq quedó con 3', p.estado.p2.manos.izq.count === 3);
  check('B.izq sigue viva', p.estado.p2.manos.izq.alive === true);
}

console.log('\n=== TEST 6: Validaciones de ataque inválido ===');
{
  const p = partidaFicticia(
    { izq: { count: 5, alive: false }, der: { count: 2, alive: true } },
    { izq: { count: 3, alive: true }, der: { count: 5, alive: false } }
  );
  const r1 = ejecutarAtaque(p, 'p1', 'izq', 'izq');
  check('No puede atacar con mano muerta', r1.error === 'Tu mano atacante está muerta', r1);
  const r2 = ejecutarAtaque(p, 'p1', 'der', 'der');
  check('No puede atacar mano muerta del oponente', r2.error === 'La mano objetivo ya está muerta', r2);
}

console.log('\n========== RESUMEN REGLAS ==========');
if (fallos === 0) console.log('TODAS LAS REGLAS CORRECTAS.');
else console.log(`FALLOS: ${fallos}`);
process.exit(fallos === 0 ? 0 : 1);