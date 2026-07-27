# Project Instructions

<!-- PIEZAS-CONTEXT:START -->
## Backend - Piezas by Softmax Data

This app uses Piezas for business backend services. Keep the generated app focused on UI, routing, auth/session glue, workflow-specific orchestration, and calls to Piezas APIs.

### Start Here

1. Decide the deployment mode before choosing a framework or creating routes.
2. Read `piezas.manifest.json`; it is the machine-readable ownership/deployment source of truth.
3. If the user asks for `/piezas-spec`, `/pieza-spec`, `piezas-spec`, or Piezas spec mode, read `.piezas/spec-builder.md`, interview the user one question at a time, write `SPEC.md` or `specs/`, and stop. Do not implement until the user explicitly asks to code from the spec.
4. When coding starts, read `SPEC.md` or `specs/` before writing application code.
5. Use `@piezas/sdk` for Entity Records, Pipeline, Tasks, Notifications, Integrations, Workflow jobs, Calendar, Admin/access, Messaging, Forms, Documents, Reporting, Pricing, Discussion, and Knowledge Base.
6. Use the live OpenAPI specs to verify request/response details before calling less common endpoints or provider-specific integration actions.
7. Do not create custom database tables for Piezas-backed business data.
8. Do not store third-party OAuth access tokens, refresh tokens, provider client secrets, or sync cursors in this app.
9. Store Piezas IDs as references: record IDs, pipeline item IDs, connection IDs, and grant IDs.
10. If the app uses provider integrations, create or reuse a Piezas tenant app and pass its `appId`/`app_id` through config, OAuth, connections, grants, records, and access-log lookups.
11. Keep setup idempotent. `defineEntities()` and `definePipeline()` are safe to run on app startup or during seed/setup flows.
12. If the project has an MCP route, keep it server-side and session-protected; use `piezasMcp` from `@piezas/sdk`, not a separate MCP package.
13. If a required Piezas endpoint, connector, or normalized action is missing, document the gap and ask before building a parallel backend.
14. Run `npx piezas doctor` after generated changes and address errors before deployment.

### Spec-First Workflow

The recommended workflow is init, spec, then code:

1. `npx piezas init`
2. Generate a product spec:
   - Claude Code: run `/piezas-spec [optional product idea]`.
   - Cursor, Codex, and Windsurf: ask for `/piezas-spec`, `/pieza-spec`, or "Piezas spec mode".
3. In spec mode, read `.piezas/spec-builder.md`, ask one question at a time, and write `SPEC.md` for MVPs or `specs/` for larger handoffs.
4. Stop after writing the spec. Do not start implementation in the same mode unless the user explicitly asks to continue.
5. In code mode, read the finalized spec, map every backend need to Piezas services, then implement the UI/workflow layer.

### Framework Choice

Piezas is framework-agnostic. Any language or framework that can make HTTPS
calls works — the platform surface is plain OpenAPI, and `@piezas/sdk` is a
convenience for TypeScript, not a requirement. Do NOT steer the user toward a
specific framework. If they have a preference (including no framework at all),
honor it. If they ask for a recommendation, present real options neutrally —
e.g. Vite + a small Express/Fastify/Hono server, Remix, SvelteKit, Next.js, or
a non-JS stack calling the APIs directly — and let them choose. The only hard
requirements, regardless of stack:

1. `PIEZAS_API_KEY` stays server-side (see Security Rules).
2. Business data lives in Piezas, not a parallel local database.

Mode names like `next-bff` are historical labels: read `next-bff` as "frontend
with a small server layer" in whatever framework the user chose.

### Ownership Boundary

The app owns:

- UI and component state
- pages, routes, layouts, and client interactions
- app authentication and session glue
- lightweight API routes for server-side calls, secrets, and UI-specific orchestration only when the chosen deployment mode includes a server runtime
- access control around any app-hosted MCP route
- workflow-specific decisions such as which fields to show, what a booking form asks, and when to call a Piezas service

Piezas owns:

