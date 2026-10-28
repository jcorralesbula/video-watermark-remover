// State
let currentVideo = null;
let currentBox = { x: 0, y: 0, width: 100, height: 100 }; // in original video coordinates
let isDragging = false;
let isResizing = false;
let resizeHandle = null;
let dragStartX = 0;
let dragStartY = 0;
let boxStart = { ...currentBox };

// Elements
const uploadSection = document.getElementById('uploadSection');
const editorSection = document.getElementById('editorSection');
const resultSection = document.getElementById('resultSection');

const dropzone = document.getElementById('dropzone');
const videoInput = document.getElementById('videoInput');
const btnSelectFile = document.getElementById('btnSelectFile');
const uploadProgress = document.getElementById('uploadProgress');
const uploadProgressBar = document.getElementById('uploadProgressBar');
const uploadStatusText = document.getElementById('uploadStatusText');

const metaFilename = document.getElementById('metaFilename');
const metaRes = document.getElementById('metaRes');
const metaDuration = document.getElementById('metaDuration');
const detectionBadge = document.getElementById('detectionBadge');
const btnRedetect = document.getElementById('btnRedetect');

const previewImage = document.getElementById('previewImage');
const canvas = document.getElementById('overlayCanvas');
const ctx = canvas.getContext('2d');

const btnProcess = document.getElementById('btnProcess');
const btnChangeVideo = document.getElementById('btnChangeVideo');

const processingState = document.getElementById('processingState');
const completedState = document.getElementById('completedState');
const processProgressBar = document.getElementById('processProgressBar');
const processPercentText = document.getElementById('processPercentText');
const cleanedVideoPlayer = document.getElementById('cleanedVideoPlayer');
const btnDownload = document.getElementById('btnDownload');
const btnProcessAnother = document.getElementById('btnProcessAnother');

// Initialize event listeners
function init() {
  btnSelectFile.addEventListener('click', () => videoInput.click());
  dropzone.addEventListener('click', e => {
    if (e.target !== btnSelectFile) videoInput.click();
  });

  videoInput.addEventListener('change', e => {
    if (e.target.files && e.target.files[0]) {
      uploadFile(e.target.files[0]);
    }
  });

  // Drag & drop
  ['dragenter', 'dragover'].forEach(name => {
    dropzone.addEventListener(name, e => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropzone.addEventListener(name, e => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', e => {
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('video/')) {
      uploadFile(file);
    } else {
      alert('Por favor selecciona un archivo de video válido.');
    }
  });

  btnRedetect.addEventListener('click', runAutoDetect);
  btnChangeVideo.addEventListener('click', resetToUpload);
  btnProcessAnother.addEventListener('click', resetToUpload);

  btnProcess.addEventListener('click', startProcessing);

  // Quick presets
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      applyPreset(btn.dataset.preset);
    });
  });

  setupCanvasInteractions();

  window.addEventListener('resize', () => {
    if (currentVideo && previewImage.complete) {
      syncCanvasSize();
      drawBox();
    }
  });
}

// Upload file with progress
function uploadFile(file) {
  uploadProgress.classList.remove('hidden');
  uploadProgressBar.style.width = '0%';
  uploadStatusText.textContent = `Subiendo ${file.name}...`;

  const formData = new FormData();
  formData.append('video', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload', true);

  xhr.upload.onprogress = e => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      uploadProgressBar.style.width = `${pct}%`;
      uploadStatusText.textContent = `Subiendo: ${pct}%`;
    }
  };

  xhr.onload = () => {
    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      currentVideo = data;
      showEditor(data);
    } else {
      alert('Error al subir video. Asegúrate de que sea un formato compatible.');
      uploadProgress.classList.add('hidden');
    }
  };

  xhr.onerror = () => {
    alert('Error de conexión al subir el video.');
    uploadProgress.classList.add('hidden');
  };

  xhr.send(formData);
}

// Show Editor
function showEditor(data) {
  uploadSection.classList.add('hidden');
  resultSection.classList.add('hidden');
  editorSection.classList.remove('hidden');

  metaFilename.textContent = data.originalName;
  metaRes.textContent = `${data.width} × ${data.height}`;

  const mins = Math.floor(data.duration / 60);
  const secs = Math.floor(data.duration % 60);
  metaDuration.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

  previewImage.onload = () => {
    syncCanvasSize();
    runAutoDetect();
  };
  previewImage.src = data.thumbUrl;
}

