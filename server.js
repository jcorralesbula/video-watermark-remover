const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { probeVideo, extractThumbnail, extractSampleFrames, autoDetectWatermark } = require('./detector');
const { removeWatermark } = require('./processor');

const app = express();
const PORT = process.env.PORT || 3000;

// Directories
const BASE_DIR = __dirname;
const UPLOADS_DIR = path.join(BASE_DIR, 'uploads');
const OUTPUTS_DIR = path.join(BASE_DIR, 'outputs');
const TEMP_DIR = path.join(BASE_DIR, 'temp');
const PUBLIC_DIR = path.join(BASE_DIR, 'public');

[UPLOADS_DIR, OUTPUTS_DIR, TEMP_DIR, PUBLIC_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use('/media/uploads', express.static(UPLOADS_DIR));
app.use('/media/outputs', express.static(OUTPUTS_DIR));
app.use('/media/temp', express.static(TEMP_DIR));

// Memory stores
const videoRegistry = new Map();
const jobRegistry = new Map();

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    const id = crypto.randomUUID();
    cb(null, `${id}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 * 2 } // 2GB max
});

/**
 * Upload Video Endpoint
 */
app.post('/api/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se seleccionó ningún archivo de video.' });
    }

    const videoPath = req.file.path;
    const videoId = path.basename(req.file.filename, path.extname(req.file.filename));
    const originalName = req.file.originalname;

    console.log(`[Upload] Video recibido: ${originalName} (${req.file.size} bytes)`);

    // Get video dimensions and duration
    const meta = await probeVideo(videoPath);

    // Extract a representative thumbnail for canvas visualization
    const thumbName = `${videoId}_thumb.jpg`;
    const thumbPath = path.join(TEMP_DIR, thumbName);
    const thumbTime = Math.min(2.0, Math.max(0.5, meta.duration * 0.1));
    await extractThumbnail(videoPath, thumbPath, thumbTime);

    // Store in registry
    videoRegistry.set(videoId, {
      videoId,
      originalName,
      videoPath,
      width: meta.width,
      height: meta.height,
      duration: meta.duration,
      thumbUrl: `/media/temp/${thumbName}`,
      videoUrl: `/media/uploads/${req.file.filename}`
    });

    res.json({
      success: true,
      videoId,
      originalName,
      width: meta.width,
      height: meta.height,
      duration: meta.duration,
      thumbUrl: `/media/temp/${thumbName}`,
      videoUrl: `/media/uploads/${req.file.filename}`
    });
  } catch (err) {
    console.error('[Upload Error]', err);
    res.status(500).json({ error: `Error al procesar el video: ${err.message}` });
  }
});

/**
 * Auto-Detect Watermark Endpoint
 */
app.post('/api/detect', async (req, res) => {
  try {
    const { videoId } = req.body;
    const videoInfo = videoRegistry.get(videoId);

    if (!videoInfo) {
      return res.status(404).json({ error: 'Video no encontrado. Vuelve a cargarlo.' });
    }

    console.log(`[Detect] Iniciando detección automática para ${videoId}...`);
    const framesTempDir = path.join(TEMP_DIR, `frames_${videoId}`);
    const sampleFrames = await extractSampleFrames(
      videoInfo.videoPath,
      framesTempDir,
      12,
      videoInfo.duration
    );

    const result = await autoDetectWatermark(
      sampleFrames,
      videoInfo.width,
      videoInfo.height
    );

    console.log(`[Detect] Resultado:`, result);
    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error('[Detect Error]', err);
    res.status(500).json({ error: `Error en la detección: ${err.message}` });
  }
});

/**
 * Start Watermark Removal Processing Job
 */
app.post('/api/process', async (req, res) => {
  try {
    const { videoId, box, method = 'delogo' } = req.body;
    const videoInfo = videoRegistry.get(videoId);

    if (!videoInfo) {
      return res.status(404).json({ error: 'Video no encontrado.' });
    }

    if (!box || typeof box.x !== 'number') {
      return res.status(400).json({ error: 'Coordenadas del recuadro no especificadas.' });
    }

    const jobId = crypto.randomUUID();
    const outFilename = `cleaned_${Date.now()}_${path.basename(videoInfo.originalName)}`;
    const outputPath = path.join(OUTPUTS_DIR, outFilename);

    jobRegistry.set(jobId, {
      jobId,
      status: 'processing',
      progress: 0,
      filename: outFilename,
      downloadUrl: `/api/download/${outFilename}`,
      previewUrl: `/media/outputs/${outFilename}`
    });

    res.json({ success: true, jobId });

    // Process asynchronously
    removeWatermark({
      videoPath: videoInfo.videoPath,
      outputPath,
      box,
      method,
      videoWidth: videoInfo.width,
      videoHeight: videoInfo.height,
      duration: videoInfo.duration,
      onProgress: percent => {
        const job = jobRegistry.get(jobId);
        if (job) {
          job.progress = percent;
        }
      }
    })
      .then(() => {
        console.log(`[Process] Job ${jobId} completado con éxito.`);
        const job = jobRegistry.get(jobId);
        if (job) {
          job.status = 'completed';
          job.progress = 100;
        }
      })
      .catch(err => {
        console.error(`[Process Error] Job ${jobId} falló:`, err);
        const job = jobRegistry.get(jobId);
        if (job) {
          job.status = 'error';
          job.error = err.message;
        }
      });
  } catch (err) {
    console.error('[Process Request Error]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Poll Job Status
 */
app.get('/api/job/:jobId', (req, res) => {
  const job = jobRegistry.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Trabajo no encontrado.' });
  }
  res.json(job);
});

/**
 * Download Processed Video
 */
app.get('/api/download/:filename', (req, res) => {
  const filePath = path.join(OUTPUTS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Archivo no encontrado.');
  }
  res.download(filePath);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`  Video Watermark Remover está corriendo en:`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`====================================================`);
});
