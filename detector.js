const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

/**
 * Probes video for duration, width, height, and display aspect ratio
 */
function probeVideo(videoPath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration,r_frame_rate,nb_frames',
      '-show_entries', 'format=duration',
      '-of', 'json',
      videoPath
    ]);

    let stdout = '';
    let stderr = '';

    ffprobe.stdout.on('data', data => { stdout += data; });
    ffprobe.stderr.on('data', data => { stderr += data; });

    ffprobe.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`ffprobe failed: ${stderr}`));
      }
      try {
        const info = JSON.parse(stdout);
        const stream = info.streams && info.streams[0] ? info.streams[0] : {};
        const format = info.format || {};

        const duration = parseFloat(stream.duration || format.duration || 0);
        const width = parseInt(stream.width || 1280, 10);
        const height = parseInt(stream.height || 720, 10);

        resolve({ width, height, duration });
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Extracts N sample frames evenly distributed across the video
 */
async function extractSampleFrames(videoPath, tempDir, numFrames = 10, duration = 10) {
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Ensure timestamps are not in the first 2% or last 2% (to avoid fades to black)
  const timestamps = [];
  const start = Math.max(0.5, duration * 0.05);
  const end = Math.max(start + 1, duration * 0.95);
  const step = (end - start) / (numFrames + 1);

  for (let i = 1; i <= numFrames; i++) {
    timestamps.push((start + i * step).toFixed(2));
  }

  const framePaths = [];

  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const outPath = path.join(tempDir, `sample_${i}.jpg`);

    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, [
        '-ss', ts,
        '-i', videoPath,
        '-vframes', '1',
        '-q:v', '2',
        '-y',
        outPath
      ]);

      ff.on('close', code => {
        if (code === 0 && fs.existsSync(outPath)) {
          framePaths.push(outPath);
          resolve();
        } else {
          // If a frame fails (e.g. video is too short), continue with others
          resolve();
        }
      });
      ff.on('error', () => resolve());
    });
  }

  return framePaths;
}

/**
 * Extracts a single preview frame (thumbnail) for user UI
 */
function extractThumbnail(videoPath, outPath, atTime = 1.0) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(outPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const ff = spawn(ffmpegPath, [
      '-ss', String(atTime),
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      '-y',
      outPath
    ]);

    ff.on('close', code => {
      if (code === 0 && fs.existsSync(outPath)) {
        resolve(outPath);
      } else {
        // Fallback to time 0 if atTime exceeds duration
        const fallback = spawn(ffmpegPath, [
          '-i', videoPath,
          '-vframes', '1',
          '-q:v', '2',
          '-y',
          outPath
        ]);
        fallback.on('close', c => {
          if (c === 0 && fs.existsSync(outPath)) resolve(outPath);
          else reject(new Error('Failed to extract thumbnail'));
        });
      }
    });
    ff.on('error', reject);
  });
}

/**
 * Analyzes extracted frames to find static watermark coordinates
 */
