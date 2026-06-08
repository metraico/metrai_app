# MetRAI Next.js Frontend Migration

Professional Next.js 16 dashboard replacing Streamlit frontend. Built with latest tech, industry standards, and production-grade security.

## Quick Start

```bash
npm run dev
# Opens http://localhost:3000
```

## Phases Completed

- ✅ **Phase 1:** Authentication (Sign In/Up, tokens, refresh)
- ✅ **Phase 2:** Dashboard layout (Sidebar, TopBar, navigation)
- ⏳ **Phase 3+:** Config forms, results dashboard, charts, export

## What's Built

### Authentication
- Sign In / Sign Up forms with validation
- JWT tokens + silent refresh
- httpOnly cookie storage
- Middleware route protection
- Graceful logout

### Dashboard
- Responsive sidebar navigation
- Breadcrumb header with user info
- Account management grid
- Mobile-first responsive design
- MetRAI color palette (#4F46E5, #343C4C, #F7F9FC)

### UI Components
- Button, Input, Card, Tabs, Select
- Alert, Dialog, Badge
- All with TypeScript + Tailwind CSS

### API Integration
- Axios HTTP client with interceptors
- Bearer token injection
- CORS-safe Next.js proxy routes
- Automatic token refresh

## Architecture

```
Next.js 16 App Router + TypeScript
├── Authentication (Zustand store + Axios)
├── State Management (Zustand)
├── UI Components (Radix UI primitives)
├── Styling (Tailwind CSS + CSS variables)
└── API Client (Axios with interceptors)
```

## Environment Variables

```env
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
BACKEND_URL=http://localhost:8000
NODE_ENV=development
```

## Development

```bash
npm run dev      # Start dev server
npm run build    # Production build
npm run lint     # ESLint
npm start        # Run production build
```

## Tech Stack

- **Framework:** Next.js 16.2.7 (Turbopack)
- **Language:** TypeScript 5
- **Styling:** Tailwind CSS 4
- **UI:** Radix UI primitives
- **State:** Zustand 4.5
- **HTTP:** Axios 1.7
- **Charts:** Recharts 2.14
- **Icons:** Lucide React 0.469

## Build Status

```
✓ Compiled successfully (3.3s)
✓ TypeScript strict mode (4.1s)
✓ All routes registered (7/7)
✓ Zero errors/warnings
```

## Security Features

✅ JWT authentication with refresh tokens  
✅ httpOnly cookies (XSS protection)  
✅ Silent token refresh  
✅ CORS-safe API proxying  
✅ Route middleware protection  
✅ TypeScript strict mode  
✅ Form validation  

## Color Palette (MetRAI)

| Name | Hex | Purpose |
|------|-----|---------|
| **Majorelle Blue** | #4F46E5 | Primary actions |
| **Charcoal Blue** | #343C4C | Text/headings |
| **Platinum** | #F7F9FC | Page background |
| **Mint Cream** | #E9F6EE | Success/accents |
| **Lavender Grey** | #9AA5BC | Muted text |

## Routes

| Route | Status | Purpose |
|-------|--------|---------|
| `/login` | ✅ Built | Sign In / Sign Up |
| `/retailers` | ✅ Built | Account grid |
| `/retailers/[id]/runs` | ✅ Built | Simulation runs |
| `/retailers/[id]/simulation/new` | ✅ Built | Create simulation |
| `/retailers/[id]/scenario` | ✅ Built | Scenario setup |
| `/api/auth/*` | ✅ Built | Auth proxy |

## Documentation

- [PHASE_1_COMPLETE.md](./PHASE_1_COMPLETE.md) — Auth details
- [PHASE_2_COMPLETE.md](./PHASE_2_COMPLETE.md) — Layout details
- [MIGRATION_PROGRESS.md](./MIGRATION_PROGRESS.md) — Overall progress

## Testing

```bash
# Manual: Visit http://localhost:3000
# Sign in → Select account → Navigate pages
# Check DevTools for API calls and tokens
```

## Next Steps (Phase 3)

Implementing simulation config form:
- Parameter inputs (name, dates, seed)
- Advanced options per DC
- 310s timeout on submission
- Results page redirect

Estimated: 4-6 hours

---

**Status:** Production-ready authentication + dashboard. Ready for Phase 3.
