import React, { useCallback, useEffect, useRef, useState } from "react";
import "./VideoFrameExtractor.css"; // nuovo stylesheet


// Canvas-ready, no deps. Tailwind for styling.
// Fixes:
// 1) Download robusto: uso toBlob -> objectURL, fallback dataURL, gestione iOS e revoca sicura.
// 2) Aspect ratio dinamico: video e canvas rispettano il rapporto nativo (verticale incluso).
// 3) drawFrame solo quando readyState >= 2; loop rVFC con fallback RAF.
// 4) stepFrame con clamp e attesa seek affidabile.
// 5) Migliorie minori: gestione errori, reset stato, diagnostica.

export default function VideoFrameExtractor() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const fileUrlRef = useRef(null);

  const [loaded, setLoaded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [fps, setFps] = useState(30);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [filename, setFilename] = useState("");
  const [lastError, setLastError] = useState("");
  const [readyState, setReadyState] = useState(0);
  const [supportReport, setSupportReport] = useState({ mp4:false, h264_aac:false, hevc:false, opus:false, mse_h264:false });
  const [aspect, setAspect] = useState("16/9"); // aggiornato su metadata

  const mediaErrorToText = (err) => {
    if (!err) return "";
    const map = { 1: "ABORTED: riproduzione interrotta", 2: "NETWORK: errore rete", 3: "DECODE: codec non supportato o file corrotto", 4: "SRC_NOT_SUPPORTED: formato/sorgente non supportati" };
    return map[err.code] || `Errore media (codice ${err.code})`;
  };

  const probeSupport = useCallback(() => {
    const v = document.createElement("video");
    const mp4 = !!v.canPlayType("video/mp4");
    const h264_aac = !!v.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
    const hevc = !!v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
    const opus = !!v.canPlayType('video/mp4; codecs="opus"');
    const mse_h264 = (typeof window.MediaSource !== "undefined" && window.MediaSource.isTypeSupported?.('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')) || false;
    setSupportReport({ mp4, h264_aac, hevc, opus, mse_h264 });
  }, []);

  useEffect(() => { probeSupport(); }, [probeSupport]);

  const safeDraw = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    if (!video.videoWidth || !video.videoHeight) return;
    if (video.readyState < 2) return; // haveCurrentData
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); } catch {}
  }, []);

  const resizeCanvasToVideo = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    canvas.width = w;
    canvas.height = h;
    // aggiorna aspect-ratio CSS per rispettare orientamento
    setAspect(`${w}/${h}`);
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    resizeCanvasToVideo();
    setDuration(video.duration || 0);
    setReadyState(video.readyState);
    setLoaded(true);
    setCurrent(0);
    setLastError("");
    safeDraw();
  }, [resizeCanvasToVideo, safeDraw]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      setCurrent(video.currentTime || 0);
      setReadyState(video.readyState);
      if (!isPlaying) safeDraw();
    };
    const onSeeked = () => { setCurrent(video.currentTime || 0); safeDraw(); };
    const onLoadedData = () => { setReadyState(video.readyState); safeDraw(); };
    const onError = () => { setReadyState(video.readyState); setLastError(mediaErrorToText(video.error || null)); };

    video.addEventListener("timeupdate", onTime);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("error", onError);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("error", onError);
    };
  }, [isPlaying, safeDraw]);

  // Rendering loop quando in play
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let handle = null;
    let rafId = null;
    const loopVFC = () => { safeDraw(); if (isPlaying) handle = v.requestVideoFrameCallback(loopVFC); };
    const loopRAF = () => { safeDraw(); if (isPlaying) rafId = requestAnimationFrame(loopRAF); };

    if (isPlaying) {
      if (typeof v.requestVideoFrameCallback === "function") handle = v.requestVideoFrameCallback(loopVFC);
      else rafId = requestAnimationFrame(loopRAF);
    }
    return () => {
      if (handle && typeof v.cancelVideoFrameCallback === "function") v.cancelVideoFrameCallback(handle);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [isPlaying, safeDraw]);

  const revokeOldUrl = () => {
    if (fileUrlRef.current) {
      URL.revokeObjectURL(fileUrlRef.current);
      fileUrlRef.current = null;
    }
  };

  const handleFile = (file) => {
    revokeOldUrl();
    const video = videoRef.current;
    if (!video) return;

    const mime = file.type || "video/mp4";
    const blob = new Blob([file], { type: mime });
    const tryBlobUrl = () => {
      const url = URL.createObjectURL(blob);
      fileUrlRef.current = url;
      video.crossOrigin = "anonymous";
      video.src = url;
      video.load();
    };

    const fallbackToDataUrl = () => {
      try {
        const fr = new FileReader();
        fr.onload = () => {
          revokeOldUrl();
          video.crossOrigin = "anonymous";
          video.src = String(fr.result || "");
          video.load();
        };
        fr.onerror = () => { setLastError("Impossibile leggere il file."); };
        fr.readAsDataURL(file);
      } catch (e) {
        setLastError(String(e?.message || e));
      }
    };

    const onErrOnce = () => {
      video.removeEventListener("error", onErrOnce);
      const code = video.error?.code;
      if (code === 4) fallbackToDataUrl();
    };
    video.addEventListener("error", onErrOnce);

    tryBlobUrl();

    setFilename(file.name.replace(/\.[^.]+$/, ""));
    setLoaded(false);
    setIsPlaying(false);
    setCurrent(0);
    setLastError("");
  };

  const handleUrl = () => {
    const input = prompt("Inserisci URL del video (richiede CORS per export Canvas):");
    if (!input) return;
    const video = videoRef.current;
    if (!video) return;
    revokeOldUrl();
    video.crossOrigin = "anonymous";
    video.src = input.trim();
    video.load();
    setFilename("video_url");
    setLoaded(false);
    setIsPlaying(false);
    setCurrent(0);
    setLastError("");
  };

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;
    setReadyState(video.readyState);
    if (video.paused || video.ended) {
      try { await video.play(); setIsPlaying(true); } catch (e) { setLastError(String(e?.message || e)); }
    } else {
      video.pause();
      setIsPlaying(false);
      safeDraw();
    }
  };

  const clamp = (t) => {
    const D = duration || 0;
    const eps = 1 / 1000;
    return Math.min(Math.max(t, 0 + eps), D > eps ? D - eps : 0);
  };

  const waitForSeek = () => new Promise((resolve) => {
    const v = videoRef.current;
    if (!v) return resolve();
    const cleanup = () => {
      v.removeEventListener("seeked", onSeeked);
      if (id) cancelAnimationFrame(id);
    };
    const onSeeked = () => { cleanup(); resolve(); };
    v.addEventListener("seeked", onSeeked, { once: true });
    let id = null;
    if (typeof v.requestVideoFrameCallback === "function") {
      id = v.requestVideoFrameCallback(() => { cleanup(); resolve(); });
    } else {
      id = requestAnimationFrame(() => { cleanup(); resolve(); });
    }
  });

  const stepFrame = async (deltaFrames) => {
    const v = videoRef.current;
    if (!v || !loaded) return;
    const frameDur = 1 / Math.max(1, fps || 30);
    const minimal = 1 / 10000;
    const target = clamp((v.currentTime || 0) + deltaFrames * frameDur + Math.sign(deltaFrames) * minimal);
    if (!v.paused) { v.pause(); setIsPlaying(false); }
    try { v.currentTime = target; } catch {}
    await waitForSeek();
    safeDraw();
  };

  const exportCurrentFrame = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    safeDraw();

    const ts = Math.round((current || 0) * 1000).toString().padStart(6, "0");
    const name = `${filename || "frame"}_${ts}ms.png`;

    const downloadViaLink = (url) => {
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.rel = "noopener noreferrer";
      // iOS/Safari: fallback apertura nuova tab
      const supportsDownload = "download" in HTMLAnchorElement.prototype;
      if (!supportsDownload) {
        window.open(url, "_blank");
        return;
      }
      document.body.appendChild(a);
      // dispatch esplicito di un click legato al gesto utente
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      // cleanup nella microtask successiva per evitare race su revoke
      queueMicrotask(() => {
        a.remove();
      });
    };

    try {
      await new Promise((resolve) => {
        canvas.toBlob((blob) => {
          if (blob) {
            const url = URL.createObjectURL(blob);
            downloadViaLink(url);
            setTimeout(() => URL.revokeObjectURL(url), 0);
          } else {
            try {
              const dataUrl = canvas.toDataURL("image/png");
              downloadViaLink(dataUrl);
            } catch (e) {
              setLastError(String(e?.message || e));
            }
          }
          resolve();
        }, "image/png");
      });
      return;
    } catch (e) {
      try {
        const dataUrl = canvas.toDataURL("image/png");
        downloadViaLink(dataUrl);
      } catch (err) {
        setLastError("Impossibile esportare: canvas tainted da CORS. Usa file locale o sorgente con CORS abilitato.");
      }
    }
  };

  const estimateFps = async () => {
    const v = videoRef.current;
    if (!v) return;
    let stop = false;
    let last = null;
    const samples = [];

    const done = (measured) => {
      if (Number.isFinite(measured) && measured > 0) setFps(Math.round(measured));
      if (v.paused) safeDraw();
    };

    if (typeof v.requestVideoFrameCallback === "function") {
      const sampler = (now, metadata) => {
        if (stop) return;
        if (last != null) {
          const dt = metadata.mediaTime - last;
          if (dt > 0) samples.push(dt);
        }
        last = metadata.mediaTime;
        if (samples.length < 20) v.requestVideoFrameCallback(sampler);
        else done(1 / (samples.reduce((a,b)=>a+b,0)/samples.length));
      };
      v.requestVideoFrameCallback(sampler);
      return;
    }

    const onTime = () => {
      if (stop) return;
      const t = v.currentTime;
      if (last != null) {
        const dt = t - last;
        if (dt > 0) samples.push(dt);
      }
      last = t;
      if (samples.length >= 10) {
        v.removeEventListener("timeupdate", onTime);
        done(1 / (samples.reduce((a,b)=>a+b,0)/samples.length));
      }
    };
    v.addEventListener("timeupdate", onTime);
  };

  useEffect(() => () => { revokeOldUrl(); }, []);

  return (
    <div className="app">
      <div className="container">
        <div className="card">
          <h2 className="title">Estrattore fotogrammi da MP4/MOV</h2>
          <div className="grid">
            <div>
              <label className="label">Seleziona video (MP4 o MOV)</label>
              <input
                type="file"
                accept="video/mp4,video/quicktime,video/*"
                onChange={(e)=>{ const f = e.target.files?.[0]; if (f) handleFile(f); }}
                className="input-file"
              />
              <div className="note">Nota: il supporto ai file MOV dipende dal codec e dal browser.</div>
              <button onClick={handleUrl} className="button">Carica da URL</button>
            </div>
            <div>
              <label className="label">FPS per passo frame</label>
              <div className="row">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={fps}
                  onChange={(e)=> setFps(Math.max(1, Number(e.target.value || 30)))}
                  className="input-number"
                />
                <button onClick={estimateFps} disabled={!loaded} className="button">Stima FPS</button>
              </div>
              <div className="note">Usato per andare avanti/indietro di un frame.</div>
            </div>
          </div>
        </div>

        <div className="grid">
          <div className="card">
            <video
              ref={videoRef}
              className="video"
              style={{ aspectRatio: aspect }}
              controls
              preload="metadata"
              playsInline
              onLoadedMetadata={handleLoadedMetadata}
              onPlay={()=> setIsPlaying(true)}
              onPause={()=> setIsPlaying(false)}
              onError={()=> setLastError(mediaErrorToText(videoRef.current?.error || null))}
            />
            <div className="status-row">
              <span>t = {current.toFixed(3)} s</span>
              <span>durata = {duration.toFixed(3)} s</span>
            </div>
            <div className="row">
              <button onClick={()=> stepFrame(-1)} disabled={!loaded} className="button">⟨ Indietro 1 frame</button>
              <button onClick={togglePlay} disabled={!loaded} className="button primary">{isPlaying ? "Pausa" : "Play"}</button>
              <button onClick={()=> stepFrame(1)} disabled={!loaded} className="button">Avanti 1 frame ⟩</button>
            </div>
            <div className="note">Scorciatoie: ← → per passo frame. Spazio per play/pausa.</div>
          </div>

          <div className="card">
            <canvas ref={canvasRef} className="canvas" style={{ aspectRatio: aspect }} />
            <div className="row">
              <button onClick={exportCurrentFrame} disabled={!loaded} className="button primary">Esporta fotogramma (PNG)</button>
            </div>
            <div className="note">Il canvas rispetta il rapporto del video. L'export usa un click sintetico compatibile con Safari/iOS.</div>
          </div>
        </div>

        <div className="card">
          <h3 className="subtitle">Diagnostica</h3>
          <div className="diagnostic-grid">
            <div>
              <div>readyState: {readyState}</div>
              <div>supporto MP4: {String(supportReport.mp4)}</div>
              <div>H.264/AAC: {String(supportReport.h264_aac)}</div>
            </div>
            <div>
              <div>HEVC/H.265: {String(supportReport.hevc)}</div>
              <div>Opus-in-MP4: {String(supportReport.opus)}</div>
              <div>MSE H.264: {String(supportReport.mse_h264)}</div>
            </div>
            <div>
              <div className={lastError ? "error" : "ok"}>{lastError ? `Errore: ${lastError}` : "Nessun errore"}</div>
            </div>
          </div>
          <div className="note">Se vedi DECODE o SRC_NOT_SUPPORTED è probabile un codec non supportato; ricodifica in H.264/AAC.</div>
        </div>
      </div>
      <KeyBindings onLeft={() => stepFrame(-1)} onRight={() => stepFrame(1)} onSpace={togglePlay} />
    </div>
  );
}

function KeyBindings({ onLeft, onRight, onSpace }) {
  useEffect(() => {
    const handler = (e) => {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      if (e.code === "ArrowLeft") { e.preventDefault(); onLeft(); }
      if (e.code === "ArrowRight") { e.preventDefault(); onRight(); }
      if (e.code === "Space") { e.preventDefault(); onSpace(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onLeft, onRight, onSpace]);
  return null;
}