async function autoDetectWatermark(framePaths, originalWidth, originalHeight) {
  if (!framePaths || framePaths.length < 3) {
    return {
      detected: false,
      confidence: 0,
      box: {
        x: Math.round(originalWidth * 0.75),
        y: Math.round(originalHeight * 0.85),
        width: Math.round(originalWidth * 0.22),
        height: Math.round(originalHeight * 0.10)
      }
    };
  }

  // Work at a standardized low resolution for fast processing
  const TARGET_W = 480;
  const TARGET_H = Math.round(480 * (originalHeight / originalWidth));
  const K = framePaths.length;

  const rawFrames = [];

  for (const fp of framePaths) {
    try {
      const { data } = await sharp(fp)
        .resize(TARGET_W, TARGET_H, { fit: 'fill' })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      rawFrames.push(data);
    } catch (e) {
      // skip corrupt frame
    }
  }

  if (rawFrames.length < 3) {
    return {
      detected: false,
      confidence: 0,
      box: {
        x: Math.round(originalWidth * 0.75),
        y: Math.round(originalHeight * 0.85),
        width: Math.round(originalWidth * 0.22),
        height: Math.round(originalHeight * 0.10)
      }
    };
  }

  const numPixels = TARGET_W * TARGET_H;
  const N = rawFrames.length;

  // 1. Calculate temporal mean and variance for each pixel
  const mean = new Float32Array(numPixels);
  const variance = new Float32Array(numPixels);

  for (let i = 0; i < numPixels; i++) {
    let sum = 0;
    for (let f = 0; f < N; f++) {
      sum += rawFrames[f][i];
    }
    mean[i] = sum / N;

    let varSum = 0;
    for (let f = 0; f < N; f++) {
      const diff = rawFrames[f][i] - mean[i];
      varSum += diff * diff;
    }
    variance[i] = varSum / N; // std = sqrt(variance[i])
  }

  // 2. Spatial gradient (Sobel-like) of the mean image
  const gradient = new Float32Array(numPixels);
  for (let y = 1; y < TARGET_H - 1; y++) {
    for (let x = 1; x < TARGET_W - 1; x++) {
      const idx = y * TARGET_W + x;
      const gx = mean[idx + 1] - mean[idx - 1];
      const gy = mean[idx + TARGET_W] - mean[idx - TARGET_W];
      gradient[idx] = Math.hypot(gx, gy);
    }
  }

  // 3. Define candidate zones where logos appear
  // Zones: Top-Left, Top-Right, Bottom-Left, Bottom-Right, Top-Center, Bottom-Center
  const zones = [
    { name: 'Top-Right', x1: 0.65, y1: 0.02, x2: 0.98, y2: 0.25 },
    { name: 'Bottom-Right', x1: 0.65, y1: 0.75, x2: 0.98, y2: 0.98 },
    { name: 'Top-Left', x1: 0.02, y1: 0.02, x2: 0.35, y2: 0.25 },
    { name: 'Bottom-Left', x1: 0.02, y1: 0.75, x2: 0.35, y2: 0.98 },
    { name: 'Bottom-Center', x1: 0.30, y1: 0.80, x2: 0.70, y2: 0.98 },
    { name: 'Top-Center', x1: 0.30, y1: 0.02, x2: 0.70, y2: 0.20 }
  ];

  let bestZone = null;
  let maxScore = -1;
  let bestPoints = [];

  for (const z of zones) {
    const px1 = Math.floor(z.x1 * TARGET_W);
    const px2 = Math.floor(z.x2 * TARGET_W);
    const py1 = Math.floor(z.y1 * TARGET_H);
    const py2 = Math.floor(z.y2 * TARGET_H);

    let zonePoints = [];
    let zoneScore = 0;

    for (let y = py1; y < py2; y++) {
      for (let x = px1; x < px2; x++) {
        const idx = y * TARGET_W + x;
        const std = Math.sqrt(variance[idx]);
        const grad = gradient[idx];
        const lum = mean[idx];

        // Criteria for watermark pixel:
        // - Persistent across time (std < 18.0)
        // - Has significant edge contrast (grad > 15.0)
        // - Not solid pitch-black letterbox (lum > 20)
        if (std < 16.0 && grad > 14.0 && lum > 15) {
          zonePoints.push({ x, y, grad, std });
          zoneScore += grad / (std + 1.0);
        }
      }
    }

    if (zoneScore > maxScore && zonePoints.length >= 25) {
      maxScore = zoneScore;
      bestZone = z;
      bestPoints = zonePoints;
    }
  }

  const scaleX = originalWidth / TARGET_W;
  const scaleY = originalHeight / TARGET_H;

  if (bestZone && bestPoints.length >= 25 && maxScore > 300) {
    // Find bounding box enclosing 90% of the watermark points (to filter noise outliers)
    const xs = bestPoints.map(p => p.x).sort((a, b) => a - b);
    const ys = bestPoints.map(p => p.y).sort((a, b) => a - b);

    const q5 = Math.floor(xs.length * 0.04);
    const q95 = Math.floor(xs.length * 0.96);

    let minX = xs[q5];
    let maxX = xs[q95];
    let minY = ys[q5];
    let maxY = ys[q95];

    // Padding in low-res pixels
    const padX = 6;
    const padY = 6;

    minX = Math.max(0, minX - padX);
    maxX = Math.min(TARGET_W, maxX + padX);
    minY = Math.max(0, minY - padY);
    maxY = Math.min(TARGET_H, maxY + padY);

    const origX = Math.round(minX * scaleX);
    const origY = Math.round(minY * scaleY);
    const origW = Math.round((maxX - minX) * scaleX);
    const origH = Math.round((maxY - minY) * scaleY);

    // Keep minimum dimensions
    const finalW = Math.max(40, origW);
    const finalH = Math.max(25, origH);

    return {
      detected: true,
      zoneName: bestZone.name,
      confidence: Math.min(99, Math.round((maxScore / (bestPoints.length + 50)) * 10)),
      box: {
        x: Math.min(originalWidth - finalW, Math.max(0, origX)),
        y: Math.min(originalHeight - finalH, Math.max(0, origY)),
        width: Math.min(originalWidth, finalW),
        height: Math.min(originalHeight, finalH)
      }
    };
  }

  // Fallback if no prominent static mark detected: default to Bottom-Right corner
  return {
    detected: false,
    zoneName: 'Bottom-Right (Sugerido)',
    confidence: 30,
    box: {
      x: Math.round(originalWidth * 0.72),
      y: Math.round(originalHeight * 0.84),
      width: Math.round(originalWidth * 0.24),
      height: Math.round(originalHeight * 0.12)
    }
  };
}

module.exports = {
  probeVideo,
  extractThumbnail,
  extractSampleFrames,
  autoDetectWatermark
};
