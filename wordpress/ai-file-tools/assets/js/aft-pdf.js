/* AI File Tools — PDF tools: compress (target size), merge, split, rotate, PDF→images. */
(function () {
  'use strict';
  var AFT = window.AFT, h = AFT.h, CDN = AFT.cfg.cdn;

  function loadPdfJs() {
    return AFT.loadScript(CDN.pdfjs).then(function () {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfjsWorker;
      return window.pdfjsLib;
    });
  }

  function loadPdfLib() {
    return AFT.loadScript(CDN.pdfLib).then(function () { return window.PDFLib; });
  }

  function readBuffer(file) {
    return file.arrayBuffer();
  }

  /* Render every page of a PDF to canvases at a given scale. */
  function renderPages(file, scale, onPage, onProgress) {
    return loadPdfJs().then(function (pdfjsLib) {
      return readBuffer(file).then(function (buf) {
        return pdfjsLib.getDocument({ data: buf }).promise;
      }).then(function (doc) {
        var i = 1;
        var next = function () {
          if (i > doc.numPages) return Promise.resolve(doc.numPages);
          return doc.getPage(i).then(function (page) {
            var vp = page.getViewport({ scale: scale });
            var canvas = document.createElement('canvas');
            canvas.width = Math.round(vp.width);
            canvas.height = Math.round(vp.height);
            return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(function () {
              if (onProgress) onProgress(i / doc.numPages);
              return onPage(canvas, i, doc.numPages);
            });
          }).then(function () { i++; return next(); });
        };
        return next();
      });
    });
  }

  /* Rebuild a PDF from page canvases as JPEGs at a given quality. */
  function rebuildPdf(file, scale, quality, onProgress) {
    return AFT.loadScript(CDN.jspdf).then(function () {
      var JsPDF = window.jspdf.jsPDF;
      var doc = null;
      return renderPages(file, scale, function (canvas) {
        var wmm = canvas.width * 0.264583 / scale;
        var hmm = canvas.height * 0.264583 / scale;
        if (!doc) doc = new JsPDF({ unit: 'mm', format: [wmm, hmm], compress: true });
        else doc.addPage([wmm, hmm]);
        doc.addImage(canvas.toDataURL('image/jpeg', quality), 'JPEG', 0, 0, wmm, hmm);
      }, onProgress).then(function () {
        return doc.output('blob');
      });
    });
  }

  /* =====================================================================
   * PDF Compressor — quality presets or exact target size (shrink or grow)
   * =================================================================== */
  AFT.register('pdf-compress', function (root) {
    var file = null, status, results;
    root.appendChild(AFT.dropzone({
      title: 'Drop a PDF here or click to browse',
      hint: 'Compressed on your device — the file never leaves your browser',
      accept: 'application/pdf,.pdf',
      onFiles: function (fs) { file = fs[0]; status.set(file.name + ' (' + AFT.fmtBytes(file.size) + ') ready.'); }
    }));

    var panel = AFT.sectionPanel('Options');
    var modeQ = h('input', { type: 'radio', name: 'aft-pmode', checked: 'checked' });
    var modeT = h('input', { type: 'radio', name: 'aft-pmode' });
    panel.appendChild(h('div', { class: 'aft-row' }, [
      h('label', { class: 'aft-inline' }, [modeQ, 'Compression level']),
      h('label', { class: 'aft-inline' }, [modeT, 'Exact target size (shrink or grow)'])
    ]));
    var level = h('select', {}, [
      h('option', { value: 'high', text: 'Strong (smallest file)' }),
      h('option', { value: 'medium', text: 'Balanced (recommended)', selected: 'selected' }),
      h('option', { value: 'low', text: 'Light (best quality)' })
    ]);
    var rowQ = h('div', { class: 'aft-row' }, [h('div', { class: 'aft-field' }, [h('label', { text: 'Level' }), level])]);
    var targetVal = h('input', { type: 'number', min: '1', value: '500', style: 'width:90px' });
    var targetUnit = h('select', {}, [h('option', { value: '1024', text: 'KB' }), h('option', { value: '1048576', text: 'MB' })]);
    var exact = h('input', { type: 'checkbox', checked: 'checked' });
    var rowT = h('div', { class: 'aft-row', style: 'display:none' }, [
      h('div', { class: 'aft-field' }, [h('label', { text: 'Target size' }), h('div', {}, [targetVal, ' ', targetUnit])]),
      h('label', { class: 'aft-inline' }, [exact, 'Exact size (pad up if needed — for portals with a minimum size)'])
    ]);
    panel.appendChild(rowQ);
    panel.appendChild(rowT);
    function syncMode() { rowQ.style.display = modeQ.checked ? '' : 'none'; rowT.style.display = modeT.checked ? '' : 'none'; }
    modeQ.addEventListener('change', syncMode);
    modeT.addEventListener('change', syncMode);
    panel.appendChild(h('p', {}, [h('small', {
      text: 'Note: pages are re-rendered as images, which is what makes big size cuts possible. Selectable text becomes flattened (like a scan).'
    })]));
    var go = h('button', { class: 'aft-btn', text: 'Compress PDF' });
    panel.appendChild(h('div', { class: 'aft-row' }, [go]));
    root.appendChild(panel);
    status = AFT.statusBar(root);
    results = AFT.resultsList(root, 'compressed-pdfs.zip');

    go.addEventListener('click', function () {
      if (!file) { status.set('Add a PDF first.', true); return; }
      go.disabled = true;
      results.clear();
      status.set('Compressing… this can take a moment for large PDFs.');

      var finish = function (blob) {
        var name = AFT.baseName(file.name) + '-compressed.pdf';
        results.add({ name: name, blob: blob, before: file.size });
        AFT.downloadBlob(blob, name);
        status.set('Done: ' + AFT.fmtBytes(file.size) + ' → ' + AFT.fmtBytes(blob.size));
        status.progress(null);
        go.disabled = false;
      };
      var fail = function () { status.set('Could not process that PDF (is it password-protected?).', true); status.progress(null); go.disabled = false; };

      if (modeQ.checked) {
        var presets = { high: [1.2, 0.5], medium: [1.5, 0.7], low: [2.0, 0.85] };
        var p = presets[level.value];
        rebuildPdf(file, p[0], p[1], status.progress).then(finish).catch(fail);
      } else {
        var target = Math.max(10240, (parseFloat(targetVal.value) || 1) * parseInt(targetUnit.value, 10));
        // Iterate: try a few scale/quality combos from best to smallest until under target.
        var combos = [[2.0, 0.85], [1.5, 0.7], [1.5, 0.5], [1.2, 0.45], [1.0, 0.35], [0.8, 0.3]];
        var i = 0, lastBlob = null;
        var attempt = function () {
          if (i >= combos.length) {
            // Could not get under target — deliver the smallest we achieved.
            (exact.checked ? AFT.padBlob(lastBlob, target, 'application/pdf') : Promise.resolve(lastBlob)).then(finish);
            return;
          }
          var c = combos[i++];
          status.set('Trying pass ' + i + ' of ' + combos.length + '…');
          rebuildPdf(file, c[0], c[1], status.progress).then(function (blob) {
            lastBlob = blob;
            if (blob.size <= target) {
              (exact.checked ? AFT.padBlob(blob, target, 'application/pdf') : Promise.resolve(blob)).then(finish);
            } else {
              attempt();
            }
          }).catch(fail);
        };
        attempt();
      }
    });
  });

  /* =====================================================================
   * PDF Merge (pdf-lib keeps pages vector-perfect)
   * =================================================================== */
  AFT.register('pdf-merge', function (root) {
    var files = [], status;
    var listUl = h('ul', { class: 'aft-list' });
    root.appendChild(AFT.dropzone({
      title: 'Drop PDFs here or click to browse',
      hint: 'They will be joined top-to-bottom in the order listed',
      accept: 'application/pdf,.pdf',
      multiple: true,
      onFiles: function (fs) { files = files.concat(fs); renderList(); }
    }));
    root.appendChild(listUl);

    function renderList() {
      listUl.innerHTML = '';
      files.forEach(function (f, idx) {
        listUl.appendChild(h('li', {}, [
          h('span', { class: 'aft-fname', text: (idx + 1) + '. ' + f.name }),
          h('span', { class: 'aft-fsize', text: AFT.fmtBytes(f.size) }),
          h('button', { class: 'aft-btn aft-small aft-secondary', text: '↑', onclick: function () { move(idx, -1); } }),
          h('button', { class: 'aft-btn aft-small aft-secondary', text: '↓', onclick: function () { move(idx, 1); } }),
          h('button', { class: 'aft-btn aft-small aft-secondary', text: '✕', onclick: function () { files.splice(idx, 1); renderList(); } })
        ]));
      });
    }
    function move(i, d) {
      var j = i + d;
      if (j < 0 || j >= files.length) return;
      var t = files[i]; files[i] = files[j]; files[j] = t;
      renderList();
    }

    var go = h('button', { class: 'aft-btn', text: 'Merge PDFs', style: 'margin-top:14px' });
    root.appendChild(go);
    status = AFT.statusBar(root);
    var results = AFT.resultsList(root, 'merged.zip');

    go.addEventListener('click', function () {
      if (files.length < 2) { status.set('Add at least two PDFs.', true); return; }
      go.disabled = true;
      status.set('Merging…');
      loadPdfLib().then(function (PDFLib) {
        return PDFLib.PDFDocument.create().then(function (merged) {
          var i = 0;
          var next = function () {
            if (i >= files.length) {
              return merged.save().then(function (bytes) {
                var blob = new Blob([bytes], { type: 'application/pdf' });
                results.add({ name: 'merged.pdf', blob: blob });
                AFT.downloadBlob(blob, 'merged.pdf');
                status.set('Merged ' + files.length + ' PDFs.');
                go.disabled = false;
              });
            }
            var f = files[i++];
            status.progress((i - 1) / files.length);
            return readBuffer(f).then(function (buf) {
              return PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
            }).then(function (src) {
              return merged.copyPages(src, src.getPageIndices());
            }).then(function (pages) {
              pages.forEach(function (p) { merged.addPage(p); });
              return next();
            });
          };
          return next();
        });
      }).catch(function () { status.set('Merge failed — one of the files may be corrupted or encrypted.', true); go.disabled = false; })
        .then(function () { status.progress(null); });
    });
  });

  /* =====================================================================
   * PDF Split & Extract
   * =================================================================== */
  AFT.register('pdf-split', function (root) {
    var file = null, pageCount = 0, status;
    root.appendChild(AFT.dropzone({
      title: 'Drop a PDF here or click to browse',
      hint: 'Extract a page range, or burst into one file per page',
      accept: 'application/pdf,.pdf',
      onFiles: function (fs) {
        file = fs[0];
        status.set('Reading ' + file.name + '…');
        loadPdfLib().then(function (PDFLib) {
          return readBuffer(file).then(function (buf) { return PDFLib.PDFDocument.load(buf, { ignoreEncryption: true }); });
        }).then(function (doc) {
          pageCount = doc.getPageCount();
          rangeTo.value = String(pageCount);
          status.set(file.name + ' — ' + pageCount + ' pages.');
        }).catch(function () { status.set('Could not read that PDF.', true); });
      }
    }));

    var panel = AFT.sectionPanel('Split');
    var modeR = h('input', { type: 'radio', name: 'aft-smode', checked: 'checked' });
    var modeA = h('input', { type: 'radio', name: 'aft-smode' });
    var rangeFrom = h('input', { type: 'number', min: '1', value: '1', style: 'width:80px' });
    var rangeTo = h('input', { type: 'number', min: '1', value: '1', style: 'width:80px' });
    panel.appendChild(h('div', { class: 'aft-row' }, [
      h('label', { class: 'aft-inline' }, [modeR, 'Extract pages', rangeFrom, 'to', rangeTo]),
      h('label', { class: 'aft-inline' }, [modeA, 'Split into single pages (ZIP)'])
    ]));
    var go = h('button', { class: 'aft-btn', text: 'Split PDF' });
    panel.appendChild(h('div', { class: 'aft-row' }, [go]));
    root.appendChild(panel);
    status = AFT.statusBar(root);
    var results = AFT.resultsList(root, 'split-pages.zip');

    go.addEventListener('click', function () {
      if (!file) { status.set('Add a PDF first.', true); return; }
      go.disabled = true;
      results.clear();
      loadPdfLib().then(function (PDFLib) {
        return readBuffer(file).then(function (buf) {
          return PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
        }).then(function (src) {
          var base = AFT.baseName(file.name);
          if (modeR.checked) {
            var from = Math.max(1, parseInt(rangeFrom.value, 10) || 1);
            var to = Math.min(pageCount, parseInt(rangeTo.value, 10) || pageCount);
            if (from > to) { throw new Error('range'); }
            var indices = [];
            for (var i = from - 1; i < to; i++) indices.push(i);
            return PDFLib.PDFDocument.create().then(function (out) {
              return out.copyPages(src, indices).then(function (pages) {
                pages.forEach(function (p) { out.addPage(p); });
                return out.save();
              });
            }).then(function (bytes) {
              var blob = new Blob([bytes], { type: 'application/pdf' });
              var name = base + '-p' + from + '-' + to + '.pdf';
              results.add({ name: name, blob: blob });
              AFT.downloadBlob(blob, name);
              status.set('Extracted pages ' + from + '–' + to + '.');
            });
          }
          // Burst mode: one PDF per page.
          var idx = 0;
          var next = function () {
            if (idx >= src.getPageCount()) { status.set('Split into ' + idx + ' files — use "Download all as ZIP".'); return Promise.resolve(); }
            status.progress(idx / src.getPageCount());
            return PDFLib.PDFDocument.create().then(function (out) {
              return out.copyPages(src, [idx]).then(function (pages) {
                out.addPage(pages[0]);
                return out.save();
              });
            }).then(function (bytes) {
              idx++;
              results.add({ name: base + '-page-' + idx + '.pdf', blob: new Blob([bytes], { type: 'application/pdf' }) });
              return next();
            });
          };
          return next();
        });
      }).catch(function (e) {
        status.set(e && e.message === 'range' ? 'Invalid page range.' : 'Split failed — file may be corrupted or encrypted.', true);
      }).then(function () { status.progress(null); go.disabled = false; });
    });
  });

  /* =====================================================================
   * PDF Rotate
   * =================================================================== */
  AFT.register('pdf-rotate', function (root) {
    var file = null, status;
    root.appendChild(AFT.dropzone({
      title: 'Drop a PDF here or click to browse',
      hint: 'Rotate all pages, or just the pages you list',
      accept: 'application/pdf,.pdf',
      onFiles: function (fs) { file = fs[0]; status.set(file.name + ' ready.'); }
    }));
    var panel = AFT.sectionPanel('Rotate');
    var angle = h('select', {}, [
      h('option', { value: '90', text: '90° clockwise' }),
      h('option', { value: '180', text: '180°' }),
      h('option', { value: '270', text: '90° counter-clockwise' })
    ]);
    var which = h('input', { type: 'text', placeholder: 'all  (or e.g. 1,3,5-7)', style: 'min-width:180px' });
    var go = h('button', { class: 'aft-btn', text: 'Rotate PDF' });
    panel.appendChild(h('div', { class: 'aft-row' }, [
      h('div', { class: 'aft-field' }, [h('label', { text: 'Angle' }), angle]),
      h('div', { class: 'aft-field' }, [h('label', { text: 'Pages' }), which]),
      go
    ]));
    root.appendChild(panel);
    status = AFT.statusBar(root);
    var results = AFT.resultsList(root, 'rotated.zip');

    function parsePages(text, count) {
      text = (text || '').trim().toLowerCase();
      if (!text || text === 'all') {
        var all = [];
        for (var i = 0; i < count; i++) all.push(i);
        return all;
      }
      var out = {};
      text.split(',').forEach(function (part) {
        var m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
        if (!m) return;
        var a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
        for (var i = a; i <= b; i++) if (i >= 1 && i <= count) out[i - 1] = true;
      });
      return Object.keys(out).map(Number);
    }

    go.addEventListener('click', function () {
      if (!file) { status.set('Add a PDF first.', true); return; }
      go.disabled = true;
      status.set('Rotating…');
      loadPdfLib().then(function (PDFLib) {
        return readBuffer(file).then(function (buf) {
          return PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
        }).then(function (doc) {
          var deg = parseInt(angle.value, 10);
          var pages = doc.getPages();
          parsePages(which.value, pages.length).forEach(function (i) {
            var p = pages[i];
            p.setRotation(PDFLib.degrees(((p.getRotation().angle + deg) % 360 + 360) % 360));
          });
          return doc.save();
        }).then(function (bytes) {
          var blob = new Blob([bytes], { type: 'application/pdf' });
          var name = AFT.baseName(file.name) + '-rotated.pdf';
          results.add({ name: name, blob: blob });
          AFT.downloadBlob(blob, name);
          status.set('Done.');
        });
      }).catch(function () { status.set('Rotate failed — file may be corrupted or encrypted.', true); })
        .then(function () { go.disabled = false; });
    });
  });

  /* =====================================================================
   * PDF → Images
   * =================================================================== */
  AFT.register('pdf-to-image', function (root) {
    var file = null, status;
    root.appendChild(AFT.dropzone({
      title: 'Drop a PDF here or click to browse',
      hint: 'Every page becomes a JPG or PNG image',
      accept: 'application/pdf,.pdf',
      onFiles: function (fs) { file = fs[0]; status.set(file.name + ' ready.'); }
    }));
    var panel = AFT.sectionPanel('Options');
    var fmt = h('select', {}, [
      h('option', { value: 'image/jpeg', text: 'JPG' }),
      h('option', { value: 'image/png', text: 'PNG' })
    ]);
    var dpi = h('select', {}, [
      h('option', { value: '1.5', text: 'Standard (~110 dpi)' }),
      h('option', { value: '2', text: 'High (~150 dpi)', selected: 'selected' }),
      h('option', { value: '3', text: 'Very high (~220 dpi)' })
    ]);
    var go = h('button', { class: 'aft-btn', text: 'Convert pages' });
    panel.appendChild(h('div', { class: 'aft-row' }, [
      h('div', { class: 'aft-field' }, [h('label', { text: 'Format' }), fmt]),
      h('div', { class: 'aft-field' }, [h('label', { text: 'Resolution' }), dpi]),
      go
    ]));
    root.appendChild(panel);
    status = AFT.statusBar(root);
    var results = AFT.resultsList(root, 'pdf-pages.zip');

    go.addEventListener('click', function () {
      if (!file) { status.set('Add a PDF first.', true); return; }
      go.disabled = true;
      results.clear();
      status.set('Rendering pages…');
      var type = fmt.value;
      var ext = type === 'image/png' ? '.png' : '.jpg';
      var base = AFT.baseName(file.name);
      renderPages(file, parseFloat(dpi.value), function (canvas, pageNum) {
        return AFT.canvasToBlob(canvas, type, 0.9).then(function (blob) {
          results.add({
            name: base + '-page-' + pageNum + ext,
            blob: blob,
            thumbUrl: URL.createObjectURL(blob)
          });
        });
      }, status.progress).then(function (n) {
        status.set(n + ' page(s) converted — use "Download all as ZIP" to grab everything.');
      }).catch(function () {
        status.set('Could not render that PDF (is it password-protected?).', true);
      }).then(function () { status.progress(null); go.disabled = false; });
    });
  });
})();
