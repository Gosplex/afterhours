#!/usr/bin/env bash
# AfterHours startup script
#
#   ./start.sh                  Local demo: anvil + deploy + web app (no wallet setup needed)
#   ./start.sh robinhood        Deploy to Robinhood Chain testnet, then serve the web app
#   ./start.sh arbitrum-sepolia Deploy to Arbitrum Sepolia, then serve the web app
#   ./start.sh serve            Serve the web app against the last deployment
#   ./start.sh test             Run the contract test suite
#   ./start.sh fund <address>   Send 0.01 testnet ETH from your deployer key to a demo wallet
#
# Testnet deploys read PRIVATE_KEY from the environment or from a .env file in this folder.
# Optional: PORT (web app port, default 5173), GRACE_SECONDS (default 15), VERIFY=1, SKIP_TESTS=1

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS="$ROOT/contracts"
FRONTEND="$ROOT/frontend"
PORT="${PORT:-5173}"
MODE="${1:-local}"
ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
info() { printf "  \033[36m›\033[0m %s\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { printf "  \033[31m✗\033[0m %s\n" "$*" >&2; exit 1; }

[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a

# ----------------------------------------------------------------------------- prerequisites

ensure_foundry() {
  if ! command -v forge >/dev/null 2>&1; then
    export PATH="$HOME/.foundry/bin:$PATH"
  fi
  if ! command -v forge >/dev/null 2>&1; then
    info "Foundry not found. Installing it (one time)…"
    curl -L https://foundry.paradigm.xyz | bash
    export PATH="$HOME/.foundry/bin:$PATH"
    foundryup
  fi
  ok "Foundry $(forge --version | head -1 | awk '{print $3}')"
}

ensure_libs() {
  cd "$CONTRACTS"
  if [ ! -d lib/forge-std/src ]; then
    info "Installing forge-std…"
    forge install foundry-rs/forge-std --no-git >/dev/null 2>&1 \
      || forge install foundry-rs/forge-std --no-commit >/dev/null 2>&1 \
      || forge install foundry-rs/forge-std
  fi
  if [ ! -d lib/openzeppelin-contracts/contracts ]; then
    info "Installing OpenZeppelin Contracts v5.1.0…"
    forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git >/dev/null 2>&1 \
      || forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-commit >/dev/null 2>&1 \
      || forge install OpenZeppelin/openzeppelin-contracts@v5.1.0
  fi
  ok "Dependencies ready"
  cd "$ROOT"
}

build_and_test() {
  cd "$CONTRACTS"
  info "Compiling contracts…"
  forge build >/dev/null
  ok "Contracts compiled"
  if [ "${SKIP_TESTS:-0}" != "1" ]; then
    info "Running tests…"
    forge test 2>&1 | grep -E "Suite result|FAIL" || true
  fi
  cd "$ROOT"
}

serve() {
  [ -f "$FRONTEND/config.js" ] || fail "No deployment found. Run ./start.sh local or ./start.sh robinhood first."
  local url="http://localhost:$PORT"
  bold ""
  bold "AfterHours is live at $url"
  info "Landing page: $url    App: $url/app.html"
  info "In the app: Connect, pick “Instant demo wallet”, then open the demo console."
  info "Press Ctrl+C to stop."
  ( sleep 1; (command -v open >/dev/null && open "$url") || (command -v xdg-open >/dev/null && xdg-open "$url") ) >/dev/null 2>&1 &
  cd "$FRONTEND"
  if command -v python3 >/dev/null 2>&1; then
    python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1
  elif command -v npx >/dev/null 2>&1; then
    npx --yes serve -l "$PORT" .
  else
    fail "Need python3 or Node.js (npx) to serve the web app."
  fi
}

deploy() {
  local rpc="$1" key="$2" name="$3" explorer="$4" extra=("${@:5}")
  local log="$ROOT/.deploy.log"
  cd "$CONTRACTS"
  info "Deploying to ${name}…"
  [ -f "$FRONTEND/config.js" ] && cp "$FRONTEND/config.js" "$FRONTEND/config.js.bak"
  if ! NETWORK_NAME="$name" PUBLIC_RPC_URL="$rpc" EXPLORER_URL="$explorer" PRIVATE_KEY="$key" \
      GRACE_SECONDS="${GRACE_SECONDS:-15}" \
      forge script script/Deploy.s.sol --rpc-url "$rpc" --broadcast ${extra[@]+"${extra[@]}"} > "$log" 2>&1; then
    tail -25 "$log"
    [ -f "$FRONTEND/config.js.bak" ] && mv "$FRONTEND/config.js.bak" "$FRONTEND/config.js"
    fail "Deployment failed. Full log: .deploy.log"
  fi
  rm -f "$FRONTEND/config.js.bak"
  grep -E "^ +(USDG|MarketOracle|AfterHoursPool|DemoController)" "$log" | sed 's/^ */    /' || true
  ok "Deployed. Addresses written to frontend/config.js"
  cd "$ROOT"
}

require_key() {
  [ -n "${PRIVATE_KEY:-}" ] || fail "Set PRIVATE_KEY (a throwaway testnet key) in your shell or in .env"
  [[ "$PRIVATE_KEY" == 0x* ]] || PRIVATE_KEY="0x$PRIVATE_KEY"
}

check_balance() {
  local rpc="$1" faucet="$2"
  local addr bal
  addr="$(cast wallet address --private-key "$PRIVATE_KEY")"
  bal="$(cast balance "$addr" --rpc-url "$rpc" --ether 2>/dev/null || echo 0)"
  info "Deployer $addr has $bal ETH"
  if [ "$(echo "$bal" | awk '{print ($1 < 0.002)}')" = "1" ]; then
    fail "Not enough ETH for gas. Get testnet ETH at $faucet and run again."
  fi
}

# ----------------------------------------------------------------------------- modes

case "$MODE" in
  local)
    bold "AfterHours, local demo"
    ensure_foundry; ensure_libs; build_and_test
    command -v anvil >/dev/null || fail "anvil not found (it ships with Foundry)"
    if lsof -i :8545 >/dev/null 2>&1 || (exec 3<>/dev/tcp/127.0.0.1/8545) 2>/dev/null; then
      fail "Port 8545 is busy. Stop the other node first."
    fi
    info "Starting a local chain (1-second blocks)…"
    anvil --block-time 1 --silent > "$ROOT/.anvil.log" 2>&1 &
    ANVIL_PID=$!
    trap 'kill $ANVIL_PID 2>/dev/null; echo; echo "  Stopped."' EXIT INT TERM
    for _ in $(seq 1 30); do cast block-number --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1 && break; sleep 0.3; done
    ok "Local chain running on http://127.0.0.1:8545"
    deploy "http://127.0.0.1:8545" "$ANVIL_KEY" "Local Anvil" ""
    serve
    ;;

  robinhood)
    bold "AfterHours, Robinhood Chain testnet"
    ensure_foundry; ensure_libs; build_and_test; require_key
    RPC="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
    EXPLORER="https://explorer.testnet.chain.robinhood.com"
    check_balance "$RPC" "https://faucet.testnet.chain.robinhood.com"
    EXTRA=(--slow)
    [ "${VERIFY:-0}" = "1" ] && EXTRA+=(--verify --verifier blockscout --verifier-url "$EXPLORER/api/")
    deploy "$RPC" "$PRIVATE_KEY" "Robinhood Chain Testnet" "$EXPLORER" "${EXTRA[@]}"
    serve
    ;;

  arbitrum-sepolia)
    bold "AfterHours, Arbitrum Sepolia"
    ensure_foundry; ensure_libs; build_and_test; require_key
    RPC="${RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}"
    EXPLORER="https://sepolia.arbiscan.io"
    check_balance "$RPC" "https://faucet.quicknode.com/arbitrum/sepolia"
    deploy "$RPC" "$PRIVATE_KEY" "Arbitrum Sepolia" "$EXPLORER" --slow
    serve
    ;;

  serve)
    serve
    ;;

  test)
    ensure_foundry; ensure_libs
    cd "$CONTRACTS" && forge test -vv
    ;;

  fund)
    TARGET="${2:-}"
    [ -n "$TARGET" ] || fail "Usage: ./start.sh fund <address>"
    ensure_foundry; require_key
    RPC="$(grep -o 'rpcUrl: "[^"]*"' "$FRONTEND/config.js" | cut -d'"' -f2)"
    info "Sending 0.01 ETH to $TARGET via ${RPC}…"
    cast send "$TARGET" --value 0.01ether --private-key "$PRIVATE_KEY" --rpc-url "$RPC" >/dev/null
    ok "Sent"
    ;;

  *)
    sed -n '2,13p' "$0"
    exit 1
    ;;
esac
