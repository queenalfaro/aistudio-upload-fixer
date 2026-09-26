// AI Studio Upload Fixer — MAIN world script (v4.0 Native In-Memory Interception)
// 100% перехват в памяти рантайма JavaScript без использования DOM-наблюдателей,
// кликов по кнопкам и двойных сетевых загрузок.

(() => {
  const LOG_PREFIX = '[AI Studio Upload Fixer v4.0]';
  console.info(`${LOG_PREFIX} Initializing at document_start on`, window.location.href);

  // Очистка предыдущих слушателей при горячей перезагрузке расширения
  if (window.__aistudioUploadFixerCleanup) {
    try {
      window.__aistudioUploadFixerCleanup();
    } catch (e) {}
  }

  // --- Сессионные хранилища ---
  // Кэш исходных объектов File по имени
  const fileCache = new Map();
  // Кэш объектов File по dataURL (Ce)
  const fileByDataUrl = new Map();
  // Множество имен файлов, которые уже отправлены на повторную загрузку
  const retryingNames = new Set();
  // Сессионный реестр неподдерживаемых типов (Zero-Hardcode Cache)
  const knownUnsupportedTypes = new Set();
  // Последний поступивший батч файлов
  let lastBatchFiles = [];

  let activeStore = null;
  let activeController = null;

  // Определение ключа типа файла: расширение (.zig, .py) либо полное имя (dockerfile, .env)
  function getFileTypeKey(filename) {
    if (!filename) return '';
    const base = filename.trim();
    const lastDot = base.lastIndexOf('.');
    if (lastDot > 0 && lastDot < base.length - 1) {
      return base.slice(lastDot).toLowerCase();
    }
    return base.toLowerCase();
  }

  // Кэширование файла
  function cacheFile(file) {
    if (!file || !file.name) return;
    fileCache.set(file.name, file);
    if (file.name.endsWith('.txt')) {
      const baseName = file.name.slice(0, -4);
      if (!fileCache.has(baseName)) {
        fileCache.set(baseName, file);
      }
    }
  }

  // Получение файла из кэша
  function getCachedFile(filename, dataUrl) {
    if (dataUrl && fileByDataUrl.has(dataUrl)) {
      return fileByDataUrl.get(dataUrl);
    }
    if (filename) {
      if (fileCache.has(filename)) return fileCache.get(filename);
      if (filename.endsWith('.txt')) {
        const base = filename.slice(0, -4);
        if (fileCache.has(base)) return fileCache.get(base);
      }
      for (const [k, v] of fileCache.entries()) {
        if (k === filename || `${k}.txt` === filename || k === `${filename}.txt`) {
          return v;
        }
      }
    }
    if (lastBatchFiles.length === 1) {
      return lastBatchFiles[0];
    }
    return null;
  }

  // Создание копии файла с постфиксом .txt и типом text/plain (zero-copy blob wrapper)
  function createTxtFile(originalFile) {
    const originalName = originalFile.name || 'file';
    const newName = originalName.endsWith('.txt') ? originalName : `${originalName}.txt`;
    const fixedFile = new File([originalFile], newName, {
      type: 'text/plain',
      lastModified: originalFile.lastModified || Date.now(),
    });
    fixedFile.__uploadFixerRetried = true;
    cacheFile(fixedFile);
    return fixedFile;
  }

  // Диспатч исправленных файлов в рантайм AI Studio
  function dispatchFixedFiles(files) {
    if (!files || files.length === 0) return;
    console.info(`${LOG_PREFIX} Dispatching fixed .txt files:`, files.map((f) => f.name));

    for (const f of files) {
      cacheFile(f);
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

  // =========================================================================
  // 1. ПЕРЕХВАТ СТОРА (PromptFileStore / LF) И СИГНАЛА store.F.set
  // =========================================================================

  function handleStoreSet(store, newDict) {
    if (!newDict || typeof newDict !== 'object') return newDict;

    let modified = false;
    let cleanDict = newDict;

    for (const [chunkId, chunk] of Object.entries(newDict)) {
      if (!chunk) continue;

      const errMsg = (chunk.errorMessage || '').toLowerCase();
      const isUnsupported =
        chunk.status === 'ERROR' &&
        (errMsg.includes('unsupported') || errMsg.includes('token count failed'));

      if (isUnsupported) {
        // Извлекаем имя файла: в Google AI Studio MakerSuite имя хранится в chunk.ub.name или chunk.ie.name
        const filename = chunk.ub?.name || chunk.ie?.name || chunk.name || '';
        const dataUrl = chunk.Ce || '';
        console.warn(
          `${LOG_PREFIX} Intercepted backend error in store.F.set! chunkId="${chunkId}", file="${filename}", error="${chunk.errorMessage}"`
        );

        if (!modified) {
          cleanDict = Object.assign({}, newDict);
          modified = true;
        }

        // a) НЕ пускаем ошибку в сигнал (предотвращаем появление красного чипа в DOM)
        delete cleanDict[chunkId];

        // b) Получаем оригинальный файл из памяти/кэша
        let origFile = getCachedFile(filename, dataUrl);
        if (!origFile && filename) {
          origFile = lastBatchFiles.find((f) => f.name === filename);
        }

        // c) Синхронная / микротасковая очистка стейта через store.ix(chunkId)
        queueMicrotask(() => {
          try {
            store.ix(chunkId);
            console.debug(`${LOG_PREFIX} Cleaned state via store.ix("${chunkId}")`);
          } catch (e) {
            console.warn(`${LOG_PREFIX} store.ix error:`, e);
          }
        });

        // d) Запоминаем тип в сессионном реестре (Zero-Hardcode Cache)
        const typeKey = getFileTypeKey(filename);
        if (typeKey) {
          knownUnsupportedTypes.add(typeKey);
          console.info(
            `${LOG_PREFIX} Learned unsupported type: "${typeKey}" (total learned: ${knownUnsupportedTypes.size})`
          );
        }

        // e) Формируем new File([orig], `${orig.name}.txt`, { type: 'text/plain' }) и вызываем повторный аплоад
        if (origFile && !origFile.name.endsWith('.txt') && !retryingNames.has(`${origFile.name}.txt`)) {
          const fixedFile = createTxtFile(origFile);
          retryingNames.add(fixedFile.name);
          console.info(`${LOG_PREFIX} Auto-healing: dispatching fixed file "${fixedFile.name}" into runtime`);

          queueMicrotask(() => {
            dispatchFixedFiles([fixedFile]);
          });
        } else if (!origFile) {
          console.error(`${LOG_PREFIX} Could not find original File in cache for "${filename}"`);
        }
      }
    }

    return cleanDict;
  }

  function setupStoreHooks(store) {
    if (!store) return;
    activeStore = store;
    window.__aistudioUploadFixerStore = store;

    if (!store.F) {
      console.warn(`${LOG_PREFIX} store instance detected, but store.F not yet set`);
      return;
    }

    const signal = store.F;
    if (signal.__uploadFixerHooked) return;
    signal.__uploadFixerHooked = true;

    const origSet = signal.set;
    if (typeof origSet !== 'function') {
      console.error(`${LOG_PREFIX} store.F.set is not a function:`, origSet);
      return;
    }

    signal.set = function (newDict) {
      try {
        if (newDict && typeof newDict === 'object') {
          newDict = handleStoreSet(store, newDict);
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} Exception in store.F.set hook:`, err);
      }
      return origSet.call(this, newDict);
    };

    console.info(`${LOG_PREFIX} Successfully hooked store.F.set in memory!`);
  }

  function hookLFClass(cls) {
    if (!cls || cls.__uploadFixerLFHooked) return;
    cls.__uploadFixerLFHooked = true;
    console.info(`${LOG_PREFIX} Hooking LF class...`);

    // 1a. Перехват через setter свойства F на прототипе LF
    // В конструкторе LF выполняется: this.F = _.M();
    // При создании экземпляра срабатывает setter прототипа, получая экземпляр this и сигнал
    try {
      Object.defineProperty(cls.prototype, 'F', {
        configurable: true,
        enumerable: true,
        get() {
          return this.__storeSignalF;
        },
        set(signal) {
          this.__storeSignalF = signal;
          Object.defineProperty(this, 'F', {
            value: signal,
            writable: true,
            configurable: true,
            enumerable: true,
          });
          setupStoreHooks(this);
        },
      });
    } catch (e) {
      console.warn(`${LOG_PREFIX} Could not define F on LF.prototype:`, e);
    }

    // 1b. Перехват через DI-фабрику cls.J
    function wrapFactory(origFac) {
      const wrapped = function (a) {
        const inst = origFac.call(this, a);
        if (inst) setupStoreHooks(inst);
        return inst;
      };
      wrapped.__uploadFixerHooked = true;
      return wrapped;
    }

    try {
      let _J = cls.J;
      if (typeof _J === 'function' && !_J.__uploadFixerHooked) {
        cls.J = wrapFactory(_J);
      }
      Object.defineProperty(cls, 'J', {
        configurable: true,
        enumerable: true,
        get() {
          return _J;
        },
        set(fn) {
          _J = typeof fn === 'function' && !fn.__uploadFixerHooked ? wrapFactory(fn) : fn;
        },
      });
    } catch (e) {
      console.warn(`${LOG_PREFIX} Could not hook LF.J:`, e);
    }

    // 1c. Перехват через cls.sa (Angular injectable metadata)
    try {
      let _sa = cls.sa;
      function wrapSa(sa) {
        if (sa && typeof sa.factory === 'function' && !sa.factory.__uploadFixerHooked) {
          sa.factory = wrapFactory(sa.factory);
        }
        return sa;
      }
      if (_sa) wrapSa(_sa);
      Object.defineProperty(cls, 'sa', {
        configurable: true,
        enumerable: true,
        get() {
          return _sa;
        },
        set(val) {
          _sa = wrapSa(val);
        },
      });
    } catch (e) {
      console.warn(`${LOG_PREFIX} Could not hook LF.sa:`, e);
    }
  }

  // =========================================================================
  // 2. ПЕРЕХВАТ КОНТРОЛЛЕРА (oG) И ТОСТОВ (Se) + ВАЛИДАЦИИ ФРОНТЕНДА
  // =========================================================================

  function hookOGClass(cls) {
    if (!cls || !cls.prototype || cls.prototype.__uploadFixerOGHooked) return;
    cls.prototype.__uploadFixerOGHooked = true;
    console.info(`${LOG_PREFIX} Hooking oG class...`);

    // 2a. Подавление тостов об ошибках неподдерживаемых файлов (Точка А)
    const origSe = cls.prototype.Se;
    if (typeof origSe === 'function') {
      cls.prototype.Se = function (msg, level, ...rest) {
        if (level === 'error' && typeof msg === 'string') {
          const lower = msg.toLowerCase();
          if (
            lower.includes("doesn't support") ||
            lower.includes('not all files are supported') ||
            lower.includes('unsupported')
          ) {
            console.warn(`${LOG_PREFIX} Suppressed error toast via oG.prototype.Se: "${msg}"`);
            return;
          }
        }
        return origSe.call(this, msg, level, ...rest);
      };
    }

    // 2b. Перехват dataTransferStarted / Ipb
    function wrapIpb(origIpb) {
      return function (arg) {
        activeController = this;
        window.__aistudioUploadFixerController = this;
        if (this.H) setupStoreHooks(this.H);

        if (!arg || !arg.files || arg.files.length === 0 || arg.__uploadFixerHandled) {
          return origIpb.call(this, arg);
        }

        const files = Array.from(arg.files);
        for (const f of files) cacheFile(f);
        lastBatchFiles = files;

        // Сессионное обучение: если тип уже известен как неподдерживаемый, подменяем на входе
        let hasLearnedUnsupported = false;
        const processedFiles = files.map((f) => {
          const typeKey = getFileTypeKey(f.name);
          if (knownUnsupportedTypes.has(typeKey) && !f.name.endsWith('.txt')) {
            hasLearnedUnsupported = true;
            return createTxtFile(f);
          }
          return f;
        });

        if (hasLearnedUnsupported) {
          console.info(`${LOG_PREFIX} Ipb pre-filtered known unsupported files on input!`);
          arg = Object.assign({}, arg, { files: processedFiles, __uploadFixerHandled: true });
        }

        // Отслеживание файлов, прочитанных FileService в ходе выполнения Ipb
        const acceptedFiles = new Set();
        const fileService = this.Fy;
        let origReadFile = fileService?.readFile;
        if (fileService && typeof origReadFile === 'function') {
          fileService.readFile = function (f) {
            acceptedFiles.add(f);
            return origReadFile.call(fileService, f);
          };
        }

        let result;
        try {
          result = origIpb.call(this, arg);
        } finally {
          if (fileService && origReadFile) {
            fileService.readFile = origReadFile;
          }
        }

        // Если валидатор фронтенда отсек часть файлов, автоматически конвертируем их в .txt
        const inputFiles = Array.from(arg.files);
        const rejectedByFrontend = inputFiles.filter(
          (f) => !acceptedFiles.has(f) && !f.name.endsWith('.txt') && !retryingNames.has(`${f.name}.txt`)
        );

        if (rejectedByFrontend.length > 0) {
          console.warn(
            `${LOG_PREFIX} Frontend validator rejected files:`,
            rejectedByFrontend.map((f) => f.name)
          );
          for (const f of rejectedByFrontend) {
            const typeKey = getFileTypeKey(f.name);
            if (typeKey) knownUnsupportedTypes.add(typeKey);
          }
          const fixed = rejectedByFrontend.map(createTxtFile);
          queueMicrotask(() => {
            dispatchFixedFiles(fixed);
          });
        }

        return result;
      };
    }

    if (typeof cls.prototype.Ipb === 'function') {
      cls.prototype.Ipb = wrapIpb(cls.prototype.Ipb);
    }
    if (typeof cls.prototype.dataTransferStarted === 'function') {
      cls.prototype.dataTransferStarted = wrapIpb(cls.prototype.dataTransferStarted);
    }
  }

  // =========================================================================
  // 3. ПЕРЕХВАТ СЕРВИСА ЧТЕНИЯ ФАЙЛОВ (FileService / YF)
  // =========================================================================

  function hookYFClass(cls) {
    if (!cls || !cls.prototype || cls.prototype.__uploadFixerYFHooked) return;
    cls.prototype.__uploadFixerYFHooked = true;
    console.info(`${LOG_PREFIX} Hooking YF class...`);

    const origReadFile = cls.prototype.readFile;
    if (typeof origReadFile === 'function') {
      cls.prototype.readFile = function (file) {
        if (file && file.name) {
          cacheFile(file);
        }
        return origReadFile.call(this, file).then((res) => {
          if (res && res.url && file) {
            fileByDataUrl.set(res.url, file);
          }
          return res;
        });
      };
    }
  }

  // =========================================================================
  // 4. ПЕРЕХВАТ default_MakerSuite В WINDOW
  // =========================================================================

  function hookMakerSuite(ms) {
    if (!ms || typeof ms !== 'object') return;

    if (ms.LF) hookLFClass(ms.LF);
    else {
      let _LF = undefined;
      Object.defineProperty(ms, 'LF', {
        configurable: true,
        enumerable: true,
        get() {
          return _LF;
        },
        set(cls) {
          _LF = cls;
          hookLFClass(cls);
        },
      });
    }

    if (ms.oG) hookOGClass(ms.oG);
    else {
      let _oG = undefined;
      Object.defineProperty(ms, 'oG', {
        configurable: true,
        enumerable: true,
        get() {
          return _oG;
        },
        set(cls) {
          _oG = cls;
          hookOGClass(cls);
        },
      });
    }

    if (ms.YF) hookYFClass(ms.YF);
    else {
      let _YF = undefined;
      Object.defineProperty(ms, 'YF', {
        configurable: true,
        enumerable: true,
        get() {
          return _YF;
        },
        set(cls) {
          _YF = cls;
          hookYFClass(cls);
        },
      });
    }
  }

  let _ms = window.default_MakerSuite || {};
  hookMakerSuite(_ms);

  try {
    Object.defineProperty(window, 'default_MakerSuite', {
      configurable: true,
      enumerable: true,
      get() {
        return _ms;
      },
      set(newMs) {
        _ms = newMs;
        hookMakerSuite(_ms);
      },
    });
  } catch (e) {
    console.warn(`${LOG_PREFIX} Could not defineProperty on window.default_MakerSuite:`, e);
  }

  // =========================================================================
  // 5. ПЕРЕХВАТ ВХОДНЫХ СОБЫТИЙ DROP / CHANGE (Сессионное обучение)
  // =========================================================================

  function onDrop(e) {
    if (e.__isUploadFixerHandled) return;
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;

    const files = Array.from(e.dataTransfer.files);
    console.info(`${LOG_PREFIX} Drop event detected with files:`, files.map((f) => f.name));

    for (const f of files) {
      cacheFile(f);
    }
    lastBatchFiles = files;

    // Если в батче есть файл ранее изученного неподдерживаемого типа — подменяем на входе
    const hasKnownUnsupported = files.some(
      (f) => knownUnsupportedTypes.has(getFileTypeKey(f.name)) && !f.name.endsWith('.txt')
    );

    if (hasKnownUnsupported) {
      console.info(
        `${LOG_PREFIX} Session-learned type detected on drop! Pre-converting to .txt without duplicate network request.`
      );
      e.stopImmediatePropagation();
      e.preventDefault();

      const transformedFiles = files.map((f) => {
        const typeKey = getFileTypeKey(f.name);
        if (knownUnsupportedTypes.has(typeKey) && !f.name.endsWith('.txt')) {
          return createTxtFile(f);
        }
        return f;
      });

      dispatchFixedFiles(transformedFiles);
    }
  }

  window.addEventListener('drop', onDrop, true);

  function onInputChange(e) {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    if (input.__isUploadFixerHandled) return;
    if (!input.files || input.files.length === 0) return;

    const files = Array.from(input.files);
    console.info(`${LOG_PREFIX} File input change detected with files:`, files.map((f) => f.name));

    for (const f of files) {
      cacheFile(f);
    }
    lastBatchFiles = files;

    const hasKnownUnsupported = files.some(
      (f) => knownUnsupportedTypes.has(getFileTypeKey(f.name)) && !f.name.endsWith('.txt')
    );

    if (hasKnownUnsupported) {
      console.info(`${LOG_PREFIX} Session-learned type detected on input change! Pre-converting to .txt.`);
      e.stopImmediatePropagation();
      e.preventDefault();

      const transformedFiles = files.map((f) => {
        const typeKey = getFileTypeKey(f.name);
        if (knownUnsupportedTypes.has(typeKey) && !f.name.endsWith('.txt')) {
          return createTxtFile(f);
        }
        return f;
      });

      dispatchFixedFiles(transformedFiles);
    }
  }

  window.addEventListener('change', onInputChange, true);

  // Очистка при перезагрузке
  window.__aistudioUploadFixerCleanup = () => {
    window.removeEventListener('drop', onDrop, true);
    window.removeEventListener('change', onInputChange, true);
    console.debug(`${LOG_PREFIX} Observers & event listeners cleaned up.`);
  };

  console.info(`${LOG_PREFIX} v4.0 loaded and listening.`);
})();
