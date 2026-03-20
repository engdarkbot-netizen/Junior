#!/usr/bin/env bash
set -e

echo "=== Rotating Proxy Setup ==="

# Check python3
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found. Install it first."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Create venv if not exists
if [ ! -d "venv" ]; then
  echo "[1/3] Creating virtual environment..."
  python3 -m venv venv
fi

# Install deps
echo "[2/3] Installing dependencies..."
venv/bin/pip install -q -r requirements.txt

echo "[3/3] Done!"
echo ""
echo "To start the proxy server:"
echo "  cd proxy && venv/bin/python server.py"
echo ""
echo "To use it (in another terminal):"
echo "  curl -x http://127.0.0.1:8080 https://httpbin.org/ip"
echo ""
echo "Status endpoint:"
echo "  curl http://127.0.0.1:8080/__status__"
