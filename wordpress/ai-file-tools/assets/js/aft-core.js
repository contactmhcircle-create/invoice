/* AI File Tools — core runtime shared by every tool. */
(function () {
  'use strict';

  var CFG = window.AFT_CFG || { cdn: {}, i18n: {} };
  var registry = {};
  var loadedScripts = {};

  var AFT = {
    cfg: CFG,

    register: function (name, renderFn) {
      registry[name] = renderFn;
    },

    /* ---- tiny DOM helper ---- */
    h: function (tag, attrs, children) {
      var el = document.createElement(tag);
      attrs = attrs || {};
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') el.className = attrs[k];
        else if (k === 'text') el.textContent = attrs[k];
        else if (k === 'html') el.innerHTML = attrs[k];
        else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), attrs[k]);
        else el.setAttribute(k, attrs[k]);
      });
      (children || []).forEach(function (c) {
        if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
      return el;
    },

    /* ---- lazy loaders for CDN vendor libs ---- */
    loadScript: function (url) {
      if (!loadedScripts[url]) {
        loadedScripts[url] = new Promise(function (resolve, reject) {
          var s = document.createElement('script');
          s.src = url;
          s.onload = resolve;
          s.onerror = function () { reject(new Error('Failed to load ' + url)); };
          document.head.appendChild(s);
        });
      }
      return loadedScripts[url];
    },

    loadCss: function (url) {
      if (!document.querySelector('link[href="' + url + '"]')) {
        var l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = url;
        document.head.appendChild(l);
      }
    },

    /* ---- formatting ---- */
    fmtBytes: function (n) {
      if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
      if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
      return n + ' B';
    },

    baseName: function (name) {
      return name.replace(/\.[^.]+$/, '');
    },

    /* ---- file input / dropzone ---- */
    dropzone: function (opts) {
      var input = AFT.h('input', { type: 'file', accept: opts.accept || '*/*' });
      if (opts.multiple) input.multiple = true;
      var zone = AFT.h('div', { class: 'aft-drop' }, [
        AFT.h('strong', { text: opts.title || 'Drop files here or click to browse' }),
        AFT.h('span', { text: opts.hint || '' }),
        input
      ]);
      zone.addEventListener('click', function () { input.click(); });
      input.addEventListener('change', function () {
        if (input.files.length) opts.onFiles(Array.prototype.slice.call(input.files));
        input.value = '';
      });
      ['dragover', 'dragenter'].forEach(function (ev) {
        zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('aft-over'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('aft-over'); });
      });
      zone.addEventListener('drop', function (e) {
        var files = Array.prototype.slice.call(e.dataTransfer.files);
        if (files.length) opts.onFiles(files);
      });
      return zone;
    },

    /* ---- status + progress ---- */
    statusBar: function (root) {
      var bar = AFT.h('div', { class: 'aft-progress' }, [AFT.h('div')]);
      var msg = AFT.h('div', { class: 'aft-status' });
      root.appendChild(msg);
      root.appendChild(bar);
      return {
        set: function (text, isError) {
          msg.textContent = text || '';
          msg.classList.toggle('aft-error', !!isError);
        },
        progress: function (frac) {
          if (frac == null) { bar.classList.remove('aft-on'); return; }
          bar.classList.add('aft-on');
          bar.firstChild.style.width = Math.round(frac * 100) + '%';
        }
      };
    },

    /* ---- downloads ---- */
    downloadBlob: function (blob, filename) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 2000);
    },

    downloadZip: function (entries, zipName, done) {
      // entries: [{name, blob}]
      AFT.loadScript(CFG.cdn.fflate).then(function () {
        var remaining = entries.length;
        var files = {};
        entries.forEach(function (e) {
          e.blob.arrayBuffer().then(function (buf) {
            files[e.name] = new Uint8Array(buf);
            if (--remaining === 0) {
              window.fflate.zip(files, { level: 0 }, function (err, data) {
                if (err) { if (done) done(err); return; }
                AFT.downloadBlob(new Blob([data], { type: 'application/zip' }), zipName);
                if (done) done(null);
              });
            }
          });
        });
      });
    },

    /* ---- results list ---- */
    resultsList: function (root, zipName) {
      var panel = AFT.h('div', { class: 'aft-panel', style: 'display:none' });
      panel.appendChild(AFT.h('h4', { text: 'Results' }));
      var ul = AFT.h('ul', { class: 'aft-list' });
      panel.appendChild(ul);
      var items = [];
      var zipBtn = AFT.h('button', {
        class: 'aft-btn aft-secondary', style: 'margin-top:12px', text: 'Download all as ZIP',
        onclick: function () { AFT.downloadZip(items, zipName || 'files.zip'); }
      });
      panel.appendChild(zipBtn);
      root.appendChild(panel);
      return {
        clear: function () { ul.innerHTML = ''; items = []; panel.style.display = 'none'; },
        add: function (opts) {
          // opts: {name, blob, before (bytes, optional), thumbUrl (optional)}
          items.push({ name: opts.name, blob: opts.blob });
          var li = AFT.h('li');
          if (opts.thumbUrl) li.appendChild(AFT.h('img', { class: 'aft-thumb', src: opts.thumbUrl, alt: '' }));
          li.appendChild(AFT.h('span', { class: 'aft-fname', text: opts.name }));
          var sizeTxt = AFT.fmtBytes(opts.blob.size);
          if (opts.before != null) {
            var delta = 100 - Math.round((opts.blob.size / opts.before) * 100);
            li.appendChild(AFT.h('span', { class: 'aft-fsize', text: AFT.fmtBytes(opts.before) + ' → ' + sizeTxt }));
            li.appendChild(AFT.h('span', {
              class: 'aft-saving' + (delta < 0 ? ' aft-grew' : ''),
              text: (delta >= 0 ? '−' : '+') + Math.abs(delta) + '%'
            }));
          } else {
            li.appendChild(AFT.h('span', { class: 'aft-fsize', text: sizeTxt }));
          }
          li.appendChild(AFT.h('button', {
            class: 'aft-btn aft-small', text: (CFG.i18n && CFG.i18n.download) || 'Download',
            onclick: function () { AFT.downloadBlob(opts.blob, opts.name); }
          }));
          ul.appendChild(li);
          panel.style.display = '';
          zipBtn.style.display = items.length > 1 ? '' : 'none';
        }
      };
    },

    /* ---- image loading (EXIF-orientation aware) ---- */
    loadImageBitmap: function (file) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () {
        // Fallback via <img> for formats createImageBitmap rejects
        return new Promise(function (resolve, reject) {
          var url = URL.createObjectURL(file);
          var img = new Image();
          img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
          img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Cannot read image')); };
          img.src = url;
        });
      });
    },

    drawToCanvas: function (imgLike, maxW, maxH) {
      var w = imgLike.width || imgLike.naturalWidth;
      var h = imgLike.height || imgLike.naturalHeight;
      var scale = 1;
      if (maxW && w > maxW) scale = maxW / w;
      if (maxH && h * scale > maxH) scale = maxH / h;
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      c.getContext('2d').drawImage(imgLike, 0, 0, c.width, c.height);
      return c;
    },

    canvasToBlob: function (canvas, type, quality) {
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (b) {
          if (b) resolve(b); else reject(new Error('Export failed'));
        }, type, quality);
      });
    },

    /* Convert a HEIC file to a JPEG blob if needed; passthrough otherwise. */
    normalizeImageFile: function (file) {
      var isHeic = /\.heic$|\.heif$/i.test(file.name) || /heic|heif/.test(file.type);
      if (!isHeic) return Promise.resolve(file);
      return AFT.loadScript(CFG.cdn.heic2any).then(function () {
        return window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
      }).then(function (blob) {
        return new File([blob], AFT.baseName(file.name) + '.jpg', { type: 'image/jpeg' });
      });
    },

    /*
     * Encode a canvas as JPEG aiming at (just under) an exact byte target.
     * Binary-searches quality; if even minimum quality is too big, downscales
     * progressively and retries. Growing up to the target is padBlob's job.
     */
    encodeToTarget: function (canvas, targetBytes, onStep) {
      var lo = 0.05, hi = 0.97, best = null;
      var attempt = function (i) {
        if (i >= 8) return Promise.resolve(best);
        var q = (lo + hi) / 2;
        return AFT.canvasToBlob(canvas, 'image/jpeg', q).then(function (blob) {
          if (onStep) onStep(i / 8);
          if (blob.size <= targetBytes) {
            best = { blob: blob, q: q };
            lo = q;
          } else {
            hi = q;
          }
          return attempt(i + 1);
        });
      };
      return attempt(0).then(function (res) {
        if (res) return res.blob;
        // Even at min quality it's too big → downscale progressively.
        var scale = Math.sqrt(targetBytes / (canvas.width * canvas.height * 0.12));
        scale = Math.min(0.9, Math.max(0.15, scale));
        var c = document.createElement('canvas');
        c.width = Math.max(64, Math.round(canvas.width * scale));
        c.height = Math.max(64, Math.round(canvas.height * scale));
        c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
        if (c.width <= 64 || c.height <= 64) {
          return AFT.canvasToBlob(c, 'image/jpeg', 0.5);
        }
        return AFT.encodeToTarget(c, targetBytes, onStep);
      });
    },

    /*
     * Grow a JPEG or PDF blob to an exact minimum size by appending harmless
     * padding bytes after the end-of-file marker. Standard viewers ignore
     * trailing data, so the file stays perfectly valid.
     */
    padBlob: function (blob, targetBytes, mime) {
      if (blob.size >= targetBytes) return Promise.resolve(blob);
      var pad = new Uint8Array(targetBytes - blob.size);
      // Fill with spaces + newlines (benign in both JPEG trailers and PDFs)
      for (var i = 0; i < pad.length; i++) pad[i] = (i % 64 === 63) ? 10 : 32;
      return Promise.resolve(new Blob([blob, pad], { type: mime || blob.type }));
    },

    sectionPanel: function (title) {
      var p = AFT.h('div', { class: 'aft-panel' });
      if (title) p.appendChild(AFT.h('h4', { text: title }));
      return p;
    }
  };

  window.AFT = AFT;

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.aft-tool[data-aft-tool]').forEach(function (root) {
      var name = root.getAttribute('data-aft-tool');
      // Renderers register on script load; scripts are printed after this one,
      // so defer dispatch to the end of the task queue.
      setTimeout(function () {
        if (registry[name]) {
          try { registry[name](root); } catch (e) {
            root.appendChild(AFT.h('p', { class: 'aft-status aft-error', text: (CFG.i18n && CFG.i18n.error) || 'Error' }));
          }
        }
      }, 0);
    });
  });
})();
