'use strict';

// ── Realtime camera capture (bukti foto langsung dari kamera, bukan galeri) ──
// Pola yang sama dipakai untuk bukti stok keluar "Roti Berjamur" (js/pos.js).
// Dipakai bersama oleh fitur Kirim Stok Antar Outlet & Transfer Kas Antar Outlet
// agar staff pengirim wajib mengambil foto bukti realtime sebelum submit.
function createRealtimeCameraCapture({ videoId, previewId, errorId, captureBtnId, retakeBtnId, maxDim = 1280, quality = 0.85 }) {
  let stream = null;
  let photoBlob = null;
  let starting = null;   // Promise in-flight getUserMedia(), mencegah start() ganda
  let stopRequested = false;

  function els() {
    return {
      video:   document.getElementById(videoId),
      preview: previewId   ? document.getElementById(previewId)   : null,
      err:     errorId     ? document.getElementById(errorId)     : null,
      btnCap:  captureBtnId ? document.getElementById(captureBtnId) : null,
      btnRe:   retakeBtnId  ? document.getElementById(retakeBtnId)  : null,
    };
  }

  function start() {
    const { video, err } = els();
    if (!video || stream) return Promise.resolve();
    if (starting) return starting; // sudah ada permintaan kamera berjalan, jangan dobel

    if (err) err.style.display = 'none';

    if (!navigator.mediaDevices?.getUserMedia) {
      if (err) {
        err.textContent = 'Perangkat / browser ini tidak mendukung akses kamera. Foto bukti wajib — gunakan perangkat dengan kamera.';
        err.style.display = '';
      }
      return Promise.resolve();
    }

    stopRequested = false;
    starting = (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false
        });
        // Modal/tab sudah ditutup selagi menunggu izin kamera — jangan nyalakan.
        if (stopRequested) { s.getTracks().forEach(t => t.stop()); return; }
        stream = s;
        video.srcObject = stream;
        await video.play().catch(() => {});
      } catch (e) {
        stream = null;
        if (err) {
          err.textContent = 'Akses kamera ditolak / gagal. Izinkan akses kamera lalu coba lagi.';
          err.style.display = '';
        }
        console.warn('[RealtimeCameraCapture] gagal start:', e.message);
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  function stop() {
    stopRequested = true;
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    const { video } = els();
    if (video) video.srcObject = null;
  }

  function capture() {
    const { video, preview, btnCap, btnRe } = els();
    if (!video || !stream || !video.videoWidth) {
      return Promise.reject(new Error('Kamera belum siap. Izinkan akses kamera terlebih dahulu.'));
    }

    // Resize ke maks maxDim px agar ukuran file aman (< 5MB)
    const scale  = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width  = Math.round(video.videoWidth  * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error('Gagal mengambil foto. Coba lagi.')); return; }
        photoBlob = blob;
        if (preview) { preview.src = URL.createObjectURL(blob); preview.style.display = ''; }
        if (video) video.style.display = 'none';
        if (btnCap) btnCap.style.display = 'none';
        if (btnRe)  { btnRe.style.display = ''; if (window.lucide) lucide.createIcons(); }
        stop();
        resolve(blob);
      }, 'image/jpeg', quality);
    });
  }

  function reset() {
    photoBlob = null;
    const { preview, video, btnCap, btnRe } = els();
    if (preview) {
      if (preview.src?.startsWith('blob:')) URL.revokeObjectURL(preview.src);
      preview.style.display = 'none';
      preview.removeAttribute('src');
    }
    if (video)  video.style.display = '';
    if (btnCap) btnCap.style.display = '';
    if (btnRe)  btnRe.style.display = 'none';
  }

  function retake() {
    reset();
    start();
  }

  async function upload(folder, filename) {
    if (!photoBlob) throw new Error('Foto bukti belum diambil');
    const fd = new FormData();
    fd.append('file', new File([photoBlob], filename, { type: 'image/jpeg' }));
    fd.append('folder', folder);

    const uploadUrl    = API_BASE.replace('/api.php', '/upload.php');
    const sessionToken = typeof getRbnSessionToken === 'function' ? getRbnSessionToken() : '';
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'X-API-Key': API_KEY,
        ...(sessionToken ? { 'X-Session-Token': sessionToken } : {}),
      },
      body: fd
    });

    let result;
    try { result = await res.json(); }
    catch { throw new Error('Upload foto gagal: respons server tidak valid (HTTP ' + res.status + ')'); }

    if (!res.ok || result.error || !result.url) {
      throw new Error('Upload foto gagal: ' + (result.error || 'HTTP ' + res.status));
    }
    return result.url;
  }

  return {
    start, stop, capture, retake, reset, upload,
    hasPhoto: () => Boolean(photoBlob),
    getBlob:  () => photoBlob,
  };
}

window.createRealtimeCameraCapture = createRealtimeCameraCapture;
