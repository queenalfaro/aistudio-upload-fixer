# AI Studio Upload Fixer (v4.0 Native In-Memory Interception)

Браузерное расширение (Manifest V3 под Firefox), реализующее **100% нативный перехват в памяти рантайма JavaScript** для [Google AI Studio](https://aistudio.google.com).

Версия v4.0 полностью устраняет необходимость в DOM-наблюдателях (`MutationObserver`), кликах по кнопкам закрытия (`button.click()`) и предотвращает повторные сетевые загрузки за счет сессионного обучения.

---

## Ключевые возможности v4.0

1. **100% In-Memory перехват (Zero-DOM-Observer):**
   Ошибки валидации и бэкенд-токенизатора перехватываются прямо в структурах данных Angular/MakerSuite до того, как они попадут в дерево DOM. Пользователь вообще не видит красных бейджей с ошибками или мерцания интерфейса.

2. **Перехват Angular WritableSignal (`store.F.set`):**
   При инициализации фабрики стора `default_MakerSuite.LF` перехватывается экземпляр хранилища файлов (`PromptFileStore`). Метод `.set` у сигнала `store.F` перехватывает попытку записать статус `status === "ERROR"` с `errorMessage: "Unsupported file"`:
   - Ошибка синхронно удаляется из словаря и не передается в сигнал (красный чип не рендерится);
   - Вызывается нативный метод стора `store.ix(chunkId)` для синхронной очистки стейта без кликов по DOM;
   - Исходный файл извлекается из кэша памяти, трансформируется в `${name}.txt` (`text/plain`) и отправляется на повторную загрузку.

3. **Сессионное обучение (Zero-Hardcode Cache):**
   - Файлы сначала всегда поступают в сервис как есть (никаких статически захардкоженных черных списков).
   - Если файл определенного формата (`Dockerfile`, `.zig`, `.env`) однажды отклонен бэкендом, расширение запоминает данный тип в сессионном реестре `knownUnsupportedTypes`.
   - При всех последующих загрузках файлов этого типа в текущей сессии подмена на `.txt` выполняется на входе (в событиях `drop`/`change` и контроллере `Ipb`), полностью устраняя двойную сетевую загрузку!

4. **Перехват контроллера и тостов (`oG.prototype.Se`, `Ipb`):**
   Всплывающие тосты (*"The current model doesn't support..."*) подавляются на уровне прототипа контроллера `oG.prototype.Se`, а отсеянные фронтенд-валидатором `_.TBb` файлы мгновенно оборачиваются в `.txt`.

5. **Zero-UI-Loop & Zero-CUA:**
   Никаких `setInterval`, фоновых таймеров или синтетических кликов по координатам.

---

## Архитектура перехвата (MakerSuite Bundle)

```
[ User Drop / File Select ]
           │
           ▼
   [ onDrop / onInputChange ] ────► Известный тип? ──► YES ──► Мгновенная подмена на .txt (Zero-Double-Upload)
           │                                 │
           │ (as-is)                         └──► NO ──► Передача как есть
           ▼
[ oG.prototype.Ipb / dataTransferStarted ]
           │
           ├──► Frontend Validator (TBb) ──► Rejection? ──► Подавление Se() + Auto-Heal в .txt
           ▼
[ FileService (YF.prototype.readFile) ] ──► Кэширование File в памяти (по имени и dataUrl)
           │
           ▼
[ Backend Tokenizer RPC (CountTokens) ]
           │
           ├──► Success (READY) ──► Токены подсчитаны штатными средствами
           │
           └──► Error ("Unsupported file")
                       │
                       ▼
           [ store.F.set Interceptor ]
                       ├── 1. Удаление chunkId из словаря до вызова origSet (DOM не видит ошибку)
                       ├── 2. store.ix(chunkId) очистка стейта
                       ├── 3. knownUnsupportedTypes.add(typeKey) (обучение сессии)
                       └── 4. dispatchFixedFiles([new File([orig], `${name}.txt`)])
```

---

## Файлы проекта

| Файл | Описание |
|---|---|
| `manifest.json` | Манифест MV3 для Firefox (`gecko.id: aistudio-upload-fixer@local.test`), инжекция `page-world.js` в контекст `MAIN` world при `document_start` |
| `page-world.js` | Нативная реализация v4.0: перехват фабрик `LF.J` и прототипа `LF.prototype.F`, хук сигнала `store.F.set`, сессионный кэш `knownUnsupportedTypes`, перехват `oG.prototype.Ipb` и `Se` |
| `content.js` | Скрипт изолированного контекста (`ISOLATED` world) |
| `test_live.py` | Автоматизированный сквозной тест через WebDriver BiDi (`ws://127.0.0.1:9222/session`): хот-деплой, навигация, тестирование `README.md`, `test.js`, `Dockerfile` и верификация сессионного обучения |
| `live_test_result.png` | Нативный скриншот вкладки AI Studio, подтверждающий успешный подсчет токенов без ошибок |

---

## Верификация в живом браузере

Тестирование выполняется в запущенном Firefox (`--remote-debugging-port 9222`) без использования синтетических моков:

```bash
python test_live.py
```

Результаты верификации:
- `README.md` — нативно принят (20 токенов);
- `test.js` — нативно принят (20 токенов);
- `Dockerfile` (первая отправка) — перехвачен в памяти `store.F.set`, стейт очищен через `store.ix`, тип изучен, переотправлен как `Dockerfile.txt` (26 токенов);
- `Dockerfile` (вторая отправка в сессии) — подменен на входе на `Dockerfile.txt` без ошибки бэкенда (30 токенов);
- В DOM отсутствуют классы `.token-status-error`, отсутствуют всплывающие тосты и красные чипы.
