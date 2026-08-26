# AI Studio Upload Fixer

Браузерное расширение (Manifest V3), которое автоматически переименовывает файлы с "заблокированными" расширениями (`.py`, `.js`, `Dockerfile` и др.) в `.txt` перед загрузкой в [Google AI Studio](https://aistudio.google.com), чтобы обойти ошибку `Unsupported file`.

## Проблема

AI Studio разрешает загружать не все типы файлов — исходники на Python, JavaScript, конфиги, `Dockerfile` и т. п. отклоняются как "Unsupported file type". Расширение прозрачно переименовывает такие файлы в `.txt` прямо в браузере перед отправкой, не трогая файлы на диске.

## Как это работает

Расширение перехватывает загрузку файлов тремя способами:

- **`content.js`** (isolated world) — слушает событие `change` на `<input type="file">` и подменяет `FileList` на новый со переименованными файлами.
- **`page-world.js`** (main world) — перехватывает:
  - drag & drop (`drop` событие) с пересборкой `DataTransfer`;
  - `window.showOpenFilePicker` (File System Access API в Chromium) через `Proxy` над `FileSystemFileHandle`.

Если у файла "заблокированное" расширение или спец-имя (`Dockerfile`, `Makefile` и т. д.), создаётся копия файла с тем же содержимым, но с именем `<исходное_имя>.txt` и MIME-типом `text/plain`. Файлы, которые и так поддерживаются, не трогаются.

### Список блокируемых расширений

`js, jsx, mjs, cjs, ts, tsx, py, pyw, bin, dat, sh, bash, zsh, yml, yaml, toml, ini, cfg, conf, rs, go, java, kt, c, h, cpp, hpp, cc, cs, rb, php, sql, lock, env, gradle, lua, swift, r, dart`

а также файлы без расширения: `Dockerfile, Makefile, Procfile, Gemfile, Containerfile, Jenkinsfile`.

## Установка

### Chrome / Chromium (Edge, Brave и т. д.)

1. Откройте `chrome://extensions`.
2. Включите «Режим разработчика» (Developer mode).
3. Нажмите «Загрузить распакованное расширение» (Load unpacked) и выберите папку проекта.

### Firefox

1. Откройте `about:debugging#/runtime/this-firefox`.
2. Нажмите «Load Temporary Add-on» и выберите файл `manifest.json`.

## Файлы проекта

| Файл | Назначение |
|---|---|
| `manifest.json` | Манифест расширения (MV3), список content-скриптов |
| `content.js` | Перехват `<input type="file">` в изолированном контексте |
| `page-world.js` | Перехват drag & drop и File System Access API в контексте страницы |

## Лицензия

Не указана.
