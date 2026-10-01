# WhatsApp Dashboard - Technical Stack & Project Documentation

## Project Overview

**WhatsApp Dashboard** is an integrated business intelligence platform for Raigam, a Sri Lankan mattress company. It provides real-time WhatsApp conversation monitoring, lead management, customer relationship management, and order tracking with AI-powered conversation analysis.

**Purpose**: Streamline customer interactions through WhatsApp by automatically analyzing conversations, scoring leads, and managing customer relationships and orders.

**Status**: Active Development (MVP Phase)

---

## Technology Stack

### Backend

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Runtime | Node.js | Latest | Server runtime environment |
| Framework | Express.js | ^4.18.2 | REST API server |
| AI SDK | Anthropic SDK | ^0.96.0 | Claude integration for conversation analysis |
| Database | Supabase (PostgreSQL) | ^2.39.0 | Data persistence (real-time) |
| Environment | dotenv | ^16.3.1 | Environment variable management |
| Dev Tool | Nodemon | ^3.0.2 | Auto-restart on file changes |

**Key Features**:
- Express REST API with CORS support
- Webhooks for WhatsApp Business API integration
- Claude Sonnet 4.6 for conversation analysis and lead scoring
- Async conversation processing (fire-and-forget)
- Real-time database updates via Supabase

### Frontend

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Library | React | ^18.2.0 | UI framework |
| Build Tool | Vite | ^5.0.8 | Fast build tool and dev server |
| Routing | React Router | ^7.15.1 | Page navigation |
| Database | Supabase | ^2.39.0 | Real-time client |
| Icons | Lucide React | ^1.16.0 | Icon components |
| Export (PDF) | jsPDF | ^4.2.1 | PDF generation |
| Export (Excel) | XLSX | ^0.18.5 | Excel file generation |
| Table Plugin | jsPDF-autotable | ^5.0.8 | Table formatting in PDFs |
| CSS | Inline (React) | - | Styling approach |

**Key Features**:
- Single-page application (SPA)
- Real-time data synchronization with Supabase
- Multiple dashboard views (Leads, Customers, Messages, Orders)
- Export functionality (PDF, Excel)
- Responsive design with Lucide icons

---

## Project Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (React)                         │
│         - Dashboard Pages (Leads, Customers, Orders)          │
│         - Real-time Message Viewer                            │
│         - Export Utilities (PDF, Excel)                       │
└────────────────┬────────────────────────────────────────────┘
                 │ HTTP/REST
                 ↓
┌─────────────────────────────────────────────────────────────┐
│                   Backend (Express.js)                        │
│         - WhatsApp Webhook Handler                            │
│         - REST API Endpoints                                  │
│         - Claude AI Integration                               │
│         - Conversation Analysis (async)                       │
│         - Lead Scoring & Priority Ranking                     │
└────────────────┬────────────────────────────────────────────┘
                 │ API
                 ↓
┌─────────────────────────────────────────────────────────────┐
│              External Services & Databases                    │
│         - WhatsApp Business API (v18.0)                       │
│         - Anthropic Claude API                                │
│         - Supabase PostgreSQL                                 │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Incoming Messages**: WhatsApp API → Backend Webhook
2. **Analysis**: Backend queues message → Claude analyzes conversation
3. **Storage**: Analysis results → Supabase database
4. **UI Update**: Frontend subscribes to real-time Supabase changes
5. **Lead/Customer Management**: UI displays analyzed data with scoring

---

## Directory Structure