// Auto-Detect Watermark
async function runAutoDetect() {
  if (!currentVideo) return;

  detectionBadge.className = 'status-badge badge-pending';
  detectionBadge.textContent = 'Analizando fotogramas...';
  btnRedetect.disabled = true;

  try {
    const res = await fetch('/api/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: currentVideo.videoId })
    });
    const result = await res.json();

    if (result.success && result.box) {
      currentBox = result.box;
      if (result.detected) {
        detectionBadge.className = 'status-badge badge-success';
        detectionBadge.textContent = `✓ Detectado en ${result.zoneName || 'Esquina'}`;
      } else {
        detectionBadge.className = 'status-badge badge-pending';
        detectionBadge.textContent = `Sugerencia: ${result.zoneName || 'Esquina'}`;
      }
    } else {
      detectionBadge.textContent = 'Ajusta el recuadro manualmente';
    }
  } catch (e) {
    detectionBadge.textContent = 'Ajusta el recuadro manualmente';
  } finally {
    btnRedetect.disabled = false;
    drawBox();
  }
}

// Canvas syncing
function syncCanvasSize() {
  const rect = previewImage.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
}

// Transform coordinates between Video and Canvas space
function toCanvasCoords(box) {
  const scaleX = canvas.width / currentVideo.width;
  const scaleY = canvas.height / currentVideo.height;
  return {
    x: box.x * scaleX,
    y: box.y * scaleY,
    width: box.width * scaleX,
    height: box.height * scaleY
  };
}

function toVideoCoords(box) {
  const scaleX = currentVideo.width / canvas.width;
  const scaleY = currentVideo.height / canvas.height;
  return {
    x: Math.round(box.x * scaleX),
    y: Math.round(box.y * scaleY),
    width: Math.round(box.width * scaleX),
    height: Math.round(box.height * scaleY)
  };
}

// Draw the bounding box on canvas
function drawBox() {
  if (!canvas.width || !currentVideo) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const cBox = toCanvasCoords(currentBox);

  // Outer semi-transparent tint
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Clear inside the box so image pops
  ctx.clearRect(cBox.x, cBox.y, cBox.width, cBox.height);

  // Box border with glow
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 2.5;
  ctx.shadowColor = '#00ff88';
  ctx.shadowBlur = 8;
  ctx.strokeRect(cBox.x, cBox.y, cBox.width, cBox.height);
  ctx.shadowBlur = 0; // reset

  // Label tag
  ctx.fillStyle = '#00ff88';
  ctx.font = 'bold 11px sans-serif';
  const tagText = 'MARCA DE AGUA';
  const tagW = ctx.measureText(tagText).width + 8;
  const tagY = Math.max(16, cBox.y - 4);
  ctx.fillRect(cBox.x, tagY - 14, tagW, 16);
  ctx.fillStyle = '#000';
  ctx.fillText(tagText, cBox.x + 4, tagY - 2);

  // Corner handles
  const handleSize = 8;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#00aa55';
  ctx.lineWidth = 2;

  const handles = [
    { x: cBox.x, y: cBox.y }, // TL
    { x: cBox.x + cBox.width, y: cBox.y }, // TR
    { x: cBox.x + cBox.width, y: cBox.y + cBox.height }, // BR
    { x: cBox.x, y: cBox.y + cBox.height } // BL
  ];

  handles.forEach(h => {
    ctx.fillRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
    ctx.strokeRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
  });
}

