# Руководство агента-разработчика: AI Studio Upload Fixer (v4.0+)

> **Назначение файла:** Этот документ передает весь накопленный опыт, внутреннюю архитектуру Google AI Studio (MakerSuite), грабли протокола WebDriver BiDi и проверенную методику работы. Следующий агент обязан прочитать этот файл ПЕРЕД началом любых правок, чтобы не изобретать велосипед, не ломать рантайм и не возвращаться к устаревшим подходам.

---

## 1. Главные заповеди и категорические запреты

1. **100% In-Memory перехват в рантайме JavaScript:**
   - Код расширения выполняется в контексте `MAIN` world (`page-world.js`).
   - **СТРОГО ЗАПРЕЩЕНО:** использовать `MutationObserver` для обработки чипов или тостов.
   - **СТРОГО ЗАПРЕЩЕНО:** использовать автокликеры по DOM-элементам (`button.click()`, поиск крестиков закрытия чипов).
   - **СТРОГО ЗАПРЕЩЕНО:** встраивать таймеры (`setInterval`, `setTimeout` полинг). Все операции выполняются реактивно по событиям рантайма и в `queueMicrotask`.
2. **Никакого CUA и синтетических моков:**
   - **СТРОГО ЗАПРЕЩЕНО:** использовать инструмент `computer_use` (клик мышью по экрану, системные скриншоты ОС, эмуляция хост-клавиатуры).
   - **СТРОГО ЗАПРЕЩЕНО:** писать синтетические моки в Node.js / Jest / Docker. Проверка проводится **исключительно в живом браузере Firefox пользователя** через протокол WebDriver BiDi.
3. **Честность и объективная верификация:**
   - Результат подтверждается логами консоли браузера и нативным скриншотом вкладки (`browsingContext.captureScreenshot`), а не текстовыми заверениями.

---

## 2. Контур окружения и протокольные правила (WebDriver BiDi)

Firefox запущен пользователем с флагом `--remote-debugging-port 9222`.
Управление и тесты выполняются через Python (`websockets` 15.0.1) на `ws://127.0.0.1:9222/session`.

### Критический капкан №1: WebDriver BiDi Session Lock
- В Firefox BiDi одновременно может существовать **ровно одна активная сессия**.
- Если Python-скрипт вызвал `session.new` и завершился аварийно без вызова `session.end`, Firefox намертво блокирует порт ошибкой:
  `"Maximum number of active sessions"`
- **ПРАВИЛО:** ЛЮБОЙ скрипт на Python **ОБЯЗАН** обрамлять сессию в `try ... finally: await call("session.end", {})`.

### Критический капкан №2: Деплой без кликов по UI
- Страницы `about:debugging` и `about:addons` блокируют вызов `script.evaluate` ошибкой:
  `"System access is required. Start Firefox with -remote-allow-system-access"`
- **ПРАВИЛО:** Перезагружать расширение нужно нативным методом BiDi:
  ```python
  await call("webExtension.install", {
      "extensionData": {
          "type": "path",
          "path": r"C:\Users\user\data\0x\aistudio-upload-fixer"
      }
  })
  ```
  Это обновляет распакованное расширение за миллисекунды.

### Критический капкан №3: Экранирование строк в script.evaluate
- При вызове `script.evaluate` через Python-скрипты, сырые переносы строк `\n` внутри строковых литералов JavaScript приводят к:
  `SyntaxError: '' string literal contains an unescaped line break`
- **ПРАВИЛО:** Храните тестовые сценарии в файле `test_live.py` или экранируйте переносы как `\\n` / используйте `['line1', 'line2'].join('\n')`.

---

## 3. Реверс-инжиниринг Google AI Studio (MakerSuite Bundle)

Бандл приложения загружается по URL вида `https://www.gstatic.com/_/mss/boq-makersuite/_/js/k=boq-makersuite.MakerSuite...m=_b`.
При старте бандл инициализирует объект в глобальной области видимости:
`window.default_MakerSuite = this.default_MakerSuite || {};`

