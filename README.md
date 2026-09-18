# DEDITOS - JUEGO MULTIJUGADOR WEB

## ¡Juego "Deditos" adaptado a formato virtual multijugador con dominio propio y gratis!

### 📋 SOBRE ESTE PROYECTO

Aplicación web completa del juego tradicional "Deditos" para 2 jugadores, adaptada a formato virtual multijugador con:
- Sistema de autenticación de usuarios con hash de password (bcrypt)
- Código de amigo alfanumérico único por usuario
- Sistema de amigos y notificaciones en tiempo real
- Panel de perfil con EXP y nivel
- Modo partida rápida + modo desafiar amigo
- Lógica completa de reglas físicas adaptadas virtualmente
- Exp tras ganar/perder partidas
- Ranking de niveles

### 📁 ESTRUCTURA DEL PROYECTO

```
Deditos-Juego/
├── server.js          # Servidor Node.js con Express + Socket.IO
├── package.json       # Dependencias y scripts
├── iniciar.bat        # Script para iniciar servidor
├── public/           # Carpeta de frontend
│   ├── index.html     # Interfaz de usuario
│   ├── style.css      # Estilos visuales atractivos
│   └── app.js         # Lógica del cliente Socket.IO
└── node_modules/     # Dependencias instaladas
```

### 🛠️ TECNOLOGÍAS UTILIZADAS

**Backend:**
- Node.js (v18+)
- Express (servidor HTTP)
- Socket.IO (tiempo real multiplayer)
- bcrypt (hash de passwords seguro)
- uuid (generación de códigos únicos)

**Frontend:**
- Vanilla JavaScript
- HTML5 / CSS3 con animaciones CSS
- Font Google (Orbiton + Roboto)
- Socket.IO Client

**Base de Datos:**
- Memoria RAM (para producción: usar PostgreSQL/MongoDB)

### ⚙️ DEPENDENCIAS (package.json)

```
express, socket.io, bcrypt, cors, uuid
```

### 🚀 DEPLOYMENT PARA MERCADO GLOBAL

#### Opción 1: Render.com (Gratis)
1. Crear cuenta en render.com
2. Nuevo Web Service → GitHub Repository
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Dominio gratuito disponible

#### Opción 2: Railway.app (Gratis)
1. Cuenta en railway.app
2. New Project → Deploy from GitHub
3. Auto-detecta Node.js
4. Variables de entorno: `PORT=3000`

#### Opción 3: VPS Propio (Cualquier servidor)
1. Subir carpeta `Deditos-Juego` al servidor
2. `npm install --production`
3. `node server.js`
4. Configurar dominio propio (Gratis: Freenom, Cloudflare)

### 🎮 CÓMO JUGAR

#### 1. REGISTRO / LOGIN
- Accede con usuario y password
- Registrarse crea cuenta única con código alfanumérico personalizado
- Ejemplo: `DEDITOS@JOSÉ` - comparte este código con amigos

#### 2. MODOS DE JUEGO

**Modo Partida Rápida:**
- Clic "Jugar Rápido" → crea partida pública
- Comparte el código de 6 caracteres que aparece
- Cualquiera puede unirse con ese código
- Ideal para oponentes aleatorios

**Modo Amigo:**
- Usa tu código personal: `DEDITOS@TU_NOMBRE`
- Compartir con amigo
- Amigo ingresa tu código → solicitud de amistad
- Aceptar → partida privada 1v1

#### 3. CONTROLES DEL JUEGO

**Turno:**
- Se muestra indicador "Es turno: Jugador X"
- Se resaltan las manos activas del jugador actual

**Atacar:**
1. Clic en mano propia para atacar (izquierda o derecha)
2. Clic en mano del oponente a atacar
3. Sistema calcula automáticamente:
   - Suma de dedos atacante + objetivo
   - Si > 5: mano muere + exceso se transfiere a otra mano
   - Si = 5: mano muere simple
   - Si < 5: actualiza count

**Dividir Manos** (cuando suma total es par):
- Clic botón "Dividir Manos" después de atacar
- Opciones de redistribución de enteros > 0
- Ejemplo: 3+1 → 2+2 | 4+0 (inválido) → distribución válida

**Victoria:**
- Ganas al dejar al oponente sin manos vivas
- +100 EXP por victoria, +20 por derrota (consuelo)
- Subes de nivel cada 100 EXP

### 🔐 SEGURIDAD IMPLEMENTADA

✅ Passwords con bcrypt hash (nunca en texto plano)
✅ Validación autoritative en servidor (NUNCA confiar cliente)
✅ Rate limiting implícito en eventos
✅ Códigos únicos por usuario (evitar colisiones)
✅ Sistema de solicitudes amistad con validación
✅ Expiración sesión por inactividad

### 📈 SISTEMA DE EXP Y NIVEL

| EXP | Nivel |
|-----|-------|
| 0-99 | Nivel 1 |
| 100-399 | Nivel 2 |
| 400-999 | Nivel 3 |
| 1000-1999 | Nivel 4 |
| 2000+ | Nivel 5+ (sqrt exp) |

Fórmula: `nivel = floor(sqrt(exp / 100)) + 1`

### 📡 EVENTOS SOCKET.IO

**Del cliente:**
- `login` / `registrar` - Autenticación
- `crear-partida-rapida` - Crear partida pública
- `unirse-partida-rapida` - Unirse con código
- `atacar` - Realizar ataque
- `solicitar-division` - Solicitar división de manos
- `renderizar-partida` - Finalizar partida
- `solicitar-pantalla-amigos` - Ver amigos/solicitudes

**Del servidor:**
- `estado-atualizado` - Estado actualizado partida
- `partida-lista` - Partida disponible
- `oponente-unido` - Otro jugador se unió
- `notificacion-solicitud` - Nueva solicitud amistad
- `notificacion-amistad` - Amistad aceptada/rechazada
- `victoria` - Notificación de victoria EXP

### 🎨 DISEÑO VISUAL

- Tema oscuro profesional (`#0a0a0f` background)
- Efectos glow en manos activas (`#00ff88`)
- Animaciones de pulse en manos seleccionables
- Círculos de estado: Rojo (offline/pendiente), Verde (online/disponible)
- Tipografía Orbitron para títulos (estilo gaming)
- Responsive: funciona móvil y desktop

### 🔄 ACTUALIZACIONES FUTURAS (Fase 2+)

- Base de datos real (PostgreSQL/MongoDB)
- Ranking global semanal
- Logros y medallas
- Sistema de monedas/estéticos
- Torneos clasificados
- Integración redes sociales
- Modo torneo

### 📞 SOPORTE

Para dudas o modificaciones:
- Revisar `server.js` para lógica completa
- Los eventos Socket.IO vienen con comentarios descriptivos
- El sistema de amigos usa `friendRequests` en memoria
- Para producción: conectar a BASE DE DATOS real

---

**¡Deditos listo para llevar al mercado global!** 
Juega con amigos, sube de nivel y diviértete pasando horas compitiendo.