```
Whatsapp/
├── whatsapp-backend/              # Node.js Express backend
│   ├── index.js                   # Main server file, webhook handlers, API endpoints
│   ├── package.json               # Backend dependencies
│   ├── .env                       # Backend environment variables
│   ├── .gitignore                 # Git ignore rules
│   └── node_modules/              # Installed dependencies
│
├── whatsapp-dashboard/            # React frontend (Vite)
│   ├── src/
│   │   ├── pages/                 # Full-page components
│   │   │   ├── Leads.jsx          # Lead listing and management
│   │   │   ├── LeadDetail.jsx     # Individual lead details
│   │   │   ├── Customers.jsx      # Customer management view
│   │   │   ├── CustomerDetail.jsx # Individual customer details
│   │   │   ├── Messages.jsx       # Message interface/chat viewer
│   │   │   └── Dashboard.jsx      # Main dashboard overview
│   │   │
│   │   ├── components/            # Reusable UI components
│   │   │   ├── NavBar.jsx         # Navigation header
│   │   │   ├── Sidebar.jsx        # Navigation sidebar
│   │   │   ├── ChatPanel.jsx      # Conversation display area
│   │   │   ├── ChatBody.jsx       # Chat message container
│   │   │   ├── ChatHeader.jsx     # Chat header with contact info
│   │   │   ├── MessageBubble.jsx  # Individual message component
│   │   │   ├── MessageInput.jsx   # Message input/compose area
│   │   │   ├── ConversationList.jsx # List of conversations
│   │   │   ├── ConversationItem.jsx # Single conversation item
│   │   │   ├── LeadsPage.jsx      # Leads management page
│   │   │   ├── OrdersPage.jsx     # Orders management page
│   │   │   ├── OrderModal.jsx     # Order creation/editing modal
│   │   │   ├── SummaryPanel.jsx   # Conversation summary display
│   │   │   ├── EmptyState.jsx     # Empty state UI
│   │   │   └── Toast.jsx          # Notification component
│   │   │
│   │   ├── lib/                   # Utility libraries
│   │   │   ├── supabase.js        # Supabase client initialization
│   │   │   └── config.js          # Configuration constants
│   │   │
│   │   ├── utils/                 # Helper functions
│   │   │   └── time.js            # Time formatting utilities
│   │   │
│   │   ├── main.jsx               # React entry point
│   │   ├── App.jsx                # Root component with routing
│   │   └── index.css              # Global styles
│   │
│   ├── dist/                      # Production build output
│   ├── public/                    # Static assets (if any)
│   ├── index.html                 # HTML entry point
│   ├── vite.config.js             # Vite configuration
│   ├── package.json               # Frontend dependencies
│   ├── .env                       # Frontend environment variables
│   └── .gitignore                 # Git ignore rules
│
├── .git/                          # Git repository
├── TECHNICAL_STACK.md             # This file
└── README.md                      # Project readme (if exists)
```

---

## Key Features & Capabilities

### 1. **AI-Powered Conversation Analysis**
- Uses Claude Sonnet 4.6 to analyze WhatsApp conversations
- Extracts customer information (name, product interest, bed size, etc.)
- Auto-scores lead priority (1-10 scale)
- Generates AI summaries of conversations
- Tags conversation types (inquiry, complaint, order, etc.)

### 2. **Lead Management**
- View all leads with AI-assigned priority scores
- Filter and search leads by various criteria
- Lead detail pages with full conversation history
- Lead conversion tracking
- Export lead lists to PDF/Excel

### 3. **Customer Relationship Management (CRM)**
- Centralized customer database
- Customer interaction history
- Customer details and preferences
- Linked conversations and orders

### 4. **Real-Time Messaging Dashboard**
- View live WhatsApp conversations
- Message threading and conversation context
- Automatic conversation analysis and summarization
- Send responses via API

### 5. **Order Management**
- Create and track orders within the dashboard
- Link orders to customers
- Order status tracking
- Order export functionality

### 6. **Real-Time Data Synchronization**
- Supabase real-time subscriptions
- Automatic UI updates on data changes
- Low-latency data synchronization

---

## Database Schema (Inferred)

### Core Tables

#### `customers`
- `id` (UUID, Primary Key)
- `name` (Text)
- `phone` (Text, Unique)
- `email` (Text)
- `product_interest` (Text)
- `bed_size` (Text)
- `priority_score` (Integer, 1-10)
- `priority_label` (Text: "low", "medium", "high", "critical")
- `created_at` (Timestamp)
- `updated_at` (Timestamp)

