#!/bin/bash
# Fields' — iniciar backend + frontend

echo ""
echo "  ✦  Fields' Workspace"
echo "  ────────────────────────────────"

# Verifica Node
if ! command -v node &> /dev/null; then
  echo "  ✗  Node.js não encontrado. Instale via https://nodejs.org"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Instala dependências se necessário
echo "  → Verificando dependências…"
if [ ! -d "$ROOT/backend/node_modules" ]; then
  echo "  → Instalando backend…"
  cd "$ROOT/backend" && npm install --silent
fi
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "  → Instalando frontend…"
  cd "$ROOT/frontend" && npm install --silent
fi

echo "  → Iniciando serviços…"
echo ""
echo "     API   →  http://localhost:3001"
echo "     App   →  http://localhost:5173"
echo ""
echo "  Ctrl+C para parar."
echo ""

# Roda ambos em paralelo
cd "$ROOT/backend" && node server.js &
BACKEND_PID=$!

cd "$ROOT/frontend" && npm run dev -- --open &
FRONTEND_PID=$!

# Mata ambos ao sair
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo ''; echo '  ✦  Fields encerrado.'; exit" SIGINT SIGTERM

wait
