// Verificador: IDs usados en app.js deben existir en index.html
const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');
const js = fs.readFileSync('public/app.js', 'utf8');

// IDs listados en initDom
const idsRequeridos = [
  'tela-login', 'tela-registrar', 'tela-juego', 'tela-amigos',
  'form-login', 'form-registrar', 'username', 'password',
  'username-reg', 'password-reg', 'mostrar-registrar', 'mostrar-login',
  'username-display', 'nivel-display', 'exp-display', 'indicador-turno', 'btn-salir',
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

let faltantes = [];
idsRequeridos.forEach(id => {
  if (!html.includes(`id="${id}"`)) faltantes.push(id);
});

if (faltantes.length) {
  console.log('FALTANTES EN HTML:', faltantes);
  process.exit(1);
} else {
  console.log('Todos los ' + idsRequeridos.length + ' IDs existen en el HTML');
}

// Verificar clases usadas en CSS existan en HTML/JS
const css = fs.readFileSync('public/style.css', 'utf8');
console.log('Verificacion de IDs: OK');
