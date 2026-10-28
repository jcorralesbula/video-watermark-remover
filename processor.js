const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');

function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.trim().split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]) || 0;
    const minutes = parseFloat(parts[1]) || 0;
    const seconds = parseFloat(parts[2]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return parseFloat(timeStr) || 0;
}

/**
 * Removes watermark using selected method (delogo, blur, pixelate)
 */
function removeWatermark({
  videoPath,
  outputPath,
  box,
  method = 'delogo',
  videoWidth,
  videoHeight,
  duration = 0,
  onProgress
}) {
  return new Promise((resolve, reject) => {
    // 1. Sanitize and clamp box dimensions
    let x = Math.max(0, Math.round(box.x || 0));
    let y = Math.max(0, Math.round(box.y || 0));
    let w = Math.max(10, Math.round(box.width || 50));
    let h = Math.max(10, Math.round(box.height || 50));

    if (x + w > videoWidth) {
      w = Math.max(10, videoWidth - x);
    }
    if (y + h > videoHeight) {
      h = Math.max(10, videoHeight - y);
    }

    // Ensure w and h are even numbers (prevent codec alignment issues)
    if (w % 2 !== 0) w -= 1;
    if (h % 2 !== 0) h -= 1;

    // Ensure output dir exists
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    // 2. Select filter chain
    let filterString = '';
    if (method === 'blur') {
      filterString = `[0:v]split[base][mark];[mark]crop=${w}:${h}:${x}:${y},boxblur=15:5[blurred];[base][blurred]overlay=${x}:${y}`;
    } else if (method === 'pixelate') {
      filterString = `[0:v]split[base][mark];[mark]crop=${w}:${h}:${x}:${y},scale=iw/12:-1,scale=12*iw:-1:flags=neighbor[pix];[base][pix]overlay=${x}:${y}`;
    } else {
      // Default: delogo
      filterString = `delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=0`;
    }

    const args = [
      '-i', videoPath,
      '-filter_complex', filterString,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '19',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-y',
      outputPath
    ];

    console.log(`[FFmpeg] Running command with filter: ${filterString}`);

    const process = spawn(ffmpegPath, args);
    let stderr = '';

    process.stderr.on('data', data => {
      const line = data.toString();
      stderr += line;

      // Extract current time: time=00:00:12.34
      const timeMatch = line.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
      if (timeMatch && duration > 0 && typeof onProgress === 'function') {
        const currentSecs = parseTimeToSeconds(timeMatch[1]);
        const percent = Math.min(99, Math.round((currentSecs / duration) * 100));
        onProgress(percent);
      }
    });

    process.on('close', code => {
      if (code === 0 && fs.existsSync(outputPath)) {
        if (typeof onProgress === 'function') onProgress(100);
        resolve({ outputPath, box: { x, y, width: w, height: h } });
      } else {
        console.error(`[FFmpeg] Failed:`, stderr.slice(-1000));
        reject(new Error(`FFmpeg error (code ${code}): ${stderr.slice(-500)}`));
      }
    });

    process.on('error', err => {
      reject(err);
    });
  });
}

module.exports = {
  removeWatermark
};
