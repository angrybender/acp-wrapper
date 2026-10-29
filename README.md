# acp-wrapper

Форк **Claude Agent ACP** с явным ожиданием нативных фоновых задач и условным закрытием сессии. Предназначен для ACP-клиентов и оркестраторов, которым важно дождаться не только первого `end_turn`, но и завершения фоновой работы Claude.

Репозиторий содержит **воспроизводимый patch-форк**: installer скачивает закреплённый upstream, проверяет commit, применяет патч и собирает отдельный executable. Исходники upstream, `node_modules` и собранный `dist` в этот репозиторий не копируются.

- Upstream: [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp).
- Базовая версия: **0.96.0**.
- Закреплённый commit: [`f6958db1ee8d3e9ead6767a3a294f98b9a21adb9`](https://github.com/agentclientprotocol/claude-agent-acp/tree/f6958db1ee8d3e9ead6767a3a294f98b9a21adb9).
- Собственное расширение: `orchestratorBackgroundTasks`, версия **1**, поверх **ACP v1**.
- Лицензия: [Apache-2.0](LICENSE), сведения об upstream — [NOTICE](NOTICE).

## Что изменено

Обычный ответ `session/prompt` с `stopReason=end_turn` не гарантирует, что все фоновые команды уже закончились. Кроме того, исчезновение задания из списка SDK не всегда сопровождается немедленным terminal event.

Форк добавляет RPC `_orchestrator/background`. Клиент получает снимок задач и занятости модели, а затем запрашивает закрытие с token этого снимка. Если работа ещё идёт или снимок устарел, адаптер возвращает `closed:false`, **не отправляя interrupt/cancel**. Задача, исчезнувшая из списка SDK, остаётся активной до явного события завершения, ошибки или остановки.

Учитываются задачи, ещё не опубликованные клиенту через spawn, дочерние агенты, автоматические ходы Claude, очередь ходов, SDK running state и обработка событий SDK. Upstream 0.96.0 уже публикует автоматические ходы после `end_turn` как async tasks; патч дополняет этот механизм явным снимком и условным закрытием.

**Важно для подключения:** установка бинарника сама по себе не включает ожидание в произвольном ACP-клиенте. Клиент должен согласовать расширение и вызывать новый RPC. Без согласования адаптер сохраняет обычное поведение upstream. Финальные проверочные prompt, quiet interval, общий timeout и проверку процессов реализует клиент, а не installer. Подробный контракт — [docs/protocol.md](docs/protocol.md).

## 1. Требования

Устанавливайте форк **на той машине и под тем пользователем, где запускается агент**. Если оркестратор подключается по SSH, следующие команды выполняются на удалённом agent host.

Проверенная среда — Linux, Bash и Node.js 22. Нужны:

| Компонент | Требование |
| --- | --- |
| Node.js | 22 или новее |
| npm | Доступен в PATH вместе с Node.js |
| Python | Python 3, только стандартная библиотека для installer |
| Git | Доступен в PATH |
| Сеть | Доступ к GitHub и npm registry при установке; к провайдеру при работе |
| Права | Запись в выбранные `--prefix` и каталог `--bin` |

Проверьте окружение:

```bash
node --version
npm --version
python3 --version
git --version
```

`sudo`, глобальная npm-установка, Python `pip install` и изменение production `venv` для installer не нужны. Автоматическая установка через symlink и пример launcher ниже рассчитаны на Linux/macOS; реальная проверка выполнена на Linux. Windows-инструкция в этой версии не заявляется.

## 2. Установка

```bash
git clone https://github.com/angrybender/acp-wrapper.git
cd acp-wrapper

python3 ./install.py --test \
  --prefix "$HOME/.local/share/claude-acp-background-0.96.0-r1" \
  --bin "$HOME/.local/bin/claude-agent-acp-wait"
```

`--test` выполняет build, lint, format и сфокусированный ACP/async-task набор upstream вместе с регрессиями патча. Это не полный upstream suite и не запрос к платному модельному провайдеру. При необходимости пропустите `--test`: сборка и проверка запуска executable всё равно выполняются.

Installer:

1. Клонирует upstream tag `v0.96.0` во временный каталог рядом с destination.
2. Проверяет, что HEAD совпадает с закреплённым commit.
3. Проверяет и применяет `background-drain.patch`.
4. Устанавливает зависимости через `npm ci --ignore-scripts` и собирает TypeScript.
5. При `--test` запускает проверки.
6. Переносит `dist`, package/lock-файлы, upstream README и LICENSE в staging installation; устанавливает только production dependencies.
7. Делает entry point исполняемым, проверяет `--version`, записывает `FORK.json` и атомарно перемещает installation в `--prefix`.
8. Создаёт symlink `--bin`, если он указан. Временный build-каталог удаляется автоматически.

**Существующие `--prefix` и `--bin` не перезаписываются.** Если путь занят, используйте новый prefix/bin; инструкция обновления приведена ниже. Upstream CLI и пользовательская авторизация не заменяются.

### Параметры installer

| Параметр | Значение |
| --- | --- |
| `--prefix PATH` | Каталог готового runtime. Default: `~/.local/share/claude-acp-background-0.96.0-r1` |
| `--bin PATH` | Необязательный symlink на executable. Без параметра запускайте entry point по полному пути |
| `--test` | Lint/format и ACP/async-task регрессии перед установкой |
| `--help` | Справка |

Не переносите один `install.py` без патча: `background-drain.patch` должен находиться рядом с ним. Проще клонировать репозиторий целиком.

## 3. Проверка установленного форка

```bash
"$HOME/.local/bin/claude-agent-acp-wait" --version
cat "$HOME/.local/share/claude-acp-background-0.96.0-r1/FORK.json"
```

`--version` выводит upstream-версию `0.96.0`. Отличить сборку форка от обычного upstream можно по `FORK.json`: он содержит upstream commit, SHA256 патча, имя контракта и его версию. Во время ACP initialize форк также подтверждает согласованное расширение.

Если хотите запускать команду без абсолютного пути, добавьте в shell profile, например `~/.profile`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Откройте новую shell или выполните `source ~/.profile`. Для SSH-оркестратора надёжнее указать абсолютный путь: PATH неинтерактивной SSH-сессии может отличаться от терминального.

Запуск executable без ACP-клиента ждёт JSON-RPC на stdin. Это нормальное поведение: это ACP-адаптер, а не интерактивный чат. `--version` — проверка установки без модельного запроса.

## 4. Настройка RouterAI

Проверенный маршрут провайдера: `https://routerai.ru/api/v1`, модель — `anthropic/claude-sonnet-4.6`.

Для **Claude SDK** устанавливайте `ANTHROPIC_BASE_URL=https://routerai.ru/api`: SDK сам добавляет `/v1/messages`. Не добавляйте второй `/v1` в эту переменную. Это настройка Anthropic Messages API; OpenAI-compatible endpoint сам по себе не гарантирует совместимость с Claude SDK.

### Вариант A: запуск из текущей shell

Из каталога клонированного репозитория:

```bash
read -r -s -p 'RouterAI API key: ' ANTHROPIC_AUTH_TOKEN
printf '\n'
export ANTHROPIC_AUTH_TOKEN

./examples/claude-routerai.sh
```

Launcher использует отдельный `CLAUDE_CONFIG_DIR`, настраивает URL, модель и ACP v1, очищает `ANTHROPIC_API_KEY`, затем через `exec` запускает установленный форк. Ключ не записывается в launcher. Список переменных — ниже.

Эта команда ждёт ACP-клиента. В реальной интеграции launcher запускается самим клиентом с тем же окружением.

### Вариант B: запуск по SSH / из сервиса

Создайте token-файл **на agent host** под пользователем агента:

```bash
mkdir -p "$HOME/.config/acp-wrapper"
(
  umask 077
  read -r -s -p 'RouterAI API key: ' token_value
  printf '\n'
  printf '%s' "$token_value" > "$HOME/.config/acp-wrapper/routerai.token"
)
```

Создайте собственный launcher с абсолютными путями, например `~/.local/bin/claude-acp-routerai`:

```bash
#!/usr/bin/env bash
set -euo pipefail
export ACP_ROUTERAI_TOKEN_FILE="$HOME/.config/acp-wrapper/routerai.token"
exec "$HOME/src/acp-wrapper/examples/claude-routerai.sh" "$@"
```

В этом примере репозиторий находится в `~/src/acp-wrapper`; замените путь на фактический. Сделайте launcher исполняемым:

```bash
chmod +x "$HOME/.local/bin/claude-acp-routerai"
```

Передавайте ACP-клиенту полный путь к этому launcher. Переменные вашей локальной shell автоматически через SSH не передаются; token-файл и launcher решают это для неинтерактивного запуска.

### Переменные примера launcher

| Переменная | Default / назначение |
| --- | --- |
| `ACP_CLAUDE_BINARY` | `~/.local/bin/claude-agent-acp-wait` |
| `ANTHROPIC_AUTH_TOKEN` | Ключ из окружения; обязателен, если нет token-файла |
| `ACP_ROUTERAI_TOKEN_FILE` | Необязательный файл с ключом; при задании имеет приоритет над ключом окружения |
| `ANTHROPIC_BASE_URL` | `https://routerai.ru/api` |
| `ANTHROPIC_MODEL` | `anthropic/claude-sonnet-4.6` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Значение `ANTHROPIC_MODEL`, если явно не задано |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Значение `ANTHROPIC_MODEL`, если явно не задано |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Значение `ANTHROPIC_MODEL`, если явно не задано |
| `CLAUDE_CONFIG_DIR` | `~/.config/acp-wrapper/routerai` |

Три default-model переменные направляют роли SDK на тот же проверенный маршрут. Можно переопределить их отдельно. Модель должна поддерживать необходимые Claude SDK tools; проверка простого текстового ответа провайдера этого не подтверждает.

Для другого провайдера настройте поддерживаемый им Anthropic Messages URL, ключ и model IDs либо запускайте executable с обычной авторизацией Claude. Провайдер не зашит в патч или installer; RouterAI — конфигурация примера.

## 5. Права на выполнение tools

Права задаются средствами Claude SDK, отдельно от ожидания фоновых задач. Launcher не включает bypass автоматически.

Если ACP-клиент поддерживает `session/request_permission`, используйте обычный режим согласования прав. Если клиент отклоняет этот метод, Claude не сможет автоматически выполнить требующие разрешения Bash/Write tools.

Для заранее разрешённого автономного выполнения можно явно задать в **отдельном** `CLAUDE_CONFIG_DIR/settings.json`:

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
```

В примере RouterAI этот файл расположен в `~/.config/acp-wrapper/routerai/settings.json`. Этот режим разрешает агенту выполнять tools без интерактивного запроса; выбирайте его для рабочего каталога, в котором агенту разрешены такие действия. Если settings-файл уже существует, добавьте поле в его JSON, сохранив остальные настройки. Один лишь аргумент `--yolo` не заменяет эту конфигурацию: предыдущая реальная проверка показывала сохранение mode=default.

## 6. Подключение к оркестратору

На agent host установите executable и launcher, затем в ACP-клиенте / Settings → Agent укажите:

```text
Agent shell: /home/user/.local/bin/claude-acp-routerai
ACP wait background tasks: true
ACP background quiet timeout: 60
Agent timeout: 1800
```

Пути и общий timeout приведены как пример. Для запуска без RouterAI launcher можно указать `/home/user/.local/bin/claude-agent-acp-wait`, если нужные auth/provider переменные уже доступны процессу.

Требуется версия оркестратора, реализующая `orchestratorBackgroundTasks` v1. Старый клиент, который согласовывает только AIR, продолжит использовать свой прежний алгоритм. Конкретные поля Settings относятся к интеграции, с которой проверялся форк; installer не создаёт эти поля и не обновляет внешний оркестратор.

Совместимый клиент должен:

1. В `initialize` предложить расширение вместе с AIR asyncTasks/nativeSubagentSessions/sessionFailure.
2. Проверить подтверждение агента, создать/загрузить сессию и передать обычный `session/prompt`.
3. После `end_turn` продолжать читать события и опрашивать `_orchestrator/background`.
4. Дождаться фоновых задач и автоматических ходов; обработать результаты команд моделью и повторить ожидание, если появилась новая работа.
5. После устойчивого idle запросить conditional close с актуальным token. При `closed:false` продолжить ожидание.
6. После `closed:true` дождаться штатного выхода адаптера и проверить очистку процессов средствами своего runner.

В проверенной интеграции нет дополнительного лимита «три проверочных prompt / 300 секунд» для этого контракта: выполнение ограничивает общий `agent_timeout`. Quiet timeout — период устойчивости, а не доказательство завершения работающей команды. Подробности — [контракт](docs/protocol.md).

## 7. Обновление и откат

Обновление этого репозитория не переключает установленный runtime. Установка всегда привязана к закреплённому upstream commit и текущему патчу.

```bash
cd /path/to/acp-wrapper
git pull --ff-only

new_prefix="$HOME/.local/share/claude-acp-background-$(git rev-parse --short HEAD)"
python3 ./install.py --test \
  --prefix "$new_prefix" \
  --bin "$HOME/.local/bin/claude-agent-acp-wait-next"

"$HOME/.local/bin/claude-agent-acp-wait-next" --version
cat "$new_prefix/FORK.json"
```

После проверки переключите основной symlink на новую установку:

```bash
ln -sfn "$new_prefix/dist/index.js" "$HOME/.local/bin/claude-agent-acp-wait"
```

Сохранённый старый prefix позволяет откатить следующий запуск:

```bash
ln -sfn "$HOME/.local/share/claude-acp-background-0.96.0-r1/dist/index.js" \
  "$HOME/.local/bin/claude-agent-acp-wait"
```

Для повторной установки из того же commit также нужны свободные prefix/bin. Если `claude-agent-acp-wait-next` уже существует, выберите другое имя. Переключение symlink действует на новые запуски; текущую ACP-сессию оно не перезапускает.

Installer сам не заменяет обычную команду `claude-agent-acp`. Если хотите использовать это имя, сначала сохраните текущий target и затем переключите symlink самостоятельно. В проверенной удалённой установке исходный CLI был сохранён под именем `claude-agent-acp-upstream-0.94.0`.

## 8. Проверки и диагностика

[docs/testing.md](docs/testing.md) содержит результаты предыдущих проверок и их границы. Быстрая проверка локальной установки без обращения к провайдеру:

```bash
python3 ./install.py --help
"$HOME/.local/bin/claude-agent-acp-wait" --version
cat "$HOME/.local/share/claude-acp-background-0.96.0-r1/FORK.json"
```

| Симптом | Что проверить |
| --- | --- |
| `Destination or executable already exists` | Installer не перезаписывает установку. Выберите свободные prefix/bin или используйте процедуру обновления |
| `node: not found`, `npm: not found` | Node/npm должны быть доступны пользователю агента, включая неинтерактивную SSH-сессию |
| `Permission denied` | Используйте установленный entry point; installer делает его исполняемым. Собственный launcher тоже требует `chmod +x` |
| `Upstream tag no longer matches...` | Commit tag отличается от закреплённого. Проверка намеренно останавливает установку; не убирайте её для продолжения |
| Обычный upstream вместо форка | Проверьте полный путь, `readlink` symlink и `FORK.json`. Глобальная установка оригинального npm-пакета не применяет этот патч |
| Адаптер после запуска молчит | Он ждёт ACP JSON-RPC на stdin. Для проверки установки используйте `--version` |
| Провайдер возвращает 401/ошибку URL | Проверьте ключ в окружении процесса агента, token-файл и base URL без двойного `/v1` |
| Bash/Write получает отказ permissions | Настройте `session/request_permission` в клиенте или явно выбранный permission mode SDK |
| Нет нового режима ожидания | Проверьте предложение и подтверждение расширения в initialize и вызовы нового RPC; одних AIR capabilities недостаточно |
| `closed:false` | Это штатный отказ закрытия: есть работа или token устарел. Получите новый снимок и продолжайте ожидание |
| Оставленный server/watch удерживает сессию | Модель должна штатно остановить ненужный процесс; необходимую конечную работу следует дождаться |

Секреты не нужны для установки или `--test`; они нужны только для реального обращения к провайдеру. Не добавляйте token-файлы и auth-конфигурацию в репозиторий.

## Границы гарантий

Учёт относится к зарегистрированной нативной работе Claude SDK. Произвольные внешние процессы, Docker daemon, задания за дополнительным SSH и внешние сервисы этим RPC не контролируются. Token защищает от уже наблюдаемой адаптером смены состояния; это не транзакция с провайдером или универсальный process supervisor. Клиенту по-прежнему нужны общий deadline, отмена, чтение потока и подтверждение очистки.

## Состав репозитория

```text
install.py                 воспроизводимая сборка и установка
background-drain.patch     изменения адаптера и upstream-регрессии
examples/claude-routerai.sh launcher с конфигурацией RouterAI
docs/protocol.md           handshake, RPC и поведение клиента
docs/testing.md            результаты и ограничения проверок
LICENSE, NOTICE            лицензия и происхождение исходников
```