- business records and custom entity schemas
- pipelines, stages, boards, and stage movement
- tasks, assignments, due dates, and checklists
- notifications and message delivery records
- third-party integration connector definitions
- tenant app registry entries, allowed origins, allowed redirect URIs, and app-level integration policy
- app-scoped provider client configuration for separate generated apps/domains/use cases
- user integration connections and encrypted provider tokens
- scoped connection grants for public or organizer-owned workflows
- normalized integration actions and guarded provider proxy calls
- tenant users, invite-only signup, disabled users, public sessions, and audit events
- durable access logs for service calls across Piezas-backed apps
- durable background jobs and retry state
- normalized integration sync jobs, stale worker lock recovery, and sync cursors
- MCP tool discovery over approved Piezas-backed entity, pipeline, and task tools
- document extraction jobs and e-signature request state
- finance accounts, bills, bank transactions, journal entries, and reconciliation links as entity records
- entity search, bulk import, and JSON/CSV export
- public service records such as bookings, submissions, CRM/intake records, tasks, and workflow state when those records belong to a Piezas service

### Security Rules

- `PIEZAS_API_KEY` lives in the project's `.env` file (written by `npx piezas init` or downloaded from the dashboard). Read it server-side via `process.env.PIEZAS_API_KEY`; if it is missing, ask the user to run `npx piezas init --key <key>` or drop the dashboard-downloaded `.env` into the project root.
- **Declare every runtime env var the app cannot boot or function without** (provider API keys, session secrets, webhook secrets — anything beyond `PIEZAS_API_KEY`) in `piezas.manifest.json` under `deploy.requiredEnv` (a JSON array of names, never values). Add to it in the same change that introduces the dependency. `npx piezas deploy` never reads `.env` (the hosted environment lives in the Piezas console and `PIEZAS_API_KEY` is provisioned there automatically at app creation); it verifies this list against the HOSTED environment before uploading, and the server re-verifies before touching the running app — an accurate list is what prevents crashed first boots.
- Keep `PIEZAS_API_KEY` server-side only. Never expose it in browser code and never prefix it with a public-env marker (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, etc.).
- Whatever the framework, call Piezas from the server side (route handlers, server actions/loaders, API endpoints); browser code holds UI state only. (Next.js specifics, when that IS the chosen framework: server components/actions/route handlers make the calls, and tenant-specific fetches need `export const dynamic = 'force-dynamic'`.)
- Do not put OAuth tokens, refresh tokens, provider secrets, API keys, or sync cursors in local storage, cookies, browser state, or app database tables.
- If the app needs its own login, implement app login separately from integration OAuth. "Sign in with Google" is app auth; "connect Google Calendar" is provider data access through Piezas Integrations.
- For browser-exposed public flows, use Piezas public sessions or a thin server adapter. Do not pass the main API key to the browser.
- Do not hardcode one tenant-wide provider app for every product. Use the Admin/access app registry so each generated app can have its own allowed origins, callback URLs, connector purposes, and provider credentials.

### Deployment Mode Decision

Before implementation, classify the deployment target and follow the matching constraints.

#### Static Frontend Only

NOT RECOMMENDED YET: static apps depend on public guest tokens, and per-token
permission enforcement has not shipped platform-wide — a guest token currently
carries broader access than its scopes suggest. Steer the user to a
server-capable mode (next-bff or server-runtime) unless they explicitly accept
this and the app touches no sensitive data.

Examples: AWS Amplify static hosting, S3/CloudFront, GitHub Pages, Netlify static export.

Use this mode when the user says "frontend-only", "static", "S3", "static Amplify", or "no app backend".

Rules:

- Prefer Vite/React or Next.js with `output: 'export'`.
- Do not create `app/api/*`, `pages/api/*`, server actions, middleware, route handlers, or server components that require runtime secrets.
- Do not use `PIEZAS_API_KEY`, `ADMIN_PASS`, OAuth client secrets, or provider secrets in deployed frontend code.
- Do not add a deployed `/api/setup` endpoint. For schema setup, create a local script such as `scripts/setup-piezas.ts` that the developer runs locally with `PIEZAS_API_KEY`.
- Do not host an MCP route from the static frontend. If agent tool access is required, use a separate server adapter or change to a server-capable deployment mode.
- If the requested workflow requires a server-side secret, token exchange, webhook receiver, admin password, or provider callback, stop and ask the user to choose one of:
  - Piezas-hosted/public capability for that workflow
  - Amplify SSR/Next runtime
  - a small BFF/Lambda/API route layer
  - a different requirement

Static-only apps can safely store public UI state and Piezas reference IDs, but they cannot securely hold backend secrets.

#### Frontend With Server Runtime

Examples: Next.js on Amplify SSR, Vercel, Render, or any deployment that runs server code.

Rules:

- Server components, route handlers, and server actions are allowed for thin secret handling and UI-specific orchestration.
- Keep business data in Piezas, not local database tables.
- Keep `PIEZAS_API_KEY`, `ADMIN_PASS`, and any auth/session secrets in server-only environment variables.
- API routes should be small adapters around Piezas calls, not a parallel application backend.
- Prefer `createPiezasServerAdapter()` from `@piezas/sdk` for allowlisted proxy routes from the UI to Piezas services.
- If agent tool access is needed, mount `piezasMcp()` from `@piezas/sdk` on a protected POST route and pass authenticated user/tenant context through the request headers.

#### Full Custom Backend

Do not build a full custom backend unless the user explicitly asks for one after being told Piezas should own the backend service layer.

### MCP / Agent Tool Access

Piezas is MCP-ready through `@piezas/sdk`. Do not install or invent a separate MCP package unless the project explicitly requires one.

For a Next.js app with a server runtime:

```typescript
import { piezasMcp } from '@piezas/sdk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handler = piezasMcp({
  entitiesUrl: process.env.PIEZAS_ENTITIES_URL || 'https://api.piezas.ai/entities',
  pipelineUrl: process.env.PIEZAS_PIPELINE_URL || 'https://api.piezas.ai/pipeline',
  tasksUrl: process.env.PIEZAS_TASKS_URL || 'https://api.piezas.ai/tasks',
});

function requireMcpAccess(req: Request) {
  const hasAppSession = Boolean(req.headers.get('authorization') || req.headers.get('cookie'));
  const hasTenantContext = Boolean(req.headers.get('x-tenant-id') && req.headers.get('x-user-id'));
  if (hasAppSession && hasTenantContext) return null;

  return Response.json(
    { error: 'MCP route requires app auth plus X-Tenant-Id and X-User-Id.' },
    { status: 401 },
  );
}

export async function POST(req: Request) {
  // Replace this guard with your app session/auth check before public use.
  const denied = requireMcpAccess(req);
  if (denied) return denied;

  return handler(req);
}
```

The MCP route exposes approved Piezas-backed entity, pipeline, and task tools to agents. The app still owns route access control, session validation, and tenant/user context. Static deployments cannot safely host MCP because they cannot hold server-only secrets or perform trusted access checks.

### Capability Discovery

Before implementing feature logic:

1. Read this file.
2. Read `piezas.manifest.json`.
3. Open the relevant OpenAPI specs.
4. For integrations, inspect available connectors and actions rather than inventing action names.
5. Map each requirement to a Piezas service.
6. Write down any missing capability as a gap before coding around it.

Current normalized provider action-backed connectors include Google Calendar, Gmail, Google Drive, Zoom, HubSpot, DocuSign, QuickBooks, and AWS Textract-compatible proxy connections. Still inspect the connector/action catalog before hardcoding action IDs.

### Install and Initialize

Install:

```bash
npm install @piezas/sdk
```

Initialize:

```typescript
import { Piezas } from '@piezas/sdk';

const piezas = new Piezas({
  apiKey: process.env.PIEZAS_API_KEY,
  entitiesUrl: 'https://api.piezas.ai/entities',
  pipelineUrl: 'https://api.piezas.ai/pipeline',
  tasksUrl: 'https://api.piezas.ai/tasks',
  notificationsUrl: 'https://api.piezas.ai/notify',
  integrationsUrl: 'https://api.piezas.ai/integrations',
  workflowUrl: 'https://api.piezas.ai/workflow',
  calendarUrl: 'https://api.piezas.ai/calendar',
  messagingUrl: 'https://api.piezas.ai/messaging',
  formsUrl: 'https://api.piezas.ai/forms',
  documentsUrl: 'https://api.piezas.ai/documents',
  reportingUrl: 'https://api.piezas.ai/reporting',
  pricingUrl: 'https://api.piezas.ai/pricing',
  discussionUrl: 'https://api.piezas.ai/discussion',
  knowledgeBaseUrl: 'https://api.piezas.ai/knowledge-base',
  adminUrl: 'https://api.piezas.ai/admin',
});
```

The SDK exchanges `sk_live_...` or `sk_test_...` API keys for short-lived service tokens automatically.

### OpenAPI Specs

Read these specs before implementing direct REST calls:

