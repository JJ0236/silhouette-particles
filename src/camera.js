// Owns the webcam and nothing else. It hands out the raw sensor frame; the
// warp is what decides which part of it matters. Cropping and mirroring used
// to live here, and moving them out is what let the display region be found by
// calibration instead of assumed.

export function createCamera() {
  const video = document.createElement('video');
  video.playsInline = true;   // Safari refuses to play inline without this
  video.muted = true;
  video.autoplay = true;

  let stream = null;
  let error = null;
  let locked = { exposure: false, whiteBalance: false, focus: false, reason: 'not attempted' };
  let settings = null;
  let capabilities = null;

  // Frame-callback bookkeeping. Only one subscriber is expected, but the
  // handle is kept here so stop() can cancel it whichever path armed it.
  let rvfcHandle = 0;
  let rafHandle = 0;

  async function start(deviceId) {
    stop();
    // width/height/frameRate are always requested, even with an explicit
    // device: Safari silently injects an ideal 640x480 when they're absent,
    // and 640x480 doesn't resolve fingers. No facingMode either — it's
    // meaningless for a USB camera pointed at a wall, and on some stacks it
    // pulls the wrong device ahead of the deviceId hint.
    const constraints = {
      audio: false,
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();
    // Metadata can lag the play() resolution; wait for real dimensions.
    if (!video.videoWidth) {
      await new Promise(res => video.addEventListener('loadedmetadata', res, { once: true }));
    }
    // What the browser actually granted, not what we asked for — the latency
    // and photometric calibrations are only valid for this exact mode, so it
    // is logged and exposed so a mismatch can be spotted.
    const track = stream.getVideoTracks()[0];
    settings = track ? track.getSettings() : null;
    capabilities = track?.getCapabilities?.() ?? null;
    console.info('[camera]', settings);
    await lockExposure(track);

    error = null;
    return { width: video.videoWidth, height: video.videoHeight };
  }

  // Pin exposure and white balance if the camera and engine allow it.
  //
  // This is worth a lot here. The detector predicts what the camera should
  // read, so anything that silently rescales the image — auto-exposure hunting
  // as the piece brightens and darkens, auto white balance chasing a coloured
  // contour — is a moving target it has to model and undo. The whole
  // constant-brightness patch calibration exists because Safari offers no way
  // to stop that. Chromium does, so on Windows we simply turn it off.
  //
  // Entirely best-effort: support is per-camera, not just per-browser, and a
  // camera that refuses is no worse off than before — the software
  // compensation is still there and still runs.
  async function lockExposure(track) {
    locked = { exposure: false, whiteBalance: false, focus: false, reason: '' };
    try {
      const caps = track.getCapabilities?.();
      if (!caps) { locked.reason = 'no getCapabilities'; return locked; }
      const want = {};
      if (caps.exposureMode?.includes('manual')) {
        want.exposureMode = 'manual';
        // Sit mid-range: bright enough to see a body, short enough that a
        // moving hand does not smear across the exposure.
        if (caps.exposureTime) {
          const { min, max } = caps.exposureTime;
          want.exposureTime = Math.round(min + (max - min) * 0.35);
        }
      } else if (caps.exposureMode?.includes('continuous')) {
        locked.reason = 'camera offers no manual exposure';
      }
      if (caps.whiteBalanceMode?.includes('manual')) want.whiteBalanceMode = 'manual';
      if (caps.focusMode?.includes('manual')) want.focusMode = 'manual';

      if (Object.keys(want).length === 0) {
        locked.reason = locked.reason || 'camera exposes no manual controls';
        return locked;
      }
      await track.applyConstraints({ advanced: [want] });
      const got = track.getSettings?.() ?? {};
      locked.exposure = got.exposureMode === 'manual';
      locked.whiteBalance = got.whiteBalanceMode === 'manual';
      locked.focus = got.focusMode === 'manual';
      console.info('[camera] locked', locked, want);
    } catch (e) {
      locked.reason = e?.message ?? String(e);
      console.warn('[camera] could not lock exposure:', locked.reason);
    }
    return locked;
  }

  function stop() {
    if (rvfcHandle && video.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(rvfcHandle);
    }
    rvfcHandle = 0;
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = 0;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  }

  async function listDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'videoinput');
  }

  // "1920x1080@30" from the granted track settings; falls back to the video
  // element's dimensions if the track hasn't reported yet.
  function describe() {
    const w = settings?.width ?? video.videoWidth ?? 0;
    const h = settings?.height ?? video.videoHeight ?? 0;
    const fps = settings?.frameRate;
    return `${w}x${h}` + (fps ? `@${Math.round(fps)}` : '');
  }

  // Per-frame subscription. requestVideoFrameCallback fires once per NEW
  // camera frame with the capture timestamp, which is what the latency
  // calibration correlates against. tCam uses the same expression as the
  // calibration does, so any constant offset between captureTime and the
  // performance.now() domain cancels out. When rVFC is missing (older
  // Firefox) a rAF loop stands in, firing only when currentTime advances so
  // the detector never re-processes a frame it has already seen.
  function onFrame(cb) {
    let active = true;
    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick = (now, metadata) => {
        rvfcHandle = 0;
        if (!active) return;
        const tCam = metadata.captureTime ?? metadata.presentationTime ?? performance.now();
        cb(tCam, metadata);
        // Re-arm AFTER the callback so a throw doesn't leave a dangling handle.
        if (active) rvfcHandle = video.requestVideoFrameCallback(tick);
      };
      rvfcHandle = video.requestVideoFrameCallback(tick);
    } else {
      let lastTime = -1;
      const loop = () => {
        rafHandle = 0;
        if (!active) return;
        const t = video.currentTime;
        if (t !== lastTime && video.readyState >= 2) {
          lastTime = t;
          const tCam = performance.now();
          cb(tCam, { mediaTime: t, presentationTime: tCam });
        }
        if (active) rafHandle = requestAnimationFrame(loop);
      };
      rafHandle = requestAnimationFrame(loop);
    }
    return function off() {
      active = false;
      if (rvfcHandle && video.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(rvfcHandle);
      }
      rvfcHandle = 0;
      if (rafHandle) cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    };
  }

  // The whole sensor frame, stretched to fill, no crop and no mirror. The
  // calibration UI needs raw camera coordinates to address.
  function drawFull(ctx, dw, dh) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return false;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, 0, 0, vw, vh, 0, 0, dw, dh);
    return true;
  }

  // A sub-rectangle of the sensor frame, in normalised coords, at whatever
  // resolution the caller asks for. The warp uses this to read the display
  // region at the camera's NATIVE detail instead of off a downscaled copy —
  // on a wide-angle camera the display is a small part of the frame, and
  // pre-shrinking it threw away most of the signal before segmentation.
  function drawRegion(ctx, dw, dh, nx, ny, nw, nh) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return false;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, nx * vw, ny * vh, nw * vw, nh * vh, 0, 0, dw, dh);
    return true;
  }

  const isLive = () => !!stream && video.readyState >= 2 && video.videoWidth > 0;

  return { video, start, stop, listDevices, onFrame, describe, drawFull, drawRegion, isLive,
           get error() { return error; },
           get settings() { return settings; },
           get capabilities() { return capabilities; } };
}
