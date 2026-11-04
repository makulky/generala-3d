# Generala 3D

Juego de la Generala para dos jugadores en el navegador, con cubilete y dados en 3D y física real. Una persona crea la sala, comparte el enlace y la otra entra directamente, sin cuentas ni instalación.

## Características

- **Física real:** agitas el cubilete, los dados chocan dentro y el resultado es la cara que queda hacia arriba en la simulación.
- **Multijugador en vivo:** los navegadores se conectan por WebRTC y, si la red no lo permite, pasan solos a un servidor de respaldo. Cada jugador ve la tirada del otro.
- **Reconexión:** la partida se guarda en el navegador, así que se puede recargar la página y seguir jugando.
- **Sitio estático:** no necesita un backend propio y se despliega en Vercel tal cual.
- **Gráficos procedurales:** la mesa, la bandeja, el cubilete y los dados se generan por código, sin imágenes ni modelos que descargar.
- **Móvil:** en vertical, la mesa queda arriba y la planilla debajo.

## Cómo se juega

1. Pulsa **Crear partida** y envía el enlace a la otra persona.
2. Arrastra el cubilete para agitarlo y suéltalo para tirar, o pulsa **Tirar**.
3. Toca los dados que quieras guardar y vuelve a tirar los demás. Hay hasta 3 tiradas por turno.
4. Anota el resultado en una casilla libre de la planilla. Anotar un 0 pide un segundo toque de confirmación.

Con teclado, la barra espaciadora tira y las teclas `1` a `5` guardan o sueltan cada dado.

## Reglas

La partida dura 12 turnos por jugador y gana quien sume más puntos.

| Casilla | Puntos |
|---|---|
| Unos a Seises | Suma de los dados de ese número |
| Bonus | +35 si el subtotal de Unos a Seises llega a 63 |
| Libre | Suma de los 5 dados |
| Póker | Suma de los 5 dados con 4 o más iguales |
| Full | Suma de los 5 dados con 3 + 2 iguales |
| Escalera corta | 15 con 4 números consecutivos |
| Escalera larga | 30 con 5 números consecutivos |
| Generala | 50 con 5 iguales |

Cada casilla se usa una sola vez, así que solo puntúa una Generala por partida. Cinco dados iguales cuentan como Póker, pero no como Full.

## Desarrollo

Necesitas [Node.js](https://nodejs.org/) y npm.

```bash
npm install
npm run dev       # servidor local en http://localhost:5173
npm test          # tests de reglas, partida y física
npm run build     # comprobación de tipos y build de producción en dist/
```

Para probar el multijugador en un solo ordenador, crea una partida y abre el enlace en otra pestaña: entrará como invitado.

Los tests simulan 40 tiradas por defecto. Para comprobar el reparto de las caras con más tiradas, define la variable `SIM_ROLLS`:

```bash
SIM_ROLLS=2000 npm test             # macOS y Linux
$env:SIM_ROLLS='2000'; npm test     # PowerShell
```

## Despliegue en Vercel

El proyecto incluye `vercel.json`, así que basta con importar el repositorio en Vercel o ejecutar:

```bash
npx vercel --prod
```

## Cómo funciona

- **Render:** [Three.js](https://threejs.org/).
- **Física:** [cannon-es](https://github.com/pmndrs/cannon-es), con paso fijo de 1/120 s.
- **Red:** [PeerJS](https://peerjs.com/) sobre WebRTC. Si en unos 7 segundos no hay conexión directa, se usa [MQTT](https://github.com/mqttjs/MQTT.js) con un servidor público.
- **Cifrado del respaldo:** los mensajes viajan con AES-GCM y una clave derivada del código de sala, que forma parte del enlace y nunca se envía al servidor.
- **Autoridad:** el navegador de quien crea la sala valida cada acción y reenvía el estado.
- **Tiradas en vivo:** las simula quien tira y envía las posiciones a unos 30 Hz; el rival las interpola, de modo que ambos ven la misma tirada.

```text
src/
├── app.ts       Une física, escena, red e interfaz
├── main.ts      Arranque y lobby
├── game/        Reglas y estado de la partida
├── net/         Sala PeerJS y protocolo
├── physics/     Mundo físico y lógica de la tirada
├── three/       Escena y mallas
└── ui/          Planilla, lobby y controles en pantalla
```

## Limitaciones

- **Solo dos jugadores:** no hay espectadores ni cuentas de usuario.
- **Conexión:** depende de servicios públicos gratuitos y sin garantías: el servidor de PeerJS para la conexión directa y `broker.emqx.io` para el respaldo. Por el respaldo, el movimiento de los dados del rival es menos fluido y va con algo más de retraso.
- **Sin protección contra trampas:** quien tira informa de sus propios dados, y recargar en plena tirada permite repetirla. Está pensado para jugar entre amigos.
- **Quien crea la sala debe seguir conectado:** la partida se detiene si cierra la página hasta que vuelva a abrirla en el mismo navegador.
- **Sin sonido.**
