/* AI File Tools — image tools: compress/resize, crop, sharpen, convert, image→PDF. */
(function () {
  'use strict';
  var AFT = window.AFT, h = AFT.h, CDN = AFT.cfg.cdn;

  /* =====================================================================
   * 1. Image Compressor & Resizer (quality mode + exact target size mode)
   * =================================================================== */
  AFT.register('image-compress', function (root) {
    var files = [];
    var results = null, status = null;

    root.appendChild(AFT.dropzone({
      title: 'Drop images here or click to browse',
      hint: 'JPG, PNG, WebP, HEIC — batch supported, processed on your device',
      accept: 'image/*,.heic,.heif',
      multiple: true,
      onFiles: function (fs) { files = fs; status.set(fs.length + ' image(s) ready.'); }
    }));

    var opts = AFT.sectionPanel('Options');

    var modeQ = h('input', { type: 'radio', name: 'aft-cmode', checked: 'checked' });
    var modeT = h('input', { type: 'radio', name: 'aft-cmode' });
    var quality = h('input', { type: 'range', min: '10', max: '100', value: '75' });
    var qLabel = h('span', { text: '75%' });
    quality.addEventListener('input', function () { qLabel.textContent = quality.value + '%'; });

    var targetVal = h('input', { type: 'number', min: '1', value: '200', style: 'width:90px' });
    var targetUnit = h('select', {}, [h('option', { value: '1024', text: 'KB' }), h('option', { value: '1048576', text: 'MB' })]);
    var exact = h('input', { type: 'checkbox', checked: 'checked' });

    var maxW = h('input', { type: 'number', min: '0', placeholder: 'auto', style: 'width:100px' });
    var fmt = h('select', {}, [
      h('option', { value: 'auto', text: 'Keep format (JPG for HEIC/target-size)' }),
      h('option', { value: 'image/jpeg', text: 'JPG' }),
      h('option', { value: 'image/png', text: 'PNG' }),
      h('option', { value: 'image/webp', text: 'WebP' })
    ]);

    opts.appendChild(h('div', { class: 'aft-row' }, [
      h('label', { class: 'aft-inline' }, [modeQ, 'Compress by quality']),
      h('label', { class: 'aft-inline' }, [modeT, 'Hit an exact file size (shrink or grow)'])
    ]));
    var rowQ = h('div', { class: 'aft-row' }, [
      h('div', { class: 'aft-field' }, [h('label', { text: 'Quality' }), h('div', {}, [quality, ' ', qLabel])])
    ]);
    var rowT = h('div', { class: 'aft-row', style: 'display:none' }, [
      h('div', { class: 'aft-field' }, [h('label', { text: 'Target size' }), h('div', {}, [targetVal, ' ', targetUnit])]),
      h('label', { class: 'aft-inline' }, [exact, 'Exact size (pad up if the image compresses below target — useful for portals with a minimum size)'])
    ]);
    opts.appendChild(rowQ);
    opts.appendChild(rowT);
    opts.appendChild(h('div', { class: 'aft-row' }, [
      h('div', { class: 'aft-field' }, [h('label', { text: 'Max width (px)' }), maxW, h('small', { text: 'Leave empty to keep dimensions' })]),
      h('div', { class: 'aft-field' }, [h('label', { text: 'Output format' }), fmt])
    ]));

    function syncMode() {
      rowQ.style.display = modeQ.checked ? '' : 'none';
      rowT.style.display = modeT.checked ? '' : 'none';
    }
    modeQ.addEventListener('change', syncMode);
    modeT.addEventListener('change', syncMode);

    var go = h('button', { class: 'aft-btn', text: 'Compress images' });
    opts.appendChild(h('div', { class: 'aft-row' }, [go]));
    root.appendChild(opts);
    status = AFT.statusBar(root);
    results = AFT.resultsList(root, 'compressed-images.zip');

    go.addEventListener('click', function () {
      if (!files.length) { status.set('Add at least one image first.', true); return; }
      results.clear();
      go.disabled = true;
      var i = 0;
      var next = function () {
        if (i >= files.length) {
          status.set('Done — ' + files.length + ' image(s) processed.');
          status.progress(null);
          go.disabled = false;
          return;
        }
        var f = files[i++];
        status.set('Processing ' + f.name + '…');
        status.progress((i - 1) / files.length);
        AFT.normalizeImageFile(f).then(function (nf) {
          return AFT.loadImageBitmap(nf).then(function (img) {
            var mw = parseInt(maxW.value, 10) || 0;
            var canvas = AFT.drawToCanvas(img, mw > 0 ? mw : null, null);
            var type = fmt.value === 'auto' ? (nf.type === 'image/png' ? 'image/png' : 'image/jpeg') : fmt.value;

            if (modeT.checked) {
              var target = Math.max(1024, (parseFloat(targetVal.value) || 1) * parseInt(targetUnit.value, 10));
              return AFT.encodeToTarget(canvas, target).then(function (blob) {
                return exact.checked ? AFT.padBlob(blob, target, 'image/jpeg') : blob;
              }).then(function (blob) {
                return { blob: blob, ext: '.jpg', orig: f };
              });
            }
            var q = parseInt(quality.value, 10) / 100;
            return AFT.canvasToBlob(canvas, type, type === 'image/png' ? undefined : q).then(function (blob) {
              var ext = type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : '.jpg';
              return { blob: blob, ext: ext, orig: f };
            });
          });
        }).then(function (res) {
          results.add({
            name: AFT.baseName(res.orig.name) + '-aft' + res.ext,
            blob: res.blob,
            before: res.orig.size,
            thumbUrl: URL.createObjectURL(res.blob)
          });
          next();
        }).catch(function () {
          status.set('Could not process ' + f.name + ' — skipped.', true);
          next();
        });
      };
      next();
    });
  });

  /* =====================================================================
   * 2. Image Cropper (Cropper.js)
   * =================================================================== */
  AFT.register('image-crop', function (root) {
    var cropper = null, currentFile = null;
    var status, results;

    var drop = AFT.dropzone({
      title: 'Drop an image here or click to browse',
      hint: 'Then drag the crop box; use a preset ratio if you like',
      accept: 'image/*,.heic,.heif',
      onFiles: function (fs) { loadFile(fs[0]); }
    });
    root.appendChild(drop);

    var panel = AFT.sectionPanel('Crop');
    panel.style.display = 'none';
    var ratios = [
      ['Free', NaN], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9],
      ['Passport 35×45', 35 / 45], ['US 2×2 in', 1]
    ];
    var ratioRow = h('div', { class: 'aft-row' });
    ratios.forEach(function (r) {
      ratioRow.appendChild(h('button', {
        class: 'aft-btn aft-secondary aft-small', text: r[0],
        onclick: function () { if (cropper) cropper.setAspectRatio(r[1]); }
      }));
    });
    panel.appendChild(ratioRow);
    var wrap = h('div', { class: 'aft-crop-wrap' });
    panel.appendChild(wrap);
    var rotL = h('button', { class: 'aft-btn aft-secondary aft-small', text: '⟲ Rotate', onclick: function () { if (cropper) cropper.rotate(-90); } });
    var rotR = h('button', { class: 'aft-btn aft-secondary aft-small', text: 'Rotate ⟳', onclick: function () { if (cropper) cropper.rotate(90); } });
    var go = h('button', { class: 'aft-btn', text: 'Crop & download' });
    panel.appendChild(h('div', { class: 'aft-row', style: 'margin-top:12px' }, [rotL, rotR, go]));
    root.appendChild(panel);
    status = AFT.statusBar(root);
    results = AFT.resultsList(root, 'cropped.zip');

    function loadFile(f) {
      status.set('Loading…');
      AFT.normalizeImageFile(f).then(function (nf) {
        currentFile = nf;
        AFT.loadCss(CDN.cropperCss);
        return AFT.loadScript(CDN.cropperJs);
      }).then(function () {
        if (cropper) { cropper.destroy(); cropper = null; }
        wrap.innerHTML = '';
        var img = h('img', { src: URL.createObjectURL(currentFile) });
        wrap.appendChild(img);
        panel.style.display = '';
        img.onload = function () {
          cropper = new window.Cropper(img, { viewMode: 1, autoCropArea: 0.9 });
          status.set('Drag to adjust the crop, then hit "Crop & download".');
        };
      }).catch(function () { status.set('Could not open that image.', true); });
    }

    go.addEventListener('click', function () {
      if (!cropper) return;
      var canvas = cropper.getCroppedCanvas({ imageSmoothingQuality: 'high' });
      var type = currentFile.type === 'image/png' ? 'image/png' : 'image/jpeg';
      AFT.canvasToBlob(canvas, type, 0.92).then(function (blob) {
        var ext = type === 'image/png' ? '.png' : '.jpg';
        var name = AFT.baseName(currentFile.name) + '-cropped' + ext;
        results.add({ name: name, blob: blob, thumbUrl: URL.createObjectURL(blob) });
        AFT.downloadBlob(blob, name);
        status.set('Cropped!');
      });
    });
  });

  /* =====================================================================
   * 3. Image Sharpener & Enhancer (unsharp mask + tone controls)
   * =================================================================== */
  AFT.register('image-sharpen', function (root) {
    var srcCanvas = null, currentFile = null, status, results;
    var preview = h('div', { class: 'aft-preview' });
    var out = document.createElement('canvas');

    root.appendChild(AFT.dropzone({
      title: 'Drop a photo here or click to browse',
      hint: 'Sharpen and enhance — everything stays on your device',
      accept: 'image/*,.heic,.heif',
      onFiles: function (fs) { loadFile(fs[0]); }
    }));

    var panel = AFT.sectionPanel('Adjust');
    panel.style.display = 'none';
    function slider(label, min, max, val, step) {
      var s = h('input', { type: 'range', min: String(min), max: String(max), value: String(val), step: String(step || 1) });
      var v = h('span', { text: String(val) });
      s.addEventListener('input', function () { v.textContent = s.value; schedule(); });
      panel.appendChild(h('div', { class: 'aft-row' }, [
        h('div', { class: 'aft-field' }, [h('label', { text: label }), h('div', {}, [s, ' ', v])])
      ]));
      return s;
    }
    var sharp = slider('Sharpen', 0, 100, 40);
    var bright = slider('Brightness', -100, 100, 0);
    var contrast = slider('Contrast', -100, 100, 0);
    var sat = slider('Saturation', -100, 100, 0);
    var go = h('button', { class: 'aft-btn', text: 'Download enhanced image' });
    panel.appendChild(h('div', { class: 'aft-row' }, [go]));
    root.appendChild(panel);
    preview.appendChild(out);
    root.appendChild(preview);
    status = AFT.statusBar(root);
    results = AFT.resultsList(root, 'enhanced.zip');

    var timer = null;
    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(render, 120);
    }

    function loadFile(f) {
      status.set('Loading…');
      AFT.normalizeImageFile(f).then(function (nf) {
        currentFile = nf;
        return AFT.loadImageBitmap(nf);
      }).then(function (img) {
        srcCanvas = AFT.drawToCanvas(img, 2400, 2400);
        panel.style.display = '';
        render();
        status.set('Tweak the sliders — preview updates live.');
      }).catch(function () { status.set('Could not open that image.', true); });
    }

    function render() {
      if (!srcCanvas) return;
      var w = srcCanvas.width, hgt = srcCanvas.height;
      out.width = w; out.height = hgt;
      var ctx = out.getContext('2d');
      var b = 1 + parseInt(bright.value, 10) / 100;
      var c = 1 + parseInt(contrast.value, 10) / 100;
      var s = 1 + parseInt(sat.value, 10) / 100;
      ctx.filter = 'brightness(' + b + ') contrast(' + c + ') saturate(' + s + ')';
      ctx.drawImage(srcCanvas, 0, 0);
      ctx.filter = 'none';

      var amount = parseInt(sharp.value, 10) / 100;
      if (amount > 0) {
        var img = ctx.getImageData(0, 0, w, hgt);
        var d = img.data;
        var copy = new Uint8ClampedArray(d);
        var k = amount * 0.8;
        // 3×3 unsharp kernel: center 1+4k, cross −k
        for (var y = 1; y < hgt - 1; y++) {
          for (var x = 1; x < w - 1; x++) {
            var p = (y * w + x) * 4;
            for (var ch = 0; ch < 3; ch++) {
              var i = p + ch;
              d[i] = copy[i] * (1 + 4 * k)
                - k * (copy[i - 4] + copy[i + 4] + copy[i - w * 4] + copy[i + w * 4]);
            }
          }
        }
        ctx.putImageData(img, 0, 0);
      }
    }

    go.addEventListener('click', function () {
      if (!srcCanvas) return;
      AFT.canvasToBlob(out, 'image/jpeg', 0.93).then(function (blob) {
        var name = AFT.baseName(currentFile.name) + '-enhanced.jpg';
        results.add({ name: name, blob: blob, thumbUrl: URL.createObjectURL(blob) });
        AFT.downloadBlob(blob, name);
      });
    });
  });

  /* =====================================================================
   * 4. Image Converter (JPG/PNG/WebP/BMP in, JPG/PNG/WebP out, HEIC in)
   * =================================================================== */
  AFT.register('image-convert', function (root) {
    var files = [], status, results;
    root.appendChild(AFT.dropzone({
      title: 'Drop images here or click to browse',
      hint: 'Convert between JPG, PNG, WebP — HEIC input supported. Batch OK.',
      accept: 'image/*,.heic,.heif,.bmp',
      multiple: true,
      onFiles: function (fs) { files = fs; status.set(fs.length + ' image(s) ready.'); }
    }));

    var panel = AFT.sectionPanel('Convert to');
    var fmt = h('select', {}, [
      h('option', { value: 'image/jpeg', text: 'JPG' }),
      h('option', { value: 'image/png', text: 'PNG' }),
      h('option', { value: 'image/webp', text: 'WebP' })
    ]);
    var quality = h('input', { type: 'range', min: '10', max: '100', value: '90' });
    var qLabel = h('span', { text: '90%' });
    quality.addEventListener('input', function () { qLabel.textContent = quality.value + '%'; });
    var go = h('button', { class: 'aft-btn', text: 'Convert' });
    panel.appendChild(h('div', { class: 'aft-row' }, [
      h('div', { class: 'aft-field' }, [h('label', { text: 'Format' }), fmt]),
      h('div', { class: 'aft-field' }, [h('label', { text: 'Quality (JPG/WebP)' }), h('div', {}, [quality, ' ', qLabel])]),
      go
    ]));
    root.appendChild(panel);
    status = AFT.statusBar(root);
    results = AFT.resultsList(root, 'converted-images.zip');

    go.addEventListener('click', function () {
      if (!files.length) { status.set('Add at least one image first.', true); return; }
      results.clear();
      go.disabled = true;
      var type = fmt.value;
      var ext = type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : '.jpg';
      var q = parseInt(quality.value, 10) / 100;
      var i = 0;
      var next = function () {
        if (i >= files.length) { status.set('Done.'); status.progress(null); go.disabled = false; return; }
        var f = files[i++];
        status.set('Converting ' + f.name + '…');
        status.progress((i - 1) / files.length);
        AFT.normalizeImageFile(f).then(AFT.loadImageBitmap).then(function (img) {
          var canvas = AFT.drawToCanvas(img);
          if (type === 'image/jpeg') {
            // Flatten transparency onto white for JPG output
            var flat = document.createElement('canvas');
            flat.width = canvas.width; flat.height = canvas.height;
            var fctx = flat.getContext('2d');
            fctx.fillStyle = '#ffffff';
            fctx.fillRect(0, 0, flat.width, flat.height);
            fctx.drawImage(canvas, 0, 0);
            canvas = flat;
          }
          return AFT.canvasToBlob(canvas, type, type === 'image/png' ? undefined : q);
        }).then(function (blob) {
          results.add({
            name: AFT.baseName(f.name) + ext,
            blob: blob,
            before: f.size,
            thumbUrl: URL.createObjectURL(blob)
          });
          next();
        }).catch(function () { status.set('Could not convert ' + f.name + ' — skipped.', true); next(); });
      };
      next();
    });
  });

  /* =====================================================================
   * 5. Image → PDF (jsPDF)
   * =================================================================== */
  AFT.register('image-to-pdf', function (root) {
    var files = [], status;
    var listUl = h('ul', { class: 'aft-list' });

    root.appendChild(AFT.dropzone({
      title: 'Drop images here or click to browse',
      hint: 'Each image becomes a PDF page, in the order listed below',
      accept: 'image/*,.heic,.heif',
      multiple: true,
      onFiles: function (fs) {
        files = files.concat(fs);
        renderList();
        status.set(files.length + ' image(s) queued.');
      }
    }));
    root.appendChild(listUl);

    function renderList() {
      listUl.innerHTML = '';
      files.forEach(function (f, idx) {
        var li = h('li', {}, [
          h('span', { class: 'aft-fname', text: (idx + 1) + '. ' + f.name }),
          h('span', { class: 'aft-fsize', text: AFT.fmtBytes(f.size) }),
          h('button', { class: 'aft-btn aft-small aft-secondary', text: '↑', onclick: function () { move(idx, -1); } }),
          h('button', { class: 'aft-btn aft-small aft-secondary', text: '↓', onclick: function () { move(idx, 1); } }),
          h('button', { class: 'aft-btn aft-small aft-secondary', text: '✕', onclick: function () { files.splice(idx, 1); renderList(); } })
        ]);
        listUl.appendChild(li);
      });
    }
    function move(i, d) {
      var j = i + d;
      if (j < 0 || j >= files.length) return;
      var t = files[i]; files[i] = files[j]; files[j] = t;
      renderList();
    }

    var panel = AFT.sectionPanel('PDF options');
    var pageSize = h('select', {}, [
      h('option', { value: 'a4', text: 'A4' }),
      h('option', { value: 'letter', text: 'Letter' }),
      h('option', { value: 'fit', text: 'Fit each image (page = image size)' })
    ]);
    var margin = h('input', { type: 'number', min: '0', max: '50', value: '10', style: 'width:80px' });
    var go = h('button', { class: 'aft-btn', text: 'Create PDF' });
    panel.appendChild(h('div', { class: 'aft-row' }, [
      h('div', { class: 'aft-field' }, [h('label', { text: 'Page size' }), pageSize]),
      h('div', { class: 'aft-field' }, [h('label', { text: 'Margin (mm)' }), margin]),
      go
    ]));
    root.appendChild(panel);
    status = AFT.statusBar(root);
    var results = AFT.resultsList(root, 'pdfs.zip');

    go.addEventListener('click', function () {
      if (!files.length) { status.set('Add at least one image first.', true); return; }
      go.disabled = true;
      status.set('Building PDF…');
      AFT.loadScript(CDN.jspdf).then(function () {
        var JsPDF = window.jspdf.jsPDF;
        var doc = null;
        var mar = parseInt(margin.value, 10) || 0;
        var i = 0;
        var addNext = function () {
          if (i >= files.length) {
            var blob = doc.output('blob');
            var name = (files.length === 1 ? AFT.baseName(files[0].name) : 'images') + '.pdf';
            results.add({ name: name, blob: blob });
            AFT.downloadBlob(blob, name);
            status.set('PDF ready — ' + files.length + ' page(s).');
            status.progress(null);
            go.disabled = false;
            return;
          }
          var f = files[i++];
          status.progress((i - 1) / files.length);
          AFT.normalizeImageFile(f).then(AFT.loadImageBitmap).then(function (img) {
            var canvas = AFT.drawToCanvas(img, 2400, 2400);
            var data = canvas.toDataURL('image/jpeg', 0.92);
            var wmm, hmm;
            if (pageSize.value === 'fit') {
              wmm = canvas.width * 0.264583; hmm = canvas.height * 0.264583;
              if (!doc) doc = new JsPDF({ unit: 'mm', format: [wmm, hmm] });
              else doc.addPage([wmm, hmm]);
              doc.addImage(data, 'JPEG', 0, 0, wmm, hmm);
            } else {
              if (!doc) doc = new JsPDF({ unit: 'mm', format: pageSize.value });
              else doc.addPage(pageSize.value);
              var pw = doc.internal.pageSize.getWidth() - mar * 2;
              var ph = doc.internal.pageSize.getHeight() - mar * 2;
              var scale = Math.min(pw / canvas.width, ph / canvas.height);
              var w = canvas.width * scale, hh = canvas.height * scale;
              doc.addImage(data, 'JPEG', mar + (pw - w) / 2, mar + (ph - hh) / 2, w, hh);
            }
            addNext();
          }).catch(function () { status.set('Skipped unreadable image: ' + f.name, true); addNext(); });
        };
        addNext();
      }).catch(function () { status.set('Could not load the PDF library. Check your connection.', true); go.disabled = false; });
    });
  });
})();
