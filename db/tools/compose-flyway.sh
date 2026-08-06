#!/bin/sh
set -eu
LC_ALL=C
export LC_ALL

if [ "$#" -ne 2 ]; then
    echo 'usage: compose-flyway.sh <core|market> <validate|migrate>' >&2
    exit 64
fi

plane=$1
action=$2
case "$plane" in
    core)
        db_host=${CORE_DB_HOST-}
        db_port=${CORE_DB_PORT-}
        db_name=${CORE_DB_NAME-}
        db_user=${CORE_DB_USER-}
        pass_file=/run/secrets/core_db_password
        ca_file=/run/secrets/core_db_ca
        config=/flyway/db/flyway/core.conf
        ;;
    market)
        db_host=${MARKET_DB_HOST-}
        db_port=${MARKET_DB_PORT-}
        db_name=${MARKET_DB_NAME-}
        db_user=${MARKET_DB_USER-}
        pass_file=/run/secrets/market_db_password
        ca_file=/run/secrets/market_db_ca
        config=/flyway/db/flyway/market.conf
        ;;
    *)
        echo 'migration plane must be core or market' >&2
        exit 64
        ;;
esac

case "$action" in validate|migrate) ;; *) echo 'migration action must be validate or migrate' >&2; exit 64 ;; esac
case "$db_host" in ''|*[!A-Za-z0-9.-]*|.*|-*|*.|*-|*..*|*.-*|*-.*) echo "$plane database host is invalid" >&2; exit 64 ;; esac
case "$db_port" in ''|0*|??????*|*[!0-9]*) echo "$plane database port is invalid" >&2; exit 64 ;; esac
case "$db_name" in ''|*[!A-Za-z0-9_-]*) echo "$plane database name is invalid" >&2; exit 64 ;; esac
case "$db_user" in ''|*[!A-Za-z0-9_-]*) echo "$plane database user is invalid" >&2; exit 64 ;; esac
case "${MIGRATION_TIMEOUT_SEC-}" in ''|0*|?????*|*[!0-9]*) echo 'migration timeout is invalid' >&2; exit 64 ;; esac

if [ "${#db_host}" -gt 253 ] || [ "${#db_name}" -gt 63 ] || [ "${#db_user}" -gt 63 ]; then
    echo "$plane database connection field is too long" >&2
    exit 64
fi

if [ "$db_port" -lt 1 ] || [ "$db_port" -gt 65535 ]; then
    echo "$plane database port is outside 1..65535" >&2
    exit 64
fi
if [ "$MIGRATION_TIMEOUT_SEC" -lt 1 ] || [ "$MIGRATION_TIMEOUT_SEC" -gt 3600 ]; then
    echo 'migration timeout is outside 1..3600 seconds' >&2
    exit 64
fi

FLYWAY_URL="jdbc:postgresql://${db_host}:${db_port}/${db_name}?sslmode=verify-full&sslrootcert=${ca_file}"
FLYWAY_USER=$db_user
export FLYWAY_URL FLYWAY_USER

if [ "$plane" = 'core' ]; then
    set -- -configFiles="$config,/flyway/db/flyway/core-production.conf"
else
    set -- -configFiles="$config"
fi

if [ "$action" = 'validate' ]; then
    set -- "$@" '-ignoreMigrationPatterns=*:pending' validate
else
    set -- "$@" migrate
fi

if [ "${COMPOSE_FLYWAY_CHECK-}" = 'true' ]; then
    printf '%s\n' "$FLYWAY_URL" "$@"
    exit 0
fi

if [ ! -s "$pass_file" ]; then
    echo "$plane database password secret is missing or empty" >&2
    exit 66
fi
if [ ! -s "$ca_file" ]; then
    echo "$plane database CA secret is missing or empty" >&2
    exit 66
fi

FLYWAY_PASSWORD=$(cat "$pass_file")
if [ -z "$FLYWAY_PASSWORD" ]; then
    echo "$plane database password secret is empty" >&2
    exit 66
fi
export FLYWAY_PASSWORD
exec timeout --signal=TERM --kill-after=15s "$MIGRATION_TIMEOUT_SEC" /flyway/flyway "$@"
