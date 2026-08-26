// AI Studio Upload Fixer — isolated world (content script)
// Обрабатывает классический <input type="file"> и сквозную диагностику.

(() => {
  // --- Диагностика: ловим реальный stack trace ошибки страницы ---
  window.addEventListener('error', (e) => {
    console.log('[aistudio-upload-fixer][diag] window error:', {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error && e.error.stack,
    });
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    console.log('[aistudio-upload-fixer][diag] unhandled rejection:', {
      reason,
      message: reason && reason.message,
      stack: reason && reason.stack,
    });
  }, true);

  // Расширения, на которые AI Studio может ругаться как на Unsupported file
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

  // Файлы без расширений или спец-файлы
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
    // Dot-файлы без отдельного расширения (например: .env, .gitignore)
    if (dot === 0) {
      return `${name}.${TARGET_EXT}`;
    }

    const base = dot === -1 ? name : name.slice(0, dot);
    return `${base}.${TARGET_EXT}`;
  }

  function maybeRenameFile(file) {
    if (!file || !needsRename(file.name)) return file;
    const newName = renamedName(file.name);
    console.debug('[aistudio-upload-fixer][content] renaming', file.name, '->', newName);
    return new File([file], newName, {
      type: TARGET_MIME,
      lastModified: file.lastModified,
    });
  }

  function buildRenamedFileList(fileList) {
    let changed = false;
    const dt = new DataTransfer();
    for (const f of fileList) {
      const nf = maybeRenameFile(f);
      if (nf !== f) changed = true;
      dt.items.add(nf);
    }
    return changed ? dt.files : null;
  }

  // --- Обычный выбор файла через <input type="file"> ---
  window.addEventListener('change', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    if (!input.files || input.files.length === 0) return;

    const newFiles = buildRenamedFileList(input.files);
    if (!newFiles) return; // ничего не менялось — пропускаем как есть

    e.stopImmediatePropagation();
    e.preventDefault();

    input.files = newFiles;
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }, true);
})();