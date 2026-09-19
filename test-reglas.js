// ===== TEST DE REGLAS DEL JUEGO (lógica pura del servidor) =====
const { ejecutarAtaque, ejecutarDivision, construirRanking, danioMano, siguienteTurnoGrupo } = require('./server');

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

console.log('\n=== TEST 7: División reparte en mitades iguales (3+1 → 2+2) ===');
{
  const manos = { izq: { count: 3, alive: true }, der: { count: 1, alive: true } };
  const res = ejecutarDivision(manos);
  check('División válida (sin error)', !res.error, res);
  check('Mitad calculada: 2', res.mitad === 2, res);
  check('Ambas manos quedan con 2', manos.izq.count === 2 && manos.der.count === 2, manos);
  check('Ambas manos vivas', manos.izq.alive && manos.der.alive);
}

console.log('\n=== TEST 8: División REVIVE mano muerta (2+muerta → 1+1) ===');
{
  const manos = { izq: { count: 2, alive: true }, der: { count: 5, alive: false } };
  const res = ejecutarDivision(manos);
  check('División válida (sin error)', !res.error, res);
  check('Mano muerta REVIVE con 1', manos.der.alive === true && manos.der.count === 1, manos);
  check('Mano viva queda con 1', manos.izq.count === 1 && manos.izq.alive === true, manos);
}

console.log('\n=== TEST 9: Divisiones inválidas ===');
{
  const impar = { izq: { count: 3, alive: true }, der: { count: 2, alive: true } }; // suma 5
  const r1 = ejecutarDivision(impar);
  check('Suma impar no se puede dividir', r1.error === 'La suma de tus dedos no es par', r1);
  const muertas = { izq: { count: 5, alive: false }, der: { count: 5, alive: false } }; // suma 0
  const r2 = ejecutarDivision(muertas);
  check('Sin dedos no se puede dividir', r2.error === 'No tienes suficientes dedos para dividir', r2);
}

console.log('\n=== TEST 10: División con ambas manos al máximo (4+4 → 4+4) ===');
{
  const manos = { izq: { count: 4, alive: true }, der: { count: 4, alive: true } };
  const res = ejecutarDivision(manos);
  check('División válida (sin error)', !res.error, res);
  check('Quedan 4+4', manos.izq.count === 4 && manos.der.count === 4, manos);
}

console.log('\n=== TEST 11: Ranking básico (orden por EXP) ===');
{
  const users = {
    alfa: { exp: 100, nivel: 2 },
    beta: { exp: 300, nivel: 2 },
    gamma: { exp: 50, nivel: 1 }
  };
  const r = construirRanking(users, 'beta');
  check('3 en el top', r.top.length === 3, r.top);
  check('Puesto 1 es beta (300 EXP)', r.top[0].username === 'beta' && r.top[0].puesto === 1);
  check('Puesto 2 es alfa (100 EXP)', r.top[1].username === 'alfa' && r.top[1].puesto === 2);
  check('Puesto 3 es gamma (50 EXP)', r.top[2].username === 'gamma' && r.top[2].puesto === 3);
  check('Mi puesto correcto (#1)', r.miPuesto === 1);
  check('Estando en el top, "yo" es null', r.yo === null);
}

console.log('\n=== TEST 12: Empate de EXP → orden alfabético ===');
{
  const users = {
    zeta: { exp: 100, nivel: 2 },
    alfa: { exp: 100, nivel: 2 }
  };
  const r = construirRanking(users, null);
  check('Empate: alfa primero (alfabético)', r.top[0].username === 'alfa' && r.top[1].username === 'zeta', r.top);
}

console.log('\n=== TEST 13: Usuario FUERA del top 25 → solo su fila aparte ===');
{
  const users = {};
  for (let i = 1; i <= 30; i++) users[`user${String(i).padStart(2, '0')}`] = { exp: i * 10, nivel: 1 };
  users['elultimo'] = { exp: 5, nivel: 1 }; // el peor: puesto 31

  const r = construirRanking(users, 'elultimo', 25);
  check('Top tiene exactamente 25', r.top.length === 25, r.top.length);
  check('El top NO incluye al usuario', !r.top.some(u => u.username === 'elultimo'));
  check('Mi puesto global es 31', r.miPuesto === 31, r.miPuesto);
  check('Mi fila aparte existe (yo)', r.yo && r.yo.username === 'elultimo' && r.yo.puesto === 31, r.yo);
  // user30 es #1 (300 EXP) → el #25 es quien tiene 60 EXP: user06
  check('Puesto 25 correcto (user06, 60 EXP)', r.top[24].puesto === 25 && r.top[24].username === 'user06', r.top[24]);
}