// Canvas mouse / touch interactions
function setupCanvasInteractions() {
  function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  function getHit(pos) {
    const cBox = toCanvasCoords(currentBox);
    const tol = 12;

    // Check corners
    if (Math.hypot(pos.x - (cBox.x + cBox.width), pos.y - (cBox.y + cBox.height)) < tol) return 'br';
    if (Math.hypot(pos.x - cBox.x, pos.y - (cBox.y + cBox.height)) < tol) return 'bl';
    if (Math.hypot(pos.x - (cBox.x + cBox.width), pos.y - cBox.y) < tol) return 'tr';
    if (Math.hypot(pos.x - cBox.x, pos.y - cBox.y) < tol) return 'tl';

    // Inside box -> move
    if (pos.x >= cBox.x && pos.x <= cBox.x + cBox.width &&
        pos.y >= cBox.y && pos.y <= cBox.y + cBox.height) {
      return 'move';
    }

    return null;
  }

  canvas.addEventListener('mousedown', e => {
    const pos = getCanvasPos(e);
    const hit = getHit(pos);
    dragStartX = pos.x;
    dragStartY = pos.y;
    boxStart = { ...currentBox };

    if (hit === 'move') {
      isDragging = true;
    } else if (hit) {
      isResizing = true;
      resizeHandle = hit;
    } else {
      // User clicked outside: start drawing new box
      isResizing = true;
      resizeHandle = 'new';
      const vPos = toVideoCoords({ x: pos.x, y: pos.y, width: 20, height: 20 });
      currentBox = { x: vPos.x, y: vPos.y, width: 20, height: 20 };
      boxStart = { ...currentBox };
    }
  });

  window.addEventListener('mousemove', e => {
    if (!currentVideo) return;
    const pos = getCanvasPos(e);

    if (!isDragging && !isResizing) {
      const hit = getHit(pos);
      if (hit === 'move') canvas.style.cursor = 'grab';
      else if (hit === 'br' || hit === 'tl') canvas.style.cursor = 'nwse-resize';
      else if (hit === 'tr' || hit === 'bl') canvas.style.cursor = 'nesw-resize';
      else canvas.style.cursor = 'crosshair';
      return;
    }

    const scaleX = currentVideo.width / canvas.width;
    const scaleY = currentVideo.height / canvas.height;
    const dx = (pos.x - dragStartX) * scaleX;
    const dy = (pos.y - dragStartY) * scaleY;

    if (isDragging) {
      canvas.style.cursor = 'grabbing';
      currentBox.x = Math.max(0, Math.min(currentVideo.width - currentBox.width, Math.round(boxStart.x + dx)));
      currentBox.y = Math.max(0, Math.min(currentVideo.height - currentBox.height, Math.round(boxStart.y + dy)));
    } else if (isResizing) {
      if (resizeHandle === 'br' || resizeHandle === 'new') {
        currentBox.width = Math.max(30, Math.min(currentVideo.width - currentBox.x, Math.round(boxStart.width + dx)));
        currentBox.height = Math.max(20, Math.min(currentVideo.height - currentBox.y, Math.round(boxStart.height + dy)));
      } else if (resizeHandle === 'tl') {
        const newW = Math.max(30, Math.round(boxStart.width - dx));
        const newH = Math.max(20, Math.round(boxStart.height - dy));
        currentBox.x = Math.max(0, Math.round(boxStart.x + (boxStart.width - newW)));
        currentBox.y = Math.max(0, Math.round(boxStart.y + (boxStart.height - newH)));
        currentBox.width = newW;
        currentBox.height = newH;
      }
    }
    drawBox();
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
    isResizing = false;
    resizeHandle = null;
    canvas.style.cursor = 'default';
  });
}

// Preset bounding boxes
function applyPreset(preset) {
  if (!currentVideo) return;
  const W = currentVideo.width;
  const H = currentVideo.height;
  const bw = Math.round(W * 0.22);
  const bh = Math.round(H * 0.12);

  switch (preset) {
    case 'tr': // Top Right
      currentBox = { x: Math.round(W * 0.75), y: Math.round(H * 0.04), width: bw, height: bh };
      break;
    case 'tl': // Top Left
      currentBox = { x: Math.round(W * 0.03), y: Math.round(H * 0.04), width: bw, height: bh };
      break;
    case 'br': // Bottom Right
      currentBox = { x: Math.round(W * 0.75), y: Math.round(H * 0.84), width: bw, height: bh };
      break;
    case 'bl': // Bottom Left
      currentBox = { x: Math.round(W * 0.03), y: Math.round(H * 0.84), width: bw, height: bh };
      break;
  }
  drawBox();
}

// Start Processing
async function startProcessing() {
  if (!currentVideo) return;

  const method = document.querySelector('input[name="method"]:checked').value;

  editorSection.classList.add('hidden');
  resultSection.classList.remove('hidden');
  processingState.classList.remove('hidden');
  completedState.classList.add('hidden');

  processProgressBar.style.width = '0%';
  processPercentText.textContent = '0%';

  try {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: currentVideo.videoId,
        box: currentBox,
        method
      })
    });

    const data = await res.json();
    if (!data.success) {
      alert(`Error: ${data.error}`);
      resetToEditor();
      return;
    }

    pollJob(data.jobId);
  } catch (e) {
    alert(`Error de conexión: ${e.message}`);
    resetToEditor();
  }
}

// Poll job progress
function pollJob(jobId) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/api/job/${jobId}`);
      const job = await res.json();

      if (job.progress !== undefined) {
        processProgressBar.style.width = `${job.progress}%`;
        processPercentText.textContent = `${job.progress}%`;
      }

      if (job.status === 'completed') {
        clearInterval(interval);
        processingState.classList.add('hidden');
        completedState.classList.remove('hidden');

        cleanedVideoPlayer.src = job.previewUrl;
        btnDownload.href = job.downloadUrl;
        btnDownload.setAttribute('download', job.filename);
      } else if (job.status === 'error') {
        clearInterval(interval);
        alert(`Ocurrió un error al procesar el video: ${job.error}`);
        resetToEditor();
      }
    } catch (e) {
      console.error(e);
    }
  }, 600);
}

function resetToUpload() {
  currentVideo = null;
  videoInput.value = '';
  uploadProgress.classList.add('hidden');
  uploadProgressBar.style.width = '0%';

  editorSection.classList.add('hidden');
  resultSection.classList.add('hidden');
  uploadSection.classList.remove('hidden');
}

function resetToEditor() {
  resultSection.classList.add('hidden');
  editorSection.classList.remove('hidden');
}

// Run init on DOM load
window.addEventListener('DOMContentLoaded', init);
