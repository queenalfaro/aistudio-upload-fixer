// AI Studio Upload Fixer — MAIN world script (v3.0)
// Адаптивное мягкое подделывание расширения файлов для Google AI Studio (.txt только при отказе сервисом)

(() => {
  const LOG_PREFIX = '[AI Studio Upload Fixer]';
  console.info(`${LOG_PREFIX} Initializing v3.0 on`, window.location.href);

  // Очистка старых слушателей при перезагрузке расширения
  if (window.__aistudioUploadFixerCleanup) {
    try {
      window.__aistudioUploadFixerCleanup();
    } catch (e) {}
  }

  // Кэш исходных файлов и сет повторно отправленных имен
  const fileCache = new Map();
  const retryingNames = new Set();
  let lastBatchFiles = [];

  // Создание копии файла с постфиксом .txt и типом text/plain
  function createTxtFile(originalFile) {
    const originalName = originalFile.name || 'file';
    const newName = originalName.endsWith('.txt') ? originalName : `${originalName}.txt`;
    const fixedFile = new File([originalFile], newName, {
      type: 'text/plain',
      lastModified: originalFile.lastModified || Date.now(),
    });
    fixedFile.__uploadFixerRetried = true;
    return fixedFile;
  }

  // Программная отправка исправленных файлов в рантайм AI Studio
  function dispatchFixedFiles(files) {
    if (!files || files.length === 0) return;
    console.info(`${LOG_PREFIX} Dispatching fixed .txt files:`, files.map((f) => f.name));

    for (const f of files) {
      fileCache.set(f.name, f);
      retryingNames.add(f.name);
    }

    const dropTarget =
      document.querySelector('[msglobalfiledragdrop]') ||
      document.querySelector('.chat-view-container') ||
      document.body;

    const dt = new DataTransfer();
    for (const f of files) {
      dt.items.add(f);
    }

    const dropEvt = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer: dt,
    });
    dropEvt.__isUploadFixerHandled = true;

    dropTarget.dispatchEvent(dropEvt);
  }

  // 1. Перехват события DROP: сохраняем файлы в кэш и отдаем сервису как есть (без предварительного переименования)
  function onDrop(e) {
    if (e.__isUploadFixerHandled) return;
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;

    const files = Array.from(e.dataTransfer.files);
    console.info(`${LOG_PREFIX} User dropped files (passing as-is):`, files.map((f) => f.name));

    for (const f of files) {
      fileCache.set(f.name, f);
    }
    lastBatchFiles = files;
  }

  window.addEventListener('drop', onDrop, true);

  // 2. Перехват события CHANGE на <input type="file">: также кэшируем и отдаем как есть
  function onInputChange(e) {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    if (input.__isUploadFixerHandled) return;
    if (!input.files || input.files.length === 0) return;

    const files = Array.from(input.files);
    console.info(`${LOG_PREFIX} User selected files via input (passing as-is):`, files.map((f) => f.name));

    for (const f of files) {
      fileCache.set(f.name, f);
    }
    lastBatchFiles = files;
  }

  window.addEventListener('change', onInputChange, true);

  // 3. Обработка фронтенд-отказа (всплывающий тост об ошибке)
  function handleFrontendRejection(toastText) {
    console.warn(`${LOG_PREFIX} Handling frontend rejection: ${toastText}`);

    const currentChipNames = new Set(
      Array.from(document.querySelectorAll('.prompt-media-item-container .name')).map((el) =>
        el.textContent.trim()
      )
    );

    const rejectedFiles = lastBatchFiles.filter(
      (f) => !currentChipNames.has(f.name) && !retryingNames.has(`${f.name}.txt`)
    );

    if (rejectedFiles.length > 0) {
      console.info(`${LOG_PREFIX} Converting frontend-rejected files to .txt:`, rejectedFiles.map((f) => f.name));
      const fixedFiles = rejectedFiles.map(createTxtFile);
      dispatchFixedFiles(fixedFiles);
    }
  }

  // 4. Обработка бэкенд-отказа (статус "Unsupported file" на чипе в промпте)
  function handleBackendRejection() {
    const errorBadges = document.querySelectorAll('.token-status-error, [data-test-id="status"]');

    for (const badge of errorBadges) {
      const text = (badge.textContent || '').trim();
      if (!text.toLowerCase().includes('unsupported')) continue;

      const chip =
        badge.closest('.prompt-media-item-container') ||
        badge.closest('ms-prompt-media') ||
        badge.parentElement?.parentElement;

      if (!chip || chip.__uploadFixerHandling) continue;
      chip.__uploadFixerHandling = true;

      const nameEl = chip.querySelector('.name');
      const filename = nameEl ? nameEl.textContent.trim() : '';
      console.warn(`${LOG_PREFIX} Backend rejected chip: "${filename}" (${text})`);

      let originalFile = fileCache.get(filename);
      if (!originalFile) {
        originalFile = lastBatchFiles.find((f) => f.name === filename);
      }

      // Удаляем отклоненный чип через кнопку закрытия
      const removeBtn = chip.querySelector(
        'button[aria-label*="Remove"], button[aria-label*="delete"], [mattooltip*="Remove"]'
      );
      if (removeBtn) {
        removeBtn.click();
      } else {
        chip.remove();
      }

      if (originalFile && !originalFile.name.endsWith('.txt') && !retryingNames.has(`${originalFile.name}.txt`)) {
        const fixedFile = createTxtFile(originalFile);
        console.info(`${LOG_PREFIX} Replacing rejected chip with .txt: "${filename}" -> "${fixedFile.name}"`);
        dispatchFixedFiles([fixedFile]);
      }
    }
  }

  // 5. Реактивный перехват через MutationObserver (без таймеров и без setInterval)
  const domObserver = new MutationObserver((mutations) => {
    let checkChips = false;

    for (const m of mutations) {
      // Проверка на появление контейнеров тостов (фронтенд-отказ)
      for (const node of m.addedNodes) {
        if (!node || node.nodeType !== 1) continue;

        if (
          node.classList?.contains('mat-mdc-snack-bar-container') ||
          node.classList?.contains('mat-snack-bar-container') ||
          node.classList?.contains('ms-toast-snack-bar-container') ||
          node.querySelector?.('.mat-mdc-snack-bar-container, .ms-toast-snack-bar-container')
        ) {
          queueMicrotask(() => {
            const text = (node.textContent || '').trim().toLowerCase();
            if (
              text.includes("doesn't support") ||
              text.includes("not all files are supported") ||
              text.includes("unsupported")
            ) {
              console.warn(`${LOG_PREFIX} Suppressed error toast:`, text);
              node.style.display = 'none';
              node.remove();
              handleFrontendRejection(text);
            }
          });
        }

        if (
          node.classList?.contains('prompt-media-item-container') ||
          node.classList?.contains('token-status-error') ||
          node.tagName === 'MS-PROMPT-MEDIA' ||
          node.tagName === 'MS-TOKEN-STATUS'
        ) {
          checkChips = true;
        }
      }

      if (m.type === 'characterData') {
        const val = m.target?.nodeValue || '';
        if (val.toLowerCase().includes('unsupported')) {
          checkChips = true;
        }
      }

      if (m.type === 'childList') {
        checkChips = true;
      }
    }

    if (checkChips) {
      queueMicrotask(handleBackendRejection);
    }
  });

  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Очистка при перезагрузке
  window.__aistudioUploadFixerCleanup = () => {
    window.removeEventListener('drop', onDrop, true);
    window.removeEventListener('change', onInputChange, true);
    domObserver.disconnect();
    console.debug(`${LOG_PREFIX} Observers cleaned up.`);
  };

  console.info(`${LOG_PREFIX} v3.0 fully initialized.`);
})();