- Entity Records: https://api.piezas.ai/entities/openapi.json
- Pipeline Engine: https://api.piezas.ai/pipeline/openapi.json
- Task Engine: https://api.piezas.ai/tasks/openapi.json
- Notifications: https://api.piezas.ai/notify/openapi.json
- Calendar: https://api.piezas.ai/calendar/openapi.json
- Messaging: https://api.piezas.ai/messaging/openapi.json
- Workflow: https://api.piezas.ai/workflow/openapi.json
- Forms: https://api.piezas.ai/forms/openapi.json
- Documents: https://api.piezas.ai/documents/openapi.json
- Reporting: https://api.piezas.ai/reporting/openapi.json
- Pricing: https://api.piezas.ai/pricing/openapi.json
- Discussion: https://api.piezas.ai/discussion/openapi.json
- Knowledge Base: https://api.piezas.ai/knowledge-base/openapi.json
- Integrations: https://api.piezas.ai/integrations/openapi.json
- Admin/access: https://api.piezas.ai/admin/openapi.json

### SDK Quick Reference

Define business data once, then use generated accessors:

```typescript
await piezas.defineEntities({
  contact: {
    fields: {
      email: { type: 'email', required: true },
      phone: { type: 'phone' },
      status: { type: 'select', options: ['lead', 'active', 'inactive'] },
    },
  },
  booking: {
    fields: {
      startsAt: { type: 'datetime', required: true },
      endsAt: { type: 'datetime', required: true },
      guestEmail: { type: 'email', required: true },
      status: { type: 'select', options: ['confirmed', 'cancelled'] },
    },
  },
});

const contact = await piezas.contacts.create({
  title: 'Jane Smith',
  data: { email: 'jane@example.com', status: 'lead' },
});

const contacts = await piezas.contacts.list({ limit: 50, search: 'jane' });
const searchResults = await piezas.contacts.search({ q: 'jane', limit: 10 });
const csv = await piezas.contacts.exportCsv({ status: 'active' });
await piezas.contacts.update(contact.id, { data: { status: 'active' } });
await piezas.contacts.logActivity(contact.id, {
  type: 'note',
  content: { text: 'Followed up after demo' },
});
```

Define stages and use pipelines for board-style workflows:

```typescript
await piezas.definePipeline('deals', {
  stages: ['New', 'Contacted', 'Proposal', 'Won', 'Lost'],
  winStages: ['Won'],
  lossStages: ['Lost'],
});

const board = await piezas.pipeline('deals').board();
await piezas.pipeline('deals').moveTo(itemId, 'Proposal');
```

Use tasks for assignments and follow-ups:

```typescript
await piezas.tasks.create({
  title: 'Follow up with Jane',
  priority: 'high',
  dueDate: '2026-05-25',
  assigneeId: currentUser.id,
});
```

Use Calendar for availability and bookings:

```typescript
const calendar = await piezas.calendar.createCalendar({
  name: 'Team bookings',
  timezone: 'America/Vancouver',
});

await piezas.calendar.createAvailabilityRule({
  calendarId: calendar.id,
  ruleType: 'recurring',
  daysOfWeek: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '17:00',
});

const slots = await piezas.calendar.getAvailableSlots({
  calendarId: calendar.id,
  dateFrom: '2026-05-25T00:00:00Z',
  dateTo: '2026-05-26T00:00:00Z',
  slotDuration: 30,
});

await piezas.calendar.createBooking({
  calendarId: calendar.id,
  title: 'Intro call',
  startTime: slots[0].start,
  endTime: slots[0].end,
  requireAvailableSlot: true,
});
```

Use Workflow durable jobs for background work, retries, and deferred processing:

```typescript
const job = await piezas.workflow.enqueueJob({
  type: 'booking.reminder',
  payload: { bookingId },
  runAt: '2026-05-25T16:00:00Z',
  dedupeKey: `booking-reminder:${bookingId}`,
});

const jobs = await piezas.workflow.claimJobs({ workerId: 'worker-1', limit: 10 });

await piezas.workflow.enqueueSyncJob({
  connector: 'gmail',
  connectionId,
  resource: 'messages',
  direction: 'pull',
  cursor: lastCursor,
});

await piezas.workflow.requeueStaleJobs({
  before: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
  reason: 'worker lock expired',
});
```

Use Admin/access for invite-only teams, public sessions, and audit events:

```typescript
const invite = await piezas.admin.createTenantInvite(tenantId, {
  email: 'teammate@example.com',
  role: 'member',
});

const publicSession = await piezas.admin.createPublicSession(tenantId, {
  resourceType: 'booking_page',
  resourceId: bookingPageId,
  scopes: ['booking:create'],
  expiresInSeconds: 60 * 60,
});

await piezas.admin.createAuditEvent(tenantId, {
  action: 'booking_page.public_session_created',
  resourceType: 'booking_page',
  resourceId: bookingPageId,
});
```

Use the remaining service clients directly from the same `Piezas` instance:

```typescript
await piezas.messaging.createCampaign({ name: 'Client newsletter' });
await piezas.forms.createForm({ name: 'Client intake' });
await piezas.documents.createDocument({ name: 'Proposal', url: uploadedFileUrl, mimeType });
await piezas.reporting.createDashboard({ name: 'Operations' });
await piezas.pricing.createDocument({ type: 'invoice', title: 'INV-1001' });
await piezas.discussion.createThread({ title: 'Client follow-up' });
await piezas.knowledgeBase.search(collectionId, { query: 'refund policy' });
```

Use Documents for extraction and e-signature workflow state before provider handoff:

```typescript
const extraction = await piezas.documents.createExtractionJob({
  documentId,
  provider: 'aws_textract',
  requestedFields: ['invoice_number', 'vendor_name', 'total', 'due_date'],
});

const signature = await piezas.documents.createSignatureRequest({
  title: 'Master services agreement',
  documentId,
  provider: 'docusign',
  signers: [{ name: 'Jane Client', email: 'jane@example.com' }],
});
```

Use finance/accounting pattern helpers before storing records in Entity Records:

```typescript
import {
  createInvoicePosting,
  normalizeFinanceAccount,
  suggestReconciliationMatches,
} from '@piezas/sdk';

const revenue = normalizeFinanceAccount({
  code: '4000',
  name: 'Service Revenue',
  type: 'revenue',
  currency: 'USD',
});

const entry = createInvoicePosting({
  invoiceRef: { type: 'invoice', id: invoiceId },
  amountMinor: 12500,
  currency: 'USD',
  accounts: {
    accountsReceivable: '1200',
    revenue: revenue.code,
  },
});
```

### Thin Server Adapter Pattern

For static frontends with a small BFF/Lambda/API route layer, use the SDK server adapter instead of writing an open proxy. The adapter exchanges the Piezas API key server-side, allowlists service/path/method combinations, strips caller auth, and forwards only safe headers.

```typescript
import { createPiezasServerAdapter } from '@piezas/sdk';

const adapter = createPiezasServerAdapter({
  apiKey: process.env.PIEZAS_API_KEY!,
  rules: [
    { service: 'entities', methods: ['GET', 'POST'], path: /^\/v1\/records/ },
    { service: 'calendar', method: 'GET', path: '/v1/public/slots' },
  ],
});

export async function POST(request: Request) {
  return adapter.handle(request, { service: 'entities', path: '/v1/records' });
}
```

Do not expose a generic path parameter like `/api/piezas/[...path]` unless every target is checked against a narrow allowlist.

### OpenAPI Fallback Pattern

Use SDK clients first. If a less common endpoint is not yet wrapped or you need to verify exact request/response details, read the service OpenAPI spec and call Piezas from server-side code. If you need a bearer token for direct REST, use the exported token provider:

```typescript
import { ApiKeyTokenProvider } from '@piezas/sdk';

const tokenProvider = new ApiKeyTokenProvider(
  process.env.PIEZAS_API_KEY!,
  'https://api.piezas.ai/admin'
);

const token = await tokenProvider.getToken();

const res = await fetch('https://api.piezas.ai/calendar/v1/bookings', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(input),
  cache: 'no-store',
});
```

### Integrations Pattern

Use Piezas Integrations for provider data access such as Google Calendar, Zoom, HubSpot, Slack, and similar systems. The app may render connect/status UI, but Piezas owns OAuth client config, callbacks, encrypted provider tokens, refresh, connection status, grants, normalized actions, proxy guardrails, and app-level integration policy.

Piezas integrations are app-scoped when the generated product has its own domain, callback URL, provider client credentials, or permission purpose. A booking app that needs Google Calendar access and a separate internal app that only needs Google identity should be separate tenant app records with separate allowed origins, redirect URIs, connector/purpose policy, and provider config. Store the Piezas tenant app slug/id in setup code and pass it as `appId` in SDK calls or `app_id` in REST calls.

Recommended flow:

