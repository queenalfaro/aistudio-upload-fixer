// AI Studio Upload Fixer — MAIN world (page-world) script.
// Выполняется напрямую в контексте страницы:
//  1) Перехватывает Drag&Drop без конфликтов Xray / DataTransfer;
//  2) Перехватывает window.showOpenFilePicker (для Chrome / Chromium).

(() => {
  if (window.__aistudioUploadFixerPageWorldLoaded) return;
  window.__aistudioUploadFixerPageWorldLoaded = true;

  console.log('[aistudio-upload-fixer][page-world] loaded');

  const BLOCKED_EXT = new Set([
    'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
    'py', 'pyw',
    'bin', 'dat',
    'sh', 'bash', 'zsh',
    'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
    'rs', 'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc',
    'cs', 'rb', 'php', 'sql', 'lock', 'env',
    'gradle', 'lua', 'swift', 'r', 'dart'
  ]);

  const BLOCKED_FULL_NAMES = new Set([
    'dockerfile',
    'makefile',
    'procfile',
    'gemfile',
    'containerfile',
    'jenkinsfile'
  ]);

  const TARGET_EXT = 'txt';
  const TARGET_MIME = 'text/plain';

  function needsRename(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    if (BLOCKED_FULL_NAMES.has(lower)) return true;

    const dot = name.lastIndexOf('.');
    if (dot === -1 || dot === name.length - 1) return false;

    const ext = name.slice(dot + 1).toLowerCase();
    return BLOCKED_EXT.has(ext);
  }

  function renamedName(name) {
    const lower = name.toLowerCase();
    if (BLOCKED_FULL_NAMES.has(lower)) {
      return `${name}.${TARGET_EXT}`;
    }

    const dot = name.lastIndexOf('.');
    if (dot === 0) {
      return `${name}.${TARGET_EXT}`;
    }

    const base = dot === -1 ? name : name.slice(0, dot);
    return `${base}.${TARGET_EXT}`;
  }

  function maybeRenameFile(file) {
    if (!file || !needsRename(file.name)) return file;
    const newName = renamedName(file.name);
    console.debug('[aistudio-upload-fixer][page-world] renaming', file.name, '->', newName);
    return new File([file], newName, {
      type: TARGET_MIME,
      lastModified: file.lastModified,
    });
  }

  // --- 1. Перехват Drag & Drop ---
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;

    const originalFiles = Array.from(e.dataTransfer.files);
    if (!originalFiles.some((f) => needsRename(f.name))) {
      return; // ничего переименовывать не нужно
    }

    e.stopImmediatePropagation();
    e.preventDefault();

    const newDT = new DataTransfer();
    for (const f of originalFiles) {
      newDT.items.add(maybeRenameFile(f));
    }

    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const target = path[0] || e.target;

    console.debug('[aistudio-upload-fixer][page-world] redispatching drop on', target,
      'files:', Array.from(newDT.files).map((f) => f.name));

    const newEvent = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: e.clientX,
      clientY: e.clientY,
      dataTransfer: newDT,
    });

    target.dispatchEvent(newEvent);
  }, true);

  // --- 2. Перехват File System Access API (window.showOpenFilePicker для Chromium) ---
  if (typeof window.showOpenFilePicker === 'function') {
    const originalShowOpenFilePicker = window.showOpenFilePicker;
    window.showOpenFilePicker = async function (...args) {
      const handles = await originalShowOpenFilePicker.apply(this, args);
      return handles.map((handle) => {
        if (handle.kind === 'file' && needsRename(handle.name)) {
          const originalGetFile = handle.getFile.bind(handle);
          const newName = renamedName(handle.name);

          // Proxy подменяет и свойство handle.name, и результат handle.getFile()
          return new Proxy(handle, {
            get(target, prop, receiver) {
              if (prop === 'name') return newName;
              if (prop === 'getFile') {
                return async () => {
                  const file = await originalGetFile();
                  return maybeRenameFile(file);
                };
              }
              const val = Reflect.get(target, prop, receiver);
              return typeof val === 'function' ? val.bind(target) : val;
            },
          });
        }
        return handle;
      });
    };
  }
})();