### А. Хранилище файлов (`PromptFileStore` / `default_MakerSuite.LF`)
- **Класс стора:** `default_MakerSuite.LF`.
- **Состояние чипов:** хранится в Angular `WritableSignal`:
  `this.F = _.M();`
  Значение сигнала `store.F()` — словарь чанков `{ [chunkId]: chunkData }`.
- **Структура чанка `chunkData`:**
  ```javascript
  {
    Ec: "UUID-чанка",             // chunkId
    status: "PREPARING" | "READY" | "ERROR",
    Wd: "FILE" | "IMAGE",
    ub: {
      id: "drive-id",
      name: "Dockerfile",         // ИМЯ ФАЙЛА ХРАНИТСЯ ЗДЕСЬ!
      mimeType: "text/plain"
    },
    Ce: "data:application/octet-stream;base64,...", // dataURL из FileReader
    errorMessage: "Unsupported file",               // появляется при сбое токенизатора
    tokenCount: 26,                                 // число токенов при успехе
    Gb: 1 | 2                                      // 1 = READY, 2 = ERROR
  }
  ```
- **Синхронное удаление чанка:**
  Метод `store.ix(chunkId)`:
  ```javascript
  ix(a) {
    var b = this.F();
    b && (b = Object.assign({}, b), delete b[a], this.F.set(b));
  }
  ```
  Вызов `store.ix(chunkId)` синхронно удаляет чанк из сигнала, и Angular сам штатно удаляет чип из DOM без каких-либо кликов!

- **Точки перехвата стора:**
  1. `LF.prototype` — setter свойства `F`. Срабатывает синхронно прямо внутри `constructor()` при выполнении `this.F = _.M()`.
  2. DI-фабрики: `LF.J` и `LF.sa.factory` (`function(a) { return new (a || _.LF); }`).
  3. Контроллер `oG`: поле `this.H` всегда хранит ссылку на активный стор.

### Б. Перехват сигнала `store.F.set` (Точка отказа бэкенда)
Когда файл вроде `Dockerfile`, `.zig`, `.env` проходит первичную валидацию фронтенда, он отправляется на RPC `CountTokens`. Бэкенд возвращает ошибку, и вызывается функция `_.JF`:
`_.JF(store, chunkId, { Gb: 2, status: "ERROR", errorMessage: "Unsupported file" })`
которая вызывает:
`store.F.set(Object.assign({}, d, { [chunkId]: { ...chunk, status: "ERROR", errorMessage: "Unsupported file" } }))`

**Алгоритм перехвата в `page-world.js`:**
1. Захукать `signal.set`:
   ```javascript
   const origSet = signal.set;
   signal.set = function(newDict) {
       newDict = handleStoreSet(store, newDict);
       return origSet.call(this, newDict);
   };
   ```
2. В `handleStoreSet`:
   - Если в `newDict` обнаружен чанк со `status === "ERROR"` и `errorMessage.includes("Unsupported")`:
     a) `delete cleanDict[chunkId];` — **не пускаем ошибку в сигнал**, благодаря чему красный чип вообще не рендерится в DOM;
     b) Получаем имя файла из `chunk.ub?.name || chunk.ie?.name || chunk.name`;
     c) В `queueMicrotask` вызываем `store.ix(chunkId)` для синхронизации стейта;
     d) Добавляем тип в `knownUnsupportedTypes.add(typeKey)` (сессионное обучение);
     e) Достаем исходный объект `File` из кэша памяти, создаем `new File([orig], `${orig.name}.txt`, { type: 'text/plain' })`;
     f) Диспатчим исправленный файл в рантайм.

### В. Контроллер чата (`default_MakerSuite.oG`) и Тосты (`Se`)
- **Класс контроллера:** `default_MakerSuite.oG`.
- **Метод загрузки файлов:** `oG.prototype.dataTransferStarted = oG.prototype.Ipb`.
- **Точка отказа А (Фронтенд):**
  Метод валидации `_.TBb(fileService, file, ...)` проверяет расширение и MIME-тип. Если файл отклонен, контроллер вызывает:
  `this.Se("The current model doesn't support files of this type.", "error")`
- **Перехват:**
  1. Хукаем `oG.prototype.Se`: подавляем тосты об ошибках неподдерживаемых файлов.
  2. Хукаем `oG.prototype.Ipb`: отслеживаем вызовы `FileService.readFile`. Любой файл из батча, для которого не был вызван `readFile`, отсечен фронтендом. Автоматически преобразуем его в `.txt` и отправляем.

### Г. Чтение файлов (`default_MakerSuite.YF`)
- **Класс сервиса:** `default_MakerSuite.YF`.
- **Метод:** `readFile(file)`.
- Хукаем `readFile`, чтобы автоматически кэшировать каждый исходный объект `File` по его `name` и по `dataUrl` (`result` из `FileReader`).

---

## 4. Сессионное обучение (Zero-Hardcode Cache)

### Принцип работы:
1. Расширение **не содержит захардкоженных списков** запрещенных расширений.
2. Файлы изначально всегда отдаются сервису как есть. Если Gemini нативно понимает файл (например, `README.md` или `test.js`), он загружается с оригинальным расширением.
3. Если файл данного формата (`Dockerfile`, `.zig`) однажды отклонен бэкендом или фронтендом, его тип заносится в сессионный реестр `knownUnsupportedTypes`.
4. Функция определения типа `getFileTypeKey(filename)`:
   - Файлы с расширением (`main.zig`, `test.py`) -> `.zig`, `.py`.
   - Файлы без расширения или dotfiles (`Dockerfile`, `.env`, `Makefile`) -> `dockerfile`, `.env`.
5. При всех последующих сбросах файлов (в событиях `drop`, `change` на `<input type="file">` и в `Ipb`):
   - Если тип файла содержится в `knownUnsupportedTypes`, подмена на `${name}.txt` выполняется **на входе** (до передачи в движок Google).
   - Это полностью исключает двойной сетевой аплоад и повторные ошибки токенизатора!

---

## 5. Структура репозитория

```
C:\Users\user\data\0x\aistudio-upload-fixer\
├── manifest.json         # Manifest V3 (MAIN world script at document_start)
├── page-world.js         # Основное ядро перехвата v4.0 (100% in-memory)
├── content.js            # Скрипт isolated world (логирование активности)
├── test_live.py          # Автотест полного цикла через WebDriver BiDi
├── live_test_result.png  # Нативный скриншот успешного теста (4 чипа с токенами)
├── README.md             # Пользовательская документация проекта
└── AGENT.md              # Данный файл (инструкция для агентов)
```

---

## 6. Протокол работы над задачей (Playbook для следующего агента)

Когда пользователь просит: *"пофикси X"*, *"добавь Y"*, *"поддержи новый формат Z"*:

1. **Не начинай с нуля и не ломай `store.F.set`:**
   - Открой `page-world.js`.
   - Вся логика перехвата сигналов, прототипов и кэшей уже настроена и отлажена.
2. **Вноси правки точечно:**
   - Если меняется поведение фильтрации — правь `handleStoreSet` или `wrapIpb`.
   - Если добавляются метаданные — обогащай `createTxtFile`.
3. **Запусти живой тест в Firefox:**
   ```bash
   python test_live.py
   ```
   Скрипт сам:
   - Подключится к `ws://127.0.0.1:9222/session`;
   - Вызовет `webExtension.install`;
   - Перезагрузит вкладку `new_chat`;
   - Сбросит тестовые файлы (`README.md`, `test.js`, `Dockerfile`);
   - Проверит сессионное обучение со вторым файлом;
   - Проверит DOM-чипы на наличие токенов и отсутствие ошибок;
   - Сохранит скриншот `live_test_result.png`;
   - Корректно завершит сессию `session.end`.
4. **Проверь скриншот и консоль:**
   - Чипы должны иметь статус вида: `docs README.md 20 tokens format_align_leftclose`.
   - В логах не должно быть необработанных исключений.
5. **Закоммить изменения и обнови документацию:**
   ```bash
   git add -A
   git commit -m "feat/fix: краткое описание изменений"
   ```
