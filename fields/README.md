# Fields' Workspace

Plataforma local para registro de **notas**, **reuniões** e **lembretes**.

---

## Requisitos

- **Node.js** 18+ → [nodejs.org](https://nodejs.org)

---

## Início rápido

```bash
# 1. Tornar o script executável (Mac/Linux)
chmod +x start.sh

# 2. Iniciar tudo com um comando
./start.sh
```

**Windows (PowerShell):**
```powershell
# Backend
cd backend
npm install
node server.js

# Frontend (novo terminal)
cd frontend
npm install
npm run dev
```

Acesse: **http://localhost:5173**

---

## Estrutura

```
fields/
├── backend/
│   ├── server.js       # API REST Express
│   ├── db.json         # Banco de dados local (criado automaticamente)
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx     # Interface principal
│   │   ├── api.js      # Cliente HTTP
│   │   └── index.css   # Design system (azul/branco)
│   ├── index.html
│   └── vite.config.js
└── start.sh            # Script de inicialização
```

---

## API

| Método | Rota                     | Descrição                       |
|--------|--------------------------|---------------------------------|
| GET    | `/api/entries`           | Listar entradas (filtros via QS)|
| GET    | `/api/entries/upcoming`  | Próximos eventos/lembretes      |
| GET    | `/api/entries/stats`     | Contadores por tipo             |
| GET    | `/api/entries/:id`       | Detalhe + relacionados          |
| POST   | `/api/entries`           | Criar entrada                   |
| PATCH  | `/api/entries/:id`       | Atualizar entrada               |
| DELETE | `/api/entries/:id`       | Excluir entrada                 |

**Query params para GET /api/entries:**
- `type` — `all` | `note` | `event` | `reminder` | `pinned`
- `search` — texto para busca em título, conteúdo e tags

---

## Comandos no chat

| Digite             | Resultado          |
|--------------------|--------------------|
| `evento reunião…`  | Cria um evento     |
| `lembrete revisar…`| Cria um lembrete   |
| qualquer texto     | Cria uma nota      |

---

## Dados

Todas as entradas são salvas em `backend/db.json`. Para resetar, delete o arquivo — os dados de exemplo serão recriados automaticamente.