1. List connectors and available actions.
2. Create or verify the Piezas tenant app through Admin/access with allowed origins, allowed redirect URIs, `authPolicy`, and `integrationPolicy`.
3. Save provider client credentials through Piezas Integrations using `appId` and `purpose` when the app needs its own OAuth provider app.
4. Start OAuth through Piezas with `appId`, `purpose`, `returnUrl`, and the app user ID.
5. Store returned connection IDs as references.
6. For public or organizer-owned workflows, create a scoped grant and store the grant ID.
7. Prefer `createValidatedConnectionGrant()` so connector action metadata is checked before grant creation.
8. Execute normalized actions first.
9. Use proxy only when no normalized action exists.

```typescript
const connectors = await piezas.integrations.listConnectors();

await piezas.admin.createTenantApp(tenantId, {
  slug: 'booking-portal',
  name: 'Booking portal',
  allowedOrigins: ['https://book.example.com'],
  allowedRedirectUris: ['https://book.example.com/integrations/connected'],
  integrationPolicy: {
    connectors: {
      google_calendar: { purposes: ['calendar_availability'] },
      zoom: { purposes: ['meeting_links'] },
    },
  },
});

const authUrl = await piezas.integrations.getAuthorizationUrl('google_calendar', {
  returnUrl: appReturnUrl,
  userId: currentUser.id,
  appId: 'booking-portal',
  purpose: 'calendar_availability',
});

const connections = await piezas.integrations.listConnections({
  connector: 'google_calendar',
  userId: currentUser.id,
  appId: 'booking-portal',
});

const grant = await piezas.integrations.createValidatedConnectionGrant(connectionId, {
  connector: 'google_calendar',
  label: 'Booking page',
  ownerUserId: currentUser.id,
  actions: ['google_calendar.freebusy', 'google_calendar.events.create'],
});

const freeBusy = await piezas.integrations.grantAction(
  grant.id,
  'google_calendar.freebusy',
  {
    timeMin: '2026-05-20T09:00:00Z',
    timeMax: '2026-05-20T17:00:00Z',
    items: [{ id: 'primary' }],
  }
);
```

### Public Booking / Intake Pattern

For a public booking, appointment, intake, or CRM lead-capture app:

- Entity Records: contacts, companies, leads, event types, organizer profiles, booking pages, invitee answers, booking references
- Calendar SDK/API: availability rules, booking records, blocked times, time windows
- Integrations: Google Calendar free/busy, Google Calendar event creation, Zoom meeting creation, and other provider actions when connectors expose them
- Notifications: booking confirmations, reminders, cancellations, reschedules
- Forms: custom invitee questions when the workflow needs reusable form definitions
- Tasks: internal follow-ups after high-value bookings
- Pipeline: CRM lead/opportunity stages when public submissions should become tracked sales or support work

Do not store Google/Zoom/Outlook tokens in the generated app. Store only Piezas connection IDs and grant IDs.
Store public visitor input as Piezas CRM/intake records, not only as UI-local state or unstructured booking notes.
Use the tenant app `appId` on connection and grant references so bookings, audit events, and access logs can be filtered by the generated app that owns the workflow.

Recommended UX sequence:

1. Team member signs up or signs in.
2. Team member connects Google Calendar before creating event types if external free/busy is required.
3. Team member optionally connects Zoom or another meeting provider.
4. Team member creates event types with duration, location mode, availability windows, work days, timezone, buffers, notice window, rolling date range, and custom questions.
5. Public visitor opens `/book/{slug}` or `/book/{team}/{event}`.
6. Visitor sees dates and slots in their local timezone.
7. Visitor answers custom questions and confirms.
8. App creates the booking through Piezas and uses Integrations to create external calendar/meeting artifacts when enabled.
9. Notifications send confirmation, cancellation, reschedule, and reminder messages.

Admin/team management:

- Use the Admin/access SDK/API for team members, roles, invite codes, disabled users, public sessions, and audit events.
- Use Piezas-backed records for app-specific organizer profiles, allowed domains, and UI preferences.
- Static-only apps must not use an `ADMIN_PASS` in browser code. If the user asks for `ADMIN_PASS`, require a server runtime/BFF or use a Piezas-hosted/admin-controlled mechanism.
- Admin pages should disable/kick users through the Admin/access API, not by deleting local database rows.

Static deployment warning:

- A public booking app can be static only if all booking, availability, auth, and integration calls can be made safely through browser-safe Piezas/public endpoints.
- If the app needs server-only token exchange or private admin secrets, use Amplify SSR/Next runtime or a small API layer. Do not silently add Next.js API routes to a static export app.

### Recipe Manifest Pattern

If `piezas.manifest.json` contains `recipes`, treat those recipes as requirements, not decoration. Each recipe declares which Piezas services own the backend state, which UI layer the app owns, and the expected setup order. Before coding, map the user's prompt to those recipe entries and reuse their service list.

Known recipe presets from the CLI:

- `booking-site`: public booking, availability, invitee questions, calendar/meeting integrations, reminders, and audit events
- `crm-project-finance`: contacts, deals, projects, tasks, invoices/receipts, ledger entries, documents, and reports
- `client-services-os`: client portal, cases/projects, tasks, documents, discussion, forms, appointments, and knowledge base

Do not create local product tables for a recipe-owned object unless the manifest explicitly moves ownership to the app.

### Small Business Operations Pattern

For booking, CRM, project/case tracking, invoicing, receipts, reconciliation, client documents, and basic reporting:

- Entity Records: contacts, companies, projects/cases, invoices, receipts, accounting accounts, journal entries, reconciliation links, signature requests, extraction jobs
- Pricing: catalog items, quotes, invoice-like documents, and line items
- Documents: uploaded invoices, receipts, contracts, signed files, and version history
- Tasks/Workflow: approval steps, reminders, reconciliation review queues, extraction jobs, report refreshes
- Reporting: sales, bookings, receivables, project status, and reconciliation dashboards
- Integrations: payment links/references, OCR or document extraction providers, e-signature providers, accounting exports, Gmail/Outlook sending, HubSpot import/export

Do not implement payment processing inside the generated app. Use provider integrations for payment links, checkout URLs, payout/status references, or accounting exports. Piezas stores the business records and provider references; the payment provider moves money.

For reconciliation, use SDK helpers such as `suggestReconciliationMatches()` and `createReconciliationLink()` before writing reconciliation records to Entity Records. For double-entry logic, use `assertBalancedJournalEntry()` before posting ledger entries.

For e-signature and invoice extraction, store request/job state in Piezas records and use Integrations for the provider call. Do not store provider access tokens or webhook secrets in the generated app.

### CRM Pattern

For a CRM:

- Entity Records: contacts, companies, deals, activities, notes, custom fields
- Pipeline: deal stages and board views
- Tasks: follow-ups, reminders, assignments
- Notifications/Messaging: outbound emails and sequence steps
- Integrations: provider-owned connections such as HubSpot, Gmail, or calendar providers when needed

### Project Tracker Pattern

For a project tracker:

- Entity Records: projects, issues, labels, releases, teams
- Pipeline: board columns such as Backlog, In Progress, Review, Done
- Tasks: assigned work and checklists
- Discussion: comments and threads
- Reporting: status dashboards and snapshots

### Implementation Workflow for Coding Agents

1. Read this file before writing app code.
2. Read `SPEC.md` or `specs/` if present. If no spec exists and the request is broad, run Piezas spec mode before coding.
3. Read `piezas.manifest.json` and keep implementation consistent with it.
4. Identify which Piezas services own each data/workflow need.
5. Define entity schemas and pipelines idempotently.
6. For provider integrations, create or reuse a Piezas tenant app and map each connector to an explicit purpose before starting OAuth.
7. Use SDK wrappers first.
8. Read OpenAPI specs before writing direct REST calls or provider action payloads.
9. Keep secrets and API keys server-side.
10. Build UI and workflow around Piezas references, not local backend tables.
11. If MCP is needed, use `piezasMcp` from `@piezas/sdk` on a protected server route; do not add an MCP route to static-only apps.
12. Add focused tests for the app's orchestration logic and public/server route validation.
13. Run `npx piezas doctor`; fix errors before claiming the app is ready.
14. If a required Piezas capability is missing, leave a small adapter boundary and document the missing endpoint/action instead of building a parallel backend.

### Hard No List

- No local database tables for Piezas-backed business objects.
- No OAuth token storage in the app.
- No provider callback handlers for integration OAuth unless Piezas explicitly requires a return page for UI only.
- No background token refresh jobs in the app.
- No scraping or undocumented provider API calls when a Piezas connector/action exists.
- No exposing `PIEZAS_API_KEY` to browser code.
- No public MCP route without app auth, tenant checks, and server runtime.
<!-- PIEZAS-CONTEXT:END -->
