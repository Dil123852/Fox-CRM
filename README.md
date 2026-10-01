# WhatsApp Dashboard for Raigam (Nidikumba Mattresses)

An AI-powered WhatsApp business intelligence platform for Nidikumba Mattresses (Raigam), a Sri Lankan mattress company. It monitors WhatsApp conversations in real time, uses Claude AI to analyze them and score leads, and manages customers, leads, and orders through an integrated dashboard.

## Features

✨ **Real-time WhatsApp Monitoring** - View conversations as they happen via Server-Sent Events
🤖 **AI Replies & Analysis** - Claude replies to customers and extracts lead data (product, size, price, priority) automatically
📊 **Lead Management** - Track and prioritize leads with AI-generated scores (low/medium/high)
👥 **Customer CRM** - Manage customer relationships, history, and per-customer AI toggle
📦 **Order Tracking** - Create and manage orders within the platform
📥 **Data Export** - Export leads and orders to PDF/Excel
🌐 **Multi-language** - Conversations in English, Sinhala, and Tamil are handled natively by Claude
🔀 **Multi-channel** - Supports both Meta/Facebook WhatsApp Business API and Twilio WhatsApp Sandbox

## Project Structure

```
whatsapp-backend/       - Node.js Express API server (webhooks, AI, database)
whatsapp-dashboard/     - React + Vite frontend dashboard
db/                     - PostgreSQL init/schema scripts
docker-compose.yml      - db + backend + frontend orchestration
test-conversation.js            - Simulates a full English WhatsApp conversation via the webhook
test-conversation-sinhala.js    - Same, in Sinhala
```

## Technology Stack

**Backend:**
- Node.js + Express.js
- PostgreSQL (via `pg`), run locally via Docker
- Anthropic Claude API (`claude-sonnet-4-6`) - AI replies + conversation analysis/lead scoring
- Meta WhatsApp Business API (primary channel)
- Twilio WhatsApp Sandbox (fallback channel)
- Server-Sent Events (SSE) for real-time updates to the frontend
- Jest + Supertest for testing

**Frontend:**
- React 18 + Vite
- React Router
- Inline-styled components (no CSS framework)
- Native `EventSource`-based SSE client (`src/lib/sse.js`)
- jsPDF / jsPDF-autotable + XLSX for exports
- Vitest + React Testing Library for testing

> Note: This project previously used Supabase for the database and realtime updates. It has since migrated to a self-hosted PostgreSQL database (via Docker) and custom SSE for real-time sync — do not reintroduce Supabase.

## Quick Start

### Prerequisites
- Node.js 16+
- Docker & Docker Compose
- Anthropic API key
- Meta WhatsApp Business API token (and/or Twilio account for the fallback channel)

### Option A: Docker Compose (recommended)

```bash
cp .env.example .env   # configure credentials, see below
docker-compose up --build
```

This starts:
- `db` - PostgreSQL 16 on port 5432 (auto-initialized from `db/init.sql`)
- `backend` - Express API on port 3000
- `frontend` - Nginx-served dashboard on port 8080

### Option B: Manual local development

**Database:**
```bash
docker-compose up db   # or run your own local PostgreSQL and point DATABASE_URL at it
```

**Backend:**
```bash
cd whatsapp-backend
npm install
cp .env.example .env   # configure with your credentials
npm run dev
```

**Frontend:**
```bash
cd whatsapp-dashboard
npm install
cp .env.example .env   # configure with your backend URL
npm run dev
```

Frontend runs at `http://localhost:5173`
Backend API runs at `http://localhost:3000`

## Environment Variables

### Root `.env` (used by docker-compose)
```env
POSTGRES_PASSWORD=
ANTHROPIC_API_KEY=
WHATSAPP_TOKEN=
VERIFY_TOKEN=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=
TWILIO_VALIDATE_SIGNATURE=true
VITE_BACKEND_URL=
```