console.log('\n=== TEST 14: Usuario dentro del top con lista grande ===');
{
  const users = {};
  for (let i = 1; i <= 30; i++) users[`user${String(i).padStart(2, '0')}`] = { exp: i * 10, nivel: 1 };

  const r = construirRanking(users, 'user10', 25); // user10 = exp 100 → puesto 21
  check('Mi puesto global es 21', r.miPuesto === 21, r.miPuesto);
  check('Estoy dentro del top', r.top.some(u => u.username === 'user10'));
  check('Estando en el top, "yo" es null', r.yo === null);
}

console.log('\n=== TEST 15: Ranking incluye rachas ===');
{
  const users = {
    alfa: { exp: 300, nivel: 2, racha: 4, mejorRacha: 7 },
    beta: { exp: 300, nivel: 2, racha: 0, mejorRacha: 2 }
  };
  const r = construirRanking(users, 'beta');
  check('Racha actual en el top', r.top.find(u => u.username === 'alfa').racha === 4, r.top);
  check('Mejor racha histórica en el top', r.top.find(u => u.username === 'alfa').mejorRacha === 7);
  check('Racha 0 presente', r.top.find(u => u.username === 'beta').racha === 0);
}

console.log('\n=== TEST 16: danioMano (motor de grupos) — mismas reglas de Deditos ===');
{
  // Suma normal
  const m1 = { izq: { count: 1, alive: true }, der: { count: 1, alive: true } };
  danioMano(m1, 'izq', 2);
  check('Suma simple: 1+2=3', m1.izq.count === 3 && m1.izq.alive);

  // Muerte exacta (5)
  const m2 = { izq: { count: 3, alive: true }, der: { count: 2, alive: true } };
  danioMano(m2, 'izq', 2);
  check('Muerte exacta en 5', m2.izq.alive === false && m2.izq.count === 5);
  check('La otra mano intacta', m2.der.count === 2 && m2.der.alive);

  // Exceso revive mano muerta (escenario del usuario)
  const m3 = { izq: { count: 3, alive: true }, der: { count: 5, alive: false } };
  danioMano(m3, 'izq', 3); // 6 > 5 → muere + exceso 1 revive der
  check('Exceso revive mano muerta con 1', m3.izq.alive === false && m3.der.alive === true && m3.der.count === 1, m3);

  // Exceso mata la otra mano viva
  const m4 = { izq: { count: 4, alive: true }, der: { count: 4, alive: true } };
  danioMano(m4, 'izq', 4); // 8 → muere izq, exceso 3 → der 4+3=7 ≥ 5 → muere
  check('Exceso mata también la otra mano', m4.izq.alive === false && m4.der.alive === false, m4);
}

console.log('\n=== TEST 17: siguienteTurnoGrupo — la VÍCTIMA juega ===');
{
  const asientos = [
    { username: 'A', vivo: true },
    { username: 'B', vivo: true },
    { username: 'C', vivo: true },
    { username: 'D', vivo: true }
  ];
  // A ataca a D (índice 3): el turno es de D
  check('La víctima (D) recibe el turno', siguienteTurnoGrupo(asientos, 3) === 'D');
  // D ataca a B (índice 1): el turno es de B
  check('La víctima (B) recibe el turno', siguienteTurnoGrupo(asientos, 1) === 'B');
}

console.log('\n=== TEST 18: siguienteTurnoGrupo — víctima ELIMINADA → próximo vivo ===');
{
  const asientos = [
    { username: 'A', vivo: true },
    { username: 'B', vivo: false },
    { username: 'C', vivo: true },
    { username: 'D', vivo: true }
  ];
  // C ataca a A y lo elimina → próximo vivo tras A (índice 0): B está muerto → C
  asientos[0].vivo = false;
  check('Víctima eliminada: salta muertos (B) hasta C', siguienteTurnoGrupo(asientos, 0) === 'C');

  // Eliminados consecutivos con wrap-around
  const asientos2 = [
    { username: 'A', vivo: true },
    { username: 'B', vivo: true },
    { username: 'C', vivo: false },
    { username: 'D', vivo: false }
  ];
  // A (índice 0) es eliminado → próximo: B (vivo)
  asientos2[0].vivo = false;
  check('Wrap-around del orden de la mesa', siguienteTurnoGrupo(asientos2, 0) === 'B');
}

console.log('\n========== RESUMEN REGLAS ==========');
if (fallos === 0) console.log('TODAS LAS REGLAS CORRECTAS.');
else console.log(`FALLOS: ${fallos}`);
process.exit(fallos === 0 ? 0 : 1);