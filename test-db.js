// ===== TEST DE LA CAPA DE DATOS (db.js) =====
// Prueba SIEMPRE el modo memoria y, si hay DATABASE_URL, también PostgreSQL real.
// Ejecutar con:  node --env-file-if-not-exists=.env test-db.js

const crearDb = require('./db');

let fallos = 0;
function check(nombre, condicion, extra) {
  if (condicion) {
    console.log(`  [PASA] ${nombre}`);
  } else {
    fallos++;
    console.log(`  [FALLA] ${nombre} ${extra !== undefined ? JSON.stringify(extra) : ''}`);
  }
}

async function bateria(db, etiqueta, prefijo) {
  console.log(`\n===== Batería: ${etiqueta} =====`);
  await db.init();
  await db.borrarUsuariosTest(prefijo); // limpiar restos de corridas previas

  const u1 = prefijo + 'ana';
  const u2 = prefijo + 'bob';

  // --- Creación y lectura ---
  let r = await db.createUser(u1, 'hash_ana', 'CODA01');
  check('createUser devuelve el usuario', r && r.username === u1 && r.exp === 0 && r.nivel === 1, r);
  check('getUser recupera campos', (await db.getUser(u1)).passwordHash === 'hash_ana');
  check('getUser de inexistente → null', (await db.getUser(prefijo + 'nadie')) === null);
  check('codigoEnUso true tras crear', (await db.codigoEnUso('CODA01')) === true);
  check('codigoEnUso false para libre', (await db.codigoEnUso('ZZZ999')) === false);
  check('getUserByCodigo encuentra', (await db.getUserByCodigo('CODA01')).username === u1);
  check('getUserByCodigo inexistente → null', (await db.getUserByCodigo('ZZZ999')) === null);

  // --- Actualización de EXP ---
  await db.createUser(u2, 'hash_bob', 'CODB02');
  await db.updateUser(u1, { exp: 300, nivel: 2 });
  const anaTrasExp = await db.getUser(u1);
  check('updateUser guarda EXP y nivel', anaTrasExp.exp === 300 && anaTrasExp.nivel === 2, anaTrasExp);

  // --- Amigos ---
  check('friends inicial vacío', (await db.getUser(u1)).friends.length === 0);
  await db.addFriendMutual(u1, u2);
  check('addFriendMutual en ambos lados',
    (await db.getUser(u1)).friends.includes(u2) && (await db.getUser(u2)).friends.includes(u1));
  await db.addFriendMutual(u1, u2); // idempotente
  check('addFriendMutual no duplica', (await db.getUser(u1)).friends.length === 1);

  // --- Solicitudes de amistad ---
  const u3 = prefijo + 'cil';
  await db.createUser(u3, 'hash_cil', 'CODC03');
  await db.addRequest(u3, u1);
  check('getRequest encuentra pendiente', (await db.getRequest(u3, u1)) !== null);
  check('getRequest de otro → null', (await db.getRequest(u2, u1)) === null);
  let lista = await db.listRequests(u1);
  check('listRequests devuelve la solicitud', lista.length === 1 && lista[0].de === u3, lista);
  await db.addRequest(u3, u1); // idempotente
  check('addRequest no duplica', (await db.listRequests(u1)).length === 1);
  await db.deleteRequest(u3, u1);
  check('deleteRequest elimina', (await db.listRequests(u1)).length === 0);

  // --- Sesiones ---
  const token = await db.createSession(u1);
  check('createSession genera token largo', typeof token === 'string' && token.length >= 32);
  const sesion = await db.getSession(token);
  check('getSession valida el token', sesion && sesion.username === u1, sesion);
  check('getSession de token falso → null', (await db.getSession('token_falso_xxx')) === null);
  await db.deleteSession(token);
  check('deleteSession invalida el token', (await db.getSession(token)) === null);

  // --- Ranking ---
  const paraRanking = await db.getAllUsersForRanking();
  check('getAllUsersForRanking devuelve datos',
    paraRanking[u1] && paraRanking[u1].exp === 300 && paraRanking[u2].exp === 0, paraRanking);

  // --- countUsers ---
  const antes = await db.countUsers();
  check('countUsers >= 3 (los creados)', antes >= 3, antes);

  // --- Limpieza ---
  await db.borrarUsuariosTest(prefijo);
  check('borrarUsuariosTest elimina usuarios', (await db.getUser(u1)) === null);
  check('borrarUsuariosTest elimina solicitudes', (await db.listRequests(u1)).length === 0);
}

async function main() {
  console.log('=== TEST CAPA DE DATOS: MODO MEMORIA ===');
  const dbMemoria = crearDb(null);
  await bateria(dbMemoria, 'Memoria', 'testdb_');

  if (process.env.DATABASE_URL) {
    console.log('\n=== TEST CAPA DE DATOS: POSTGRESQL (Neon real) ===');
    const dbPg = crearDb(process.env.DATABASE_URL);
    try {
      await bateria(dbPg, 'PostgreSQL', 'testdb_');
    } catch (err) {
      fallos++;
      console.log(`  [FALLA] Error de PostgreSQL: ${err.message}`);
    }
  } else {
    console.log('\n(Sin DATABASE_URL: pruebas de PostgreSQL omitidas)');
  }

  console.log('\n========== RESUMEN CAPA DE DATOS ==========');
  if (fallos === 0) console.log('TODAS LAS PRUEBAS DE DATOS PASARON.');
  else console.log(`FALLOS: ${fallos}`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });