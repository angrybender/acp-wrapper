# Проверки

## Единый launcher с выбором нативного агента — 2026-11-09

Прочитаны AGENTS.md обоих backend, docs/protocol.md, docs/codex.md,
docs/testing.md, README обоих пакетов, installer и исходники CLI/режимов.
Требования выбора и аргументов добавлены в [launcher.md](launcher.md).

- Root build, lint и format прошли; Codex typecheck и bundle прошли.
- Новые проверки launcher/Claude: **29 passed**. Проверены обе version-сигнатуры,
  PATH/переименованный symlink/пробелы, literal argv и повторные flags, CLI
  passthrough и exit code, отсутствие executable, несовместимые ACP-параметры.
- Полный Codex suite: **1532 passed, 36 skipped**. Включены TOML/nested/array/
  quoted-key overrides, приоритет CLI над environment config, режимы approvals,
  yolo и объединение native writable roots с ACP roots. Смежный предварительный
  прогон клиента/новых CLI-тестов дал 135 passed.
- Полный Claude suite после переносимой проверки Node: **3351 passed,
  33 skipped, 1 failed**. Осталось ранее описанное upstream-падение
  tools.test.ts «picks up a rewrite that restored the modification time of the
  file». Оно повторилось и отдельно (249 passed, 1 failed совместно с новыми
  launcher-тестами). Исходники кеша и этот тест не менялись. Полный набор не
  объявляется зелёным. Второй известный тест normalize исправлен: отличающийся
  Node path выбирается с учётом фактического process.execPath, а не всегда
  /usr/bin/node; нормализатор не изменён.
- Настоящий `install.py --test` установил оба runtime в prefix/bin с пробелами.
  В staging прошли **819 Claude/launcher tests, 10 skipped** и **71 Codex
  focused tests**. Проверены обе provenance-записи, production dependencies,
  отсутствие dist/tests, сохранение wrapper --version и native --version,
  legacy --cli и отказ перезаписывать установленный prefix без изменения файлов.
- `scripts/launcher-smoke.mjs` прошёл и из checkout, и через установленный
  entry: реальные native Codex/Claude, ACP v1 initialize и background contract,
  новая Codex-сессия с `--yolo` и mode=agent-full-access, штатный выход.
  Использованы отдельные временные auth/config/cwd и локальный недоступный
  endpoint; ни одного model prompt или запроса к платному провайдеру нет.
- background-drain.patch пересобран относительно записанного upstream,
  обновлён SHA256 в UPSTREAM.json; reverse --check прошёл.

Рабочие настройки, существующие runtime на VM, авторизация и сессии не менялись.
Проверки выполнялись на Linux/Node 22; Windows и model-backed выполнение здесь
не заявляются. Python-installer запускался из обновлённого отдельного dev-venv.
Временные staging/installation/auth/cwd/credential helpers и собственные процессы
удалены после проверок; токен GitHub не записан в репозиторий или remote URL.

## Что выполняет `install.py --test`

Installer копирует исходники текущего checkout в изолированный staging и запускает:

```bash
npm run build
npm run check
npm run test:run -- src/tests/async-tasks.test.ts src/tests/acp-agent.test.ts
```

В финальном installation выполняется также executable `--version`. Это позволяет проверить зависимости, права entry point и наличие Node в PATH без модельного запроса. Ключ провайдера для этих проверок не нужен.

Это сфокусированный набор ACP/async-task тестов, а не весь upstream suite.

## Результаты реализации, 2026-10-29

Проверки исходного патча локально и на Linux agent host:

- Build, lint и format прошли.
- ACP/async-task suite: **790 passed, 10 skipped**.
- Новые регрессии в патче проверяют сохранение live-задачи после исчезновения из SDK списка, отказ conditional close при busy state/устаревшем token без interrupt, успешное закрытие устойчивой сессии и отказ RPC без согласования.

Полный upstream suite локально: **3321 passed, 33 skipped, 2 failed**. Оба падения воспроизведены на исходном закреплённом upstream без патча:

1. `acp-scenarios.test.ts`: normalize-тест предполагает, что путь текущего Node отличается от `/usr/bin/node`.
2. `tools.test.ts`: skill-path проверка не замечает rewrite после восстановления mtime в проверенной файловой среде.

Эти тесты не исправлялись данным форком; полный suite не заявляется зелёным.

## Реальные проверки с RouterAI

Ниже — результаты интеграции с отдельным оркестратором, использующим этот контракт, а не автономного installer. Прогоны выполнены через SSH/ACP с `anthropic/claude-sonnet-4.6`, endpoint провайдера `https://routerai.ru/api/v1`; для Claude SDK использован base URL `https://routerai.ru/api`.

| Сценарий                                                                | Результат                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| Native background `sleep 45`, ранний `end_turn`, чтение result-файла    | Успешно: 109,68 с с quiet=3                                  |
| Тот же finite job с production quiet=60                                 | Успешно: 156,10 с, файл независимо проверен                  |
| Второе background-задание запущено в автоматическом ходе после первого  | Успешно: 79,20 с, оба файла независимо проверены             |
| Ожидаемый exit 7 + disposable `sleep 180`, остановленный через TaskStop | Два успешных прогона установленной сборки: 62,78 с и 47,39 с |
| Foreground Bash/Read через установленный executable, без фоновых задач  | Успешно: 23,51 с                                             |

Успех включал итоговую проверку моделью, штатный выход ACP и подтверждение отсутствия живых процессов исходной группы без сигналов.

Один ранний диагностический прогон failed+server завершил ACP, но внешняя проверка PGID не подтвердила остановку. Клиент отказался считать его успехом. Причина первой неподтверждённой проверки не установлена; последующие проверки не обнаружили оставшихся процессов. В оркестраторе реализован один повтор через новый read-only SSH-канал; два отказа сохраняют ошибку и неопределённость. Этот повтор относится к runner оркестратора и не реализован внутри данного installer или RPC.

## Проверки внешнего оркестратора

При реализации интеграции также прошли:

- Полный Python-набор: **585 passed, 1 skipped** (Windows-only).
- Сфокусированные fork/AIR/Qwen/cancel сценарии: **83 passed**.
- Playwright: настройки Agent, Save/reload, boolean/integer validation и отсутствие overflow на 1357/375/320px.

Эти Python/Playwright тесты принадлежат приложению-оркестратору и **не включены в этот отдельный репозиторий**. Они проверяют использование контракта, в том числе >3 поколений работы, прежний drain budget, отмену, общий deadline, неправильные snapshot, позднюю работу и неопределённую очистку.

Тестовые auth-каталоги, token-файлы, временные проекты, output caches и сырые логи удалены. Ключи провайдера не нужны для воспроизведения installer/Node-проверок и не входят в репозиторий.

## Проверка подготовленного репозитория перед публикацией

Из корня этого репозитория повторно выполнен `python3 ./install.py --test` с отдельными временными prefix/bin. Сборка, lint/format и **790 тестов** прошли; **10** пропущены. Установленный symlink запускается и выводит `0.96.0`. Проверен запуск installer по относительному пути.

Пример RouterAI launcher проверен без реального ключа и без модельного запроса: Bash syntax, ключ из окружения, приоритет token-файла, аргументы/пути с пробелами, отсутствие ключа и отсутствующий token-файл. Временные installation и mock-файлы удаляются после проверки.

## Полная кодовая база

В репозитории сохранён полный source snapshot upstream 0.96.0 с уже применённым
патчем. `npm ci`, `npm run build` и тесты запускаются из корня форка без
скачивания отдельного upstream checkout. `install.py` также использует локальный
source export; provenance включает commit форка и dirty state.

Upstream workflow definitions сохранены как справочные в
`docs/upstream-workflows/`, автоматическая release-публикация не активирована.
Это изменение упаковки не меняет ACP-контракт или алгоритм ожидания.

### Проверка полного source-форка

При преобразовании репозитория в полный source-форк выполнен отдельный аудит
закреплённого upstream tree: все **320 файлов** присутствуют. Исходные README и
workflow definitions сохранены в указанных в `UPSTREAM.json` местах. Изменения
в `src/` ограничены четырьмя файлами исходного патча; `git apply --reverse
--check background-drain.patch` подтверждает его соответствие кодовой базе.

Из корня полного checkout прошли `npm ci`, build, lint и format. Повторный полный
suite дал **3321 passed, 33 skipped, 2 failed** — те же два ранее воспроизведённых
на upstream падения, перечисленные выше; новых падений не обнаружено.

Новый installer собрал локальный source export с `--test`, без clone/apply
upstream: **790 passed, 10 skipped**. Prefix и bin содержали пробелы. Проверены
запуск executable, upstream/patch/fork provenance и byte equality основных
compiled JS между прямой сборкой и установленным runtime.
