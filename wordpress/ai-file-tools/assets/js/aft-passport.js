/* AI File Tools — AI Passport Photo Maker.
 * Upload 4–5 casual photos → on-device AI (MediaPipe) detects the face in each,
 * scores sharpness + face quality, picks the best shot, removes the background,
 * and crops to official passport geometry. Outputs a single photo and a
 * printable 4×6" sheet. Nothing is uploaded anywhere.
 */
(function () {
  'use strict';
  var AFT = window.AFT, h = AFT.h, CDN = AFT.cfg.cdn;

  var SIZES = {
    'in-35x45': { label: 'India / UK / EU — 35×45 mm', w: 35, h: 45, headFrac: 0.72 },
    'us-2x2':   { label: 'USA — 2×2 in (51×51 mm)', w: 50.8, h: 50.8, headFrac: 0.62 },
    'cn-33x48': { label: 'China — 33×48 mm', w: 33, h: 48, headFrac: 0.70 },
    'sq-35x35': { label: 'Square — 35×35 mm', w: 35, h: 35, headFrac: 0.62 }
  };
  var BGS = [
    ['#ffffff', 'White'],
    ['#f4f6f8', 'Off-white'],
    ['#cfe4f7', 'Light blue'],
    ['#e8e8e8', 'Light gray']
  ];

  var faceDetector = null, segmenter = null;

  function getFaceDetector() {
    if (faceDetector) return Promise.resolve(faceDetector);
    return AFT.loadScript(CDN.faceDetect).then(function () {
      var fd = new window.FaceDetection({
        locateFile: function (f) { return CDN.faceDetectBase + f; }
      });
      fd.setOptions({ model: 'short', minDetectionConfidence: 0.4 });
      faceDetector = fd;
      return fd;
    });
  }

  function getSegmenter() {
    if (segmenter) return Promise.resolve(segmenter);
    return AFT.loadScript(CDN.selfieSeg).then(function () {
      var seg = new window.SelfieSegmentation({
        locateFile: function (f) { return CDN.selfieSegBase + f; }
      });
      seg.setOptions({ modelSelection: 1 });
      segmenter = seg;
      return seg;
    });
  }

  function detectFace(canvas) {
    return getFaceDetector().then(function (fd) {
      return new Promise(function (resolve, reject) {
        fd.onResults(function (res) {
          resolve(res.detections && res.detections.length ? res.detections : []);
        });
        fd.send({ image: canvas }).catch(reject);
      });
    });
  }

  function segmentPerson(canvas) {
    return getSegmenter().then(function (seg) {
      return new Promise(function (resolve, reject) {
        seg.onResults(function (res) { resolve(res.segmentationMask); });
        seg.send({ image: canvas }).catch(reject);
      });
    });
  }

  /* Sharpness = variance of a Laplacian over the (grayscale) face region. */
  function sharpness(canvas, box) {
    var ctx = canvas.getContext('2d');
    var x = Math.max(0, Math.round(box.x)), y = Math.max(0, Math.round(box.y));
    var w = Math.min(canvas.width - x, Math.round(box.w));
    var hh = Math.min(canvas.height - y, Math.round(box.h));
    if (w < 8 || hh < 8) return 0;
    var d = ctx.getImageData(x, y, w, hh).data;
    var gray = new Float32Array(w * hh);
    for (var i = 0; i < w * hh; i++) {
      gray[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    }
    var sum = 0, sum2 = 0, n = 0;
    for (var yy = 1; yy < hh - 1; yy++) {
      for (var xx = 1; xx < w - 1; xx++) {
        var p = yy * w + xx;
        var lap = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - w] - gray[p + w];
        sum += lap; sum2 += lap * lap; n++;
      }
    }
    var mean = sum / n;
    return sum2 / n - mean * mean;
  }

  AFT.register('passport-photo', function (root) {
    var shots = [];        // {file, canvas (analysis-size), fullCanvas, det, score, sharp}
    var pickedIdx = -1;
    var status, results;
    var bgColor = BGS[0][0];

    root.appendChild(AFT.dropzone({
      title: 'Drop 4–5 photos of the person (or click to browse)',
      hint: 'Front-facing, good light, one person per photo. AI picks the best one — processed entirely on your device.',
      accept: 'image/*,.heic,.heif',
      multiple: true,
      onFiles: onFiles
    }));

    var shotsGrid = h('div', { class: 'aft-shots' });
    root.appendChild(shotsGrid);

    var panel = AFT.sectionPanel('Passport photo settings');
    panel.style.display = 'none';

    var sizeSel = h('select');
    Object.keys(SIZES).forEach(function (k) {
      sizeSel.appendChild(h('option', { value: k, text: SIZES[k].label }));
    });
    var dpiSel = h('select', {}, [
      h('option', { value: '300', text: '300 DPI (standard)' }),
      h('option', { value: '600', text: '600 DPI (high)' })
    ]);
    var bgRow = h('div', { class: 'aft-row' });
    BGS.forEach(function (bg, i) {
      var sw = h('button', {
        class: 'aft-swatch' + (i === 0 ? ' aft-picked' : ''),
        style: 'background:' + bg[0], title: bg[1],
        onclick: function () {
          bgColor = bg[0];
          bgRow.querySelectorAll('.aft-swatch').forEach(function (el) { el.classList.remove('aft-picked'); });
          sw.classList.add('aft-picked');
          schedulePreview();
        }
      });
      bgRow.appendChild(sw);
    });
    var keepBg = h('input', { type: 'checkbox' });

    var zoom = h('input', { type: 'range', min: '70', max: '130', value: '100' });
    var vshift = h('input', { type: 'range', min: '-30', max: '30', value: '0' });

    panel.appendChild(h('div', { class: 'aft-row' }, [
      h('div', { class: 'aft-field' }, [h('label', { text: 'Size' }), sizeSel]),
      h('div', { class: 'aft-field' }, [h('label', { text: 'Resolution' }), dpiSel])
    ]));
    panel.appendChild(h('div', { class: 'aft-field' }, [h('label', { text: 'Background' })]));
    panel.appendChild(bgRow);
    panel.appendChild(h('div', { class: 'aft-row' }, [h('label', { class: 'aft-inline' }, [keepBg, 'Keep original background (skip AI background removal)'])]));
    panel.appendChild(h('div', { class: 'aft-row' }, [
      h('div', { class: 'aft-field' }, [h('label', { text: 'Zoom' }), zoom]),
      h('div', { class: 'aft-field' }, [h('label', { text: 'Move up / down' }), vshift])
    ]));

    var preview = h('div', { class: 'aft-preview' });
    var previewCanvas = document.createElement('canvas');
    preview.appendChild(previewCanvas);
    panel.appendChild(preview);

    var goOne = h('button', { class: 'aft-btn', text: 'Download passport photo' });
    var goSheet = h('button', { class: 'aft-btn aft-secondary', text: 'Download printable 4×6" sheet' });
    panel.appendChild(h('div', { class: 'aft-row', style: 'margin-top:12px' }, [goOne, goSheet]));
    root.appendChild(panel);

    status = AFT.statusBar(root);
    results = AFT.resultsList(root, 'passport-photos.zip');

    [sizeSel, dpiSel].forEach(function (el) { el.addEventListener('change', schedulePreview); });
    [zoom, vshift].forEach(function (el) { el.addEventListener('input', schedulePreview); });
    keepBg.addEventListener('change', schedulePreview);

    function onFiles(fs) {
      shots = [];
      pickedIdx = -1;
      shotsGrid.innerHTML = '';
      panel.style.display = 'none';
      var list = fs.slice(0, 6);
      status.set('Analyzing ' + list.length + ' photo(s) with on-device AI…');
      var i = 0;
      var next = function () {
        if (i >= list.length) { finishAnalysis(); return; }
        var f = list[i++];
        status.progress((i - 1) / list.length);
        AFT.normalizeImageFile(f).then(AFT.loadImageBitmap).then(function (img) {
          var full = AFT.drawToCanvas(img, 2200, 2200);
          var small = AFT.drawToCanvas(full, 640, 640);
          return detectFace(small).then(function (dets) {
            var shot = { file: f, canvas: small, fullCanvas: full, det: null, score: 0, sharp: 0 };
            if (dets.length === 1) {
              var bb = dets[0].boundingBox; // relative center-based
              var box = {
                x: (bb.xCenter - bb.width / 2) * small.width,
                y: (bb.yCenter - bb.height / 2) * small.height,
                w: bb.width * small.width,
                h: bb.height * small.height
              };
              shot.det = { box: box, rel: bb, kp: dets[0].landmarks || [], conf: (dets[0].V && dets[0].V[0] && dets[0].V[0].ga) || 0.9 };
              shot.sharp = sharpness(small, box);
              var faceFrac = (box.w * box.h) / (small.width * small.height);
              // Favor: sharp, face big enough but not filling the frame
              var sizeScore = Math.min(1, faceFrac / 0.04) * (faceFrac > 0.5 ? 0.6 : 1);
              shot.score = Math.round(Math.min(shot.sharp / 300, 1) * 60 + sizeScore * 40);
            } else if (dets.length > 1) {
              shot.multi = true;
            }
            shots.push(shot);
            next();
          });
        }).catch(function () {
          shots.push({ file: f, failed: true, score: 0 });
          next();
        });
      };
      next();
    }

    function finishAnalysis() {
      status.progress(null);
      var best = -1, bestScore = -1;
      shots.forEach(function (s, idx) {
        if (s.det && s.score > bestScore) { bestScore = s.score; best = idx; }
      });
      shotsGrid.innerHTML = '';
      shots.forEach(function (s, idx) {
        var cell = h('div', { class: 'aft-shot' });
        if (!s.failed) {
          var t = document.createElement('canvas');
          var scale = 160 / s.canvas.height;
          t.width = Math.round(s.canvas.width * scale);
          t.height = 160;
          t.getContext('2d').drawImage(s.canvas, 0, 0, t.width, t.height);
          cell.appendChild(h('img', { src: t.toDataURL('image/jpeg', 0.7), alt: '' }));
        }
        if (idx === best) cell.appendChild(h('span', { class: 'aft-badge', text: 'AI pick' }));
        cell.appendChild(h('span', {
          class: 'aft-score',
          text: s.failed ? 'unreadable' : s.multi ? 'multiple faces' : s.det ? 'score ' + s.score : 'no face found'
        }));
        if (s.det) {
          cell.addEventListener('click', function () { pick(idx); });
        } else {
          cell.style.opacity = '0.45';
          cell.style.cursor = 'not-allowed';
        }
        shotsGrid.appendChild(cell);
      });
      if (best === -1) {
        status.set('No clear single face found in these photos. Try front-facing photos with one person and good light.', true);
        return;
      }
      pick(best);
      status.set('AI picked the best shot (green). Click another thumbnail to override, then fine-tune below.');
    }

    function pick(idx) {
      pickedIdx = idx;
      Array.prototype.forEach.call(shotsGrid.children, function (el, i) {
        el.classList.toggle('aft-picked', i === idx);
        el.classList.toggle('aft-best', i === idx);
      });
      panel.style.display = '';
      schedulePreview();
    }

    var previewTimer = null;
    function schedulePreview() {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(function () {
        buildPhoto(360).then(function (canvas) {
          previewCanvas.width = canvas.width;
          previewCanvas.height = canvas.height;
          previewCanvas.getContext('2d').drawImage(canvas, 0, 0);
        }).catch(function () { status.set('Preview failed — try another photo.', true); });
      }, 150);
    }

    /*
     * Compose the passport photo at a given pixel height.
     * Geometry: MediaPipe's box spans roughly eyebrows→chin. Estimate the full
     * head (crown→chin) from the eye line and chin, place the crown ~10% from
     * the top, and size the head to the preset's headFrac of photo height.
     */
    function buildPhoto(outH) {
      var s = shots[pickedIdx];
      if (!s || !s.det) return Promise.reject(new Error('no shot'));
      var spec = SIZES[sizeSel.value];
      var outW = Math.round(outH * spec.w / spec.h);
      var full = s.fullCanvas;
      var fx = full.width / s.canvas.width;   // analysis→full scale
      var box = {
        x: s.det.box.x * fx, y: s.det.box.y * fx,
        w: s.det.box.w * fx, h: s.det.box.h * fx
      };
      // Eye line from landmarks if available (0=right eye, 1=left eye), else box top third
      var eyeY = box.y + box.h * 0.35;
      if (s.det.rel && s.det.kp && s.det.kp.length >= 2) {
        eyeY = ((s.det.kp[0].y + s.det.kp[1].y) / 2) * full.height;
      }
      var chinY = box.y + box.h * 1.08;
      var headH = (chinY - eyeY) * 2.0;               // crown→chin estimate
      var crownY = chinY - headH;
      var zf = parseInt(zoom.value, 10) / 100;
      var cropH = (headH / spec.headFrac) / zf;
      var cropW = cropH * (spec.w / spec.h);
      var cx = box.x + box.w / 2;
      var cropX = cx - cropW / 2;
      var cropY = crownY - cropH * 0.10 + (parseInt(vshift.value, 10) / 100) * cropH;

      var work = document.createElement('canvas');
      work.width = outW; work.height = outH;
      var ctx = work.getContext('2d');

      var drawCrop = function (srcCanvas) {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, outW, outH);
        ctx.drawImage(srcCanvas, cropX, cropY, cropW, cropH, 0, 0, outW, outH);
      };

      if (keepBg.checked) {
        drawCrop(full);
        return Promise.resolve(work);
      }
      return segmentPerson(full).then(function (mask) {
        // person-only layer: mask → source-in original
        var person = document.createElement('canvas');
        person.width = full.width; person.height = full.height;
        var pctx = person.getContext('2d');
        pctx.filter = 'blur(1.5px)';                 // feather mask edges
        pctx.drawImage(mask, 0, 0, full.width, full.height);
        pctx.filter = 'none';
        pctx.globalCompositeOperation = 'source-in';
        pctx.drawImage(full, 0, 0);
        drawCrop(person);
        return work;
      }).catch(function () {
        // Segmentation unavailable → fall back to original background
        drawCrop(full);
        return work;
      });
    }

    goOne.addEventListener('click', function () {
      var spec = SIZES[sizeSel.value];
      var dpi = parseInt(dpiSel.value, 10);
      var px = Math.round(spec.h / 25.4 * dpi);
      status.set('Rendering final photo…');
      goOne.disabled = true;
      buildPhoto(px).then(function (canvas) {
        return AFT.canvasToBlob(canvas, 'image/jpeg', 0.95);
      }).then(function (blob) {
        var name = 'passport-photo-' + sizeSel.value + '-' + dpi + 'dpi.jpg';
        results.add({ name: name, blob: blob, thumbUrl: URL.createObjectURL(blob) });
        AFT.downloadBlob(blob, name);
        status.set('Passport photo downloaded (' + Math.round(px * spec.w / spec.h) + '×' + px + ' px @ ' + dpi + ' DPI).');
      }).catch(function () { status.set('Could not render the photo.', true); })
        .then(function () { goOne.disabled = false; });
    });

    goSheet.addEventListener('click', function () {
      var spec = SIZES[sizeSel.value];
      var dpi = parseInt(dpiSel.value, 10);
      var px = Math.round(spec.h / 25.4 * dpi);
      status.set('Building print sheet…');
      goSheet.disabled = true;
      buildPhoto(px).then(function (photo) {
        // 4×6 inch landscape sheet
        var sheet = document.createElement('canvas');
        sheet.width = 6 * dpi; sheet.height = 4 * dpi;
        var ctx = sheet.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, sheet.width, sheet.height);
        var gap = Math.round(dpi * 0.08);
        var pw = photo.width, ph = photo.height;
        var cols = Math.floor((sheet.width - gap) / (pw + gap));
        var rows = Math.floor((sheet.height - gap) / (ph + gap));
        var ox = Math.round((sheet.width - cols * (pw + gap) + gap) / 2);
        var oy = Math.round((sheet.height - rows * (ph + gap) + gap) / 2);
        ctx.strokeStyle = '#bbbbbb';
        ctx.lineWidth = 1;
        for (var r = 0; r < rows; r++) {
          for (var c = 0; c < cols; c++) {
            var x = ox + c * (pw + gap), y = oy + r * (ph + gap);
            ctx.drawImage(photo, x, y);
            ctx.strokeRect(x - 0.5, y - 0.5, pw + 1, ph + 1);
          }
        }
        return AFT.canvasToBlob(sheet, 'image/jpeg', 0.95).then(function (blob) {
          var name = 'passport-sheet-4x6-' + (cols * rows) + 'copies.jpg';
          results.add({ name: name, blob: blob, thumbUrl: URL.createObjectURL(blob) });
          AFT.downloadBlob(blob, name);
          status.set('Print sheet ready: ' + (cols * rows) + ' copies on a 4×6" sheet. Print at 100% scale, no fit-to-page.');
        });
      }).catch(function () { status.set('Could not build the sheet.', true); })
        .then(function () { goSheet.disabled = false; });
    });
  });
})();
