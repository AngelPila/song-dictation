# Song Dictation

Práctica de inglés con canciones: letra sincronizada de [LRCLIB](https://lrclib.net) y video con el reproductor oficial de YouTube.

```sh
cp .env.example .env    # opcional: poné tu clave de YouTube
docker compose up -d --build
# http://localhost:8080/app.html
```

## Servicios

- `web`: nginx con la web estática; hace proxy de `/api/` hacia `api`.
- `api`: Node sin dependencias (`api/server.js`). Busca el video con la YouTube Data API v3 y guarda las búsquedas en un volumen (`api-cache`) durante 30 días, para gastar poca cuota.

Sin clave, la app funciona igual: el video se pega a mano y la pantalla lo avisa.

## Clave de YouTube (gratis)

1. Entrá a <https://console.cloud.google.com/> y creá un proyecto.
2. En "APIs y servicios" → "Biblioteca", habilitá **YouTube Data API v3**.
3. En "Credenciales" → "Crear credenciales" → "Clave de API". Conviene restringirla a la YouTube Data API v3.
4. Pegala en `.env` como `YOUTUBE_API_KEY=...` y reiniciá: `docker compose up -d --build api`.

La cuota gratuita es de 10.000 unidades por día: cada canción nueva cuesta 101 (una búsqueda de 100 y una consulta de duraciones de 1); las repetidas salen de la caché y no cuestan nada. El `.env` no se copia a la imagen web ni llega al navegador.

## Cómo se elige el video y la letra

- Se busca en YouTube "artista canción audio" y se piden las duraciones de los resultados.
- Gana el video cuya duración está más cerca de alguna versión de la letra (±3 s cuenta como "coincide"); suman el audio oficial, los canales "- Topic"/VEVO y los lyric videos; restan los videoclips (suelen tener intro) y descartan en la práctica los en vivo, covers, karaoke, remixes, etc.
- Entre las versiones de LRCLIB con tiempos se elige la de duración más cercana al video. Si el usuario toca otra versión o pega otro link, manda su elección.
- Las búsquedas de LRCLIB se guardan 7 días en el navegador (`sd:lrcq`) y se hacen solo al enviar el formulario.