### Backend (`whatsapp-backend/.env`)
```env
DATABASE_URL=postgres://crm:<password>@localhost:5432/crm
ANTHROPIC_API_KEY=
WHATSAPP_TOKEN=
VERIFY_TOKEN=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=
TWILIO_VALIDATE_SIGNATURE=true
PORT=3000
```

### Frontend (`whatsapp-dashboard/.env`)
```env
VITE_BACKEND_URL=http://localhost:3000
```

## API Endpoints

- `GET /health` - Server health check
- `GET /api/events` - SSE stream for real-time updates (`message_insert`, `customer_update`, `lead_update`)
- `POST /webhook` - Meta WhatsApp webhook receiver
- `POST /webhook/twilio` - Twilio WhatsApp webhook receiver
- `POST /api/summary` - AI-generated conversation summary
- `POST /api/send-message` - Send a manual outbound message (disables AI for that customer)
- `POST /api/toggle-ai` - Enable/disable AI auto-reply for a customer
- `GET/POST /api/customers`, `PATCH /api/customers/:id` - Customer CRUD
- `GET/POST/PATCH /api/leads/:id` - Lead management
- `GET/POST/PATCH/DELETE /api/products/:id` - Product catalog management
- `GET/POST/PATCH/DELETE /api/orders/:id` - Order CRUD

## How It Works

1. A customer message arrives via the Meta or Twilio webhook and is stored immediately.
2. If AI is enabled for that customer, the backend sends the last 10 messages plus the product catalog to Claude, which drafts a reply that is sent back over WhatsApp.
3. In the background, Claude also analyzes the conversation to extract customer/lead details (name, product, bed size, price, delivery info) and a priority score (1-3, low/medium/high).
4. Customer and lead records are updated in PostgreSQL, and `customer_update`/`lead_update`/`message_insert` events are broadcast over SSE.
5. The dashboard's SSE client listens for these events and refreshes the relevant views in real time.

## Development

**Terminal 1:**
```bash
cd whatsapp-backend && npm run dev
```

**Terminal 2:**
```bash
cd whatsapp-dashboard && npm run dev
```

### Testing

```bash
cd whatsapp-backend && npm test
cd whatsapp-dashboard && npm test
```

Manual conversation testing (posts simulated messages to the local webhook):
```bash
node test-conversation.js            # English
node test-conversation-sinhala.js    # Sinhala
```

### Building for Production

```bash
cd whatsapp-dashboard
npm run build
npm run preview   # Test production build locally
```

## Key Files

- `whatsapp-backend/index.js` - Main server, webhook handlers, AI logic, API endpoints
- `whatsapp-dashboard/src/App.jsx` - Root React component with routing
- `whatsapp-dashboard/src/lib/sse.js` - Real-time SSE client
- `whatsapp-dashboard/src/pages/` - Full-page components (Leads, Customers, Messages, Orders)
- `whatsapp-dashboard/src/components/` - Reusable UI components
- `db/` - PostgreSQL schema/init scripts
- `docker-compose.yml` - Service orchestration (db, backend, frontend)

## Documentation

- **[TECHNICAL_STACK.md](./TECHNICAL_STACK.md)** - Comprehensive technical documentation, architecture, and database schema
- **[CICD.md](./CICD.md)** - CI/CD pipeline documentation

## Common Issues

**Frontend can't connect to backend?**
- Ensure backend is running on `http://localhost:3000`
- Check `VITE_BACKEND_URL` in the frontend `.env`

**Database connection failing?**
- Verify `DATABASE_URL` / `POSTGRES_PASSWORD` are correct
- Confirm the `db` container is healthy: `docker-compose ps`

**Claude API errors?**
- Check `ANTHROPIC_API_KEY` is valid
- Monitor rate limits on the Anthropic dashboard

**Real-time updates not showing in the dashboard?**
- Confirm the browser has an active connection to `GET /api/events`
- Check for reconnect logs from `src/lib/sse.js` in the browser console

## License

Proprietary - Raigam

## Contact

For questions or support, contact the development team.