#### `leads`
- `id` (UUID, Primary Key)
- `customer_id` (UUID, Foreign Key)
- `customer_name` (Text)
- `phone` (Text)
- `product_type` (Text)
- `bed_size` (Text)
- `price_range` (Text)
- `delivery_location` (Text)
- `priority_score` (Integer, 1-10)
- `priority_label` (Text)
- `status` (Text: "new", "contacted", "qualified", "converted")
- `created_at` (Timestamp)
- `updated_at` (Timestamp)

#### `conversations`
- `id` (UUID, Primary Key)
- `customer_id` (UUID, Foreign Key)
- `messages` (JSON Array)
- `summary` (Text, AI-generated)
- `extracted_data` (JSON)
- `conversation_type` (Text)
- `created_at` (Timestamp)
- `updated_at` (Timestamp)

#### `messages`
- `id` (UUID, Primary Key)
- `conversation_id` (UUID, Foreign Key)
- `customer_id` (UUID, Foreign Key)
- `role` (Text: "user", "assistant")
- `content` (Text)
- `timestamp` (Timestamp)

#### `orders`
- `id` (UUID, Primary Key)
- `customer_id` (UUID, Foreign Key)
- `order_date` (Timestamp)
- `product` (Text)
- `quantity` (Integer)
- `price` (Decimal)
- `status` (Text)
- `delivery_address` (Text)
- `created_at` (Timestamp)
- `updated_at` (Timestamp)

---

## API Endpoints

### Backend Routes

#### Messages & Conversations
- `POST /webhook` - WhatsApp webhook receiver
- `GET /api/messages` - Fetch messages for a customer
- `GET /api/conversations/:id` - Get specific conversation
- `POST /api/conversations/:id/summary` - Generate AI summary

#### Customers
- `GET /api/customers` - List all customers
- `GET /api/customers/:id` - Get customer details
- `POST /api/customers` - Create new customer
- `PATCH /api/customers/:id` - Update customer

#### Leads
- `GET /api/leads` - List all leads
- `GET /api/leads/:id` - Get lead details
- `POST /api/leads` - Create new lead
- `PATCH /api/leads/:id` - Update lead status

#### Orders
- `GET /api/orders` - List all orders
- `POST /api/orders` - Create new order
- `PATCH /api/orders/:id` - Update order status

### Frontend Routes

- `/` - Redirect to leads
- `/leads` - Leads management page
- `/leads/:id` - Lead detail view
- `/customers/:id` - Customer detail view
- `/messages` - Messaging/chat interface
- `/orders` - Orders management

---

## Environment Variables

### Backend (.env)

```env
# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-supabase-anon-key

# Anthropic API
ANTHROPIC_API_KEY=your-anthropic-api-key

# Server Configuration
PORT=3000
NODE_ENV=development

# WhatsApp Configuration
WHATSAPP_PHONE_NUMBER_ID=1091734507363701
WHATSAPP_BUSINESS_ACCOUNT_ID=your-account-id
WHATSAPP_API_TOKEN=your-facebook-token
```

### Frontend (.env)

```env
# Supabase Configuration
VITE_SUPABASE_URL=https://bljezrawtxghclqgflun.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...

# Backend API
VITE_BACKEND_URL=http://localhost:3000
```

---

## Setup & Installation

### Prerequisites
- Node.js 16+ and npm/yarn
- Supabase account with PostgreSQL database
- Anthropic API key (Claude access)
- WhatsApp Business API credentials

### Backend Setup

```bash
cd whatsapp-backend

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env
# Edit .env with your credentials

# Start development server
npm run dev

# Server runs on http://localhost:3000
```

### Frontend Setup

```bash
cd whatsapp-dashboard

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env
# Edit .env with backend URL and Supabase keys

# Start development server
npm run dev

# Frontend runs on http://localhost:5173
```

### Database Setup (Supabase)

1. Create Supabase project
2. Run migrations to create tables (schema provided above)
3. Set up real-time subscriptions on relevant tables
4. Configure Row Level Security (RLS) policies if needed

---

## Development Workflow

### Running Both Services

