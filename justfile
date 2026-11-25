set shell := ["bash", "-euo", "pipefail", "-c"]

# 可由消费方通过 --set deploy_root 指定，默认使用本仓的部署目录。
deploy_root := absolute_path(env_var_or_default("DEPLOY_ROOT", justfile_directory() / ".deploy"))
export DEPLOY_ROOT := deploy_root

default:
    @just --list

test:
    npm test

[positional-arguments]
test-data contract catalog:
    IC_GENERATION_CONTRACT="$1" IC_SOURCE_CATALOG="$2" npm run test:data

[positional-arguments]
list *args:
    node tools/exam.mjs list "$@"

[positional-arguments]
run-tester port *args:
    node tools/run-tester.mjs "$1" --deploy-root "$DEPLOY_ROOT" "${@:2}"

[positional-arguments]
new-session port *args:
    TESTER_STATE_DIR="${TESTER_STATE_DIR:-$DEPLOY_ROOT/$1/tester}" node tools/exam.mjs new-session "${@:2}"

[positional-arguments]
ask port *args:
    TESTER_STATE_DIR="${TESTER_STATE_DIR:-$DEPLOY_ROOT/$1/tester}" node tools/exam.mjs ask "${@:2}"

[positional-arguments]
submit port *args:
    TESTER_STATE_DIR="${TESTER_STATE_DIR:-$DEPLOY_ROOT/$1/tester}" node tools/exam.mjs submit "${@:2}"

[positional-arguments]
wait port *args:
    TESTER_STATE_DIR="${TESTER_STATE_DIR:-$DEPLOY_ROOT/$1/tester}" node tools/exam.mjs wait "${@:2}"

# 完整测评数据，固定日期题需选择覆盖题面的 anchor。
[positional-arguments]
generate output contract catalog *args:
    node data/ic/generate.mjs --output "$1" --contract "$2" --catalog "$3" --resources 150 --tenants 30 --days 93 --interval-minutes 60 --exam-profile "${@:4}"

[positional-arguments]
check-data database anchor:
    node data/ic/coverage.mjs "$1" "$PWD/questions" "$2"
