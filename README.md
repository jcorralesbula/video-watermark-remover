# Video Watermark Remover

Software moderno para la **detección y eliminación automática de marcas de agua y logos fijos en videos**.

---

## Características Principales

1. **Detección Automática de Logos**:
   - Analiza la varianza temporal entre fotogramas para distinguir fondos en movimiento de logos estáticos fijos.
   - Detecta automáticamente la posición `(x, y, ancho, alto)` en las esquinas o bordes del video.
2. **Editor Visual Interactivo**:
   - Previsualiza el fotograma del video con el recuadro delimitador resaltado.
   - Permite arrastrar, redimensionar con el ratón o usar atajos rápidos de esquinas si deseas afinar el área.
3. **Múltiples Métodos de Eliminación**:
   - **Delogo Inteligente (FFmpeg)**: Interpola de manera continua los píxeles circundantes reconstruyendo la zona sin bordes duros.
   - **Desenfoque Suave (Blur)**: Difumina estéticamente la marca de agua.
   - **Pixelado**: Aplica un mosaico de censura.
4. **Conservación de Audio y Calidad**:
   - Copia el flujo de audio original sin recodificar (`-c:a copy`), manteniendo sincronización 100% perfecta y máxima rapidez.
5. **Previsualización y Descarga Directa**:
   - Barra de progreso en tiempo real y reproductor para revisar el resultado antes de descargar.

---

## Cómo Iniciar el Software

### Opción 1: Un solo clic (Recomendado en Windows)
Haz doble clic en el archivo:
```
iniciar.bat
```
Esto abrirá automáticamente la aplicación en tu navegador web en `http://localhost:3000`.

### Opción 2: Desde la Terminal
```bash
cd "C:\Users\jaime.bula\.gemini\antigravity\scratch\video-watermark-remover"
node server.js
```
Abre en tu navegador: [http://localhost:3000](http://localhost:3000)

---

## Formatos Soportados
- **Video**: MP4, MOV, MKV, WebM, AVI.
- **Resoluciones**: Desde 720p hasta 4K UHD.