**Terminal 1 - Backend:**
```bash
cd whatsapp-backend
npm run dev
```

**Terminal 2 - Frontend:**
```bash
cd whatsapp-dashboard
npm run dev
```

### Building for Production

**Backend:**
- No build step required; runs directly with Node.js

**Frontend:**
```bash
cd whatsapp-dashboard
npm run build
# Creates optimized build in dist/
npm run preview  # Preview production build locally
```

### Testing Flow

1. Send test message through WhatsApp to the configured number
2. Backend receives webhook and processes asynchronously
3. Claude analyzes conversation
4. Data updates in Supabase
5. Frontend reflects changes in real-time

---

## Key Technologies & Why They Were Chosen

| Technology | Reason |
|-----------|--------|
| **Express.js** | Lightweight, flexible framework for building REST APIs quickly |
| **React** | Industry standard for building interactive UIs with component reusability |
| **Vite** | Fast build tool with instant HMR, significantly faster than Webpack |
| **Supabase** | Open-source Firebase alternative with real-time PostgreSQL, reduces backend complexity |
| **Claude API** | State-of-the-art LLM for conversation analysis and information extraction |
| **React Router** | Standard routing solution for SPAs with nested route support |
| **Lucide React** | Lightweight, tree-shakeable icon library |

---

## Performance Considerations

### Backend
- Async conversation analysis prevents blocking on Claude API calls
- Fire-and-forget pattern for message processing
- Database connection pooling via Supabase SDK

### Frontend
- Vite's code splitting for faster initial load
- React's component memoization potential for optimizing rerenders
- Real-time subscriptions minimize polling overhead
- Built assets optimized and minified

---

## Security Considerations

- CORS enabled for frontend-backend communication (development config)
- Environment variables for sensitive credentials
- Supabase RLS can be configured for row-level security
- WhatsApp API token secured in backend environment only
- Frontend uses Supabase public/anon key (appropriate for public data)

---

## Future Enhancements

- [ ] Multi-user authentication and role-based access control (RBAC)
- [ ] Advanced analytics dashboard
- [ ] Custom lead scoring rules configuration
- [ ] Automated response suggestions via Claude
- [ ] Conversation templates
- [ ] Team collaboration features
- [ ] API rate limiting and quotas
- [ ] Comprehensive logging and audit trails
- [ ] Mobile app (React Native)
- [ ] Batch message operations
- [ ] Integration with other messaging platforms

---

## Troubleshooting

### Backend Won't Connect to Supabase
- Verify `SUPABASE_URL` and `SUPABASE_KEY` in .env
- Check network connectivity
- Ensure Supabase project is active

### Frontend Can't Connect to Backend
- Verify `VITE_BACKEND_URL` points to running backend
- Check CORS headers in backend (currently allow all)
- Verify both services are running

### Claude API Errors
- Check `ANTHROPIC_API_KEY` is valid
- Monitor rate limits on Anthropic dashboard
- Verify API key has access to Claude Sonnet 4.6

### Supabase Real-Time Not Working
- Enable real-time on specific tables in Supabase dashboard
- Check subscription query syntax in components
- Verify network connection to Supabase

---

## File Size & Performance Metrics

### Build Size (Frontend)
- Typical optimized bundle: ~150-200KB gzipped
- Asset optimization via Vite

### Key API Response Times
- Webhook processing: <100ms (async analysis)
- Lead list fetch: 50-200ms depending on record count
- Claude analysis: 2-10s (depends on conversation length)

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2024-05 | Initial MVP with messaging, leads, customers, orders |
| - | - | Real-time dashboard with Supabase |
| - | - | Claude-powered conversation analysis |

---

## Contact & Support

For questions about this technical stack or project setup, please reach out to the development team.

**Key Technologies Support:**
- Express: https://expressjs.com
- React: https://react.dev
- Vite: https://vitejs.dev
- Supabase: https://supabase.com/docs
- Anthropic Claude: https://docs.anthropic.com

---

*Generated: May 21, 2026*
*Last Updated: May 21, 2026*
