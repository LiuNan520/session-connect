#!/bin/sh
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 12
NODE_PATH=''
if [ -f "$PROJECT_ROOT/.app-config" ]; then
  while IFS= read -r config_line || [ -n "$config_line" ]; do
    case "$config_line" in NODE=*) NODE_PATH=${config_line#NODE=} ;; esac
  done < "$PROJECT_ROOT/.app-config"
fi
case "$NODE_PATH" in /*) ;; *) exit 10 ;; esac
[ -x "$NODE_PATH" ] || exit 10
[ -f "$PROJECT_ROOT/dist/server/index.js" ] && [ -f "$PROJECT_ROOT/dist/web/index.html" ] || exit 11

DATA_DIRECTORY=${SESSION_CONNECT_HOME:-"$HOME/.session-connect"}
LOG_DIRECTORY="$DATA_DIRECTORY/logs"
if ! mkdir -p "$LOG_DIRECTORY"; then
  printf '无法创建日志目录：%s\n' "$LOG_DIRECTORY"
  exit 12
fi
HANDSHAKE=$(/usr/bin/mktemp -t session-connect) || exit 12
trap 'rm -f "$HANDSHAKE"' EXIT
cd "$PROJECT_ROOT" || exit 12
nohup "$NODE_PATH" "$PROJECT_ROOT/dist/server/index.js" --mode app --handshake "$HANDSHAKE" </dev/null >>"$LOG_DIRECTORY/server.log" 2>&1 &
LAUNCHED_PID=$!
attempt=0
while [ "$attempt" -lt 100 ]; do
  if [ -s "$HANDSHAKE" ]; then
    IFS=' ' read -r kind address server_pid < "$HANDSHAKE"
    case "$kind" in
      READY) printf '%s\t%s\n' "$address" "$server_pid"; exit 0 ;;
      RUNNING) printf '%s\n' "$address"; exit 3 ;;
      ERROR) reason=$(cat "$HANDSHAKE"); printf '%s。日志在 %s\n' "${reason#ERROR }" "$LOG_DIRECTORY"; exit 12 ;;
      *) printf '无法识别启动握手。日志在 %s\n' "$LOG_DIRECTORY"; exit 12 ;;
    esac
  fi
  if ! kill -0 "$LAUNCHED_PID" 2>/dev/null; then
    printf '服务在就绪前退出。日志在 %s\n' "$LOG_DIRECTORY"
    exit 12
  fi
  sleep 0.05
  attempt=$((attempt + 1))
done
kill "$LAUNCHED_PID" 2>/dev/null || true
printf '等待服务启动超过 5 秒。日志在 %s\n' "$LOG_DIRECTORY"
exit 12
