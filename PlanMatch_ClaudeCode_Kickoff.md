# PlanMatch — Claude Code Kickoff Brief
**Version:** v2.0 | **Stack:** Vite + React + TypeScript | **Owner:** Rob Simm, GenerationHealth.me

---

## What PlanMatch Is

A single-user internal Medicare Advantage quoting tool used by Rob Simm (licensed NC broker, NPN #10447418) during live phone calls with Medicare beneficiaries. It is **not** a public-facing app — no SEO, no SSR, no multi-user auth. One broker, one session at a time.

PlanMatch handles:
- Medication lookup (RxNorm API) + formulary cross-reference
- Provider search (NPI registry + FHIR network verification)
- Benefit filtering across 22+ D-SNP plans
- Side-by-side plan comparison and quote delivery
- Annual review mode with current plan vs. 2027 finalists
- Plan ID (H-number) lookup from CMS plan data
- **Photo capture** — Rob texts Dorothy a link, she photographs her medication bottles, Claude Vision reads every label and auto-populates meds + prescribing doctors in real time
- CMS compliance checklist (16 items, 3 verbatim disclaimers)
- SunFire Matrix enrollment gate
- AgentBase CRM session sync (posts session on close, Rob approves)
- Night/day theme toggle
- Session notepad with 10-point quick-add system

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vite + React 18 + TypeScript | SPA — no SSR needed, fast dev loop |
| Styling | Tailwind CSS | Utility-first, consistent with existing GH tools |
| Fonts | Lora (headings) + Source Sans 3 (body) | Matches GH brand |
| API layer | Vercel serverless functions (`/api` folder) | Handles Twilio + Claude Vision without exposing keys |
| Database | Supabase | Same project as AgentBase CRM (`wyyasqvouvdcovttzfnv`) |
| File storage | Vercel Blob | Photo capture session payloads |
| SMS | Twilio | Send capture link to client — number (828) 761-3326 |
| AI | Anthropic Claude Vision (`claude-sonnet-4-20250514`) | Reads medication labels |
| Hosting | Vercel | Auto-deploy on GitHub push |
| Repo | `robert9907/planmatch` | New repo, separate from AgentBase |

---

## Project Structure

```
planmatch/
├── public/
│   └── favicon.ico
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css                    # CSS variables, base styles
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Topbar.tsx           # Logo, client chip, theme toggle, notes button
│   │   │   ├── Sidebar.tsx          # Workflow nav, progress bar, session info
│   │   │   ├── TabColumn.tsx        # 30px notepad tab column
│   │   │   └── NotepadPanel.tsx     # Sliding notepad, 10-point quick add
│   │   ├── app-data/
│   │   │   └── ApplicationDataPanel.tsx  # Masked fields, copy buttons, 3 copy formats
│   │   ├── steps/
│   │   │   ├── Step1ClientLookup.tsx
│   │   │   ├── Step2Intake.tsx
│   │   │   ├── Step3Medications.tsx      # RxNorm search + photo capture
│   │   │   ├── Step4Providers.tsx        # NPI + FHIR + photo capture
│   │   │   ├── Step5BenefitFilters.tsx   # 8-benefit toggles, funnel strip
│   │   │   └── Step6QuoteDelivery.tsx    # Mode toggle, new quote + annual review
│   │   ├── capture/
│   │   │   ├── CaptureButton.tsx         # "Send photo capture link" button
│   │   │   ├── CapturePanel.tsx          # Live sync panel (waiting → incoming → approved)
│   │   │   ├── IncomingCard.tsx          # Individual incoming item with approve/reject
│   │   │   └── CaptureSessionContext.tsx # Session state, polling logic
│   │   ├── annual-review/
│   │   │   ├── MethodSelector.tsx        # CMS import vs H-number lookup cards
│   │   │   ├── PlanIdLookup.tsx          # H-number search, found, not-found, manual entry
│   │   │   ├── StayVsSwitchBanner.tsx
│   │   │   ├── PremiumStrip.tsx
│   │   │   ├── KeyChangesPanel.tsx
│   │   │   └── DeltaComparisonTable.tsx
│   │   ├── compliance/
│   │   │   ├── ComplianceChecklist.tsx   # 16-item checklist, progress bar
│   │   │   ├── DisclaimerCard.tsx        # Expandable verbatim disclaimer cards
│   │   │   └── ComplianceItem.tsx        # Individual checkable item
│   │   └── quote/
│   │       ├── SideBySideTable.tsx
│   │       ├── ClientDeliveryCard.tsx    # Client-facing plan card
│   │       ├── BrokerActions.tsx         # Send/Enroll/Email buttons
│   │       └── EnrollConfirmPanel.tsx    # SunFire Matrix gate
│   ├── lib/
│   │   ├── session.ts               # Session state management (Zustand)
│   │   ├── theme.ts                 # Dark/light mode
│   │   ├── rxnorm.ts                # RxNorm API client
│   │   ├── npi.ts                   # NPI registry API client
│   │   ├── fhir.ts                  # FHIR carrier directory clients
│   │   ├── cmsPlans.ts              # CMS plan data lookup (H-number)
│   │   └── agentbase.ts             # AgentBase CRM API client
│   ├── types/
│   │   ├── session.ts               # Session, Client, Medication, Provider types
│   │   ├── plans.ts                 # Plan, Benefit, Formulary types
│   │   └── capture.ts               # CaptureSession, ExtractedLabel types
│   └── hooks/
│       ├── useCaptureSession.ts     # Polling + incoming item state
│       ├── useTheme.ts
│       └── useSession.ts
├── api/
│   ├── capture-start.ts             # Generate session token, send Twilio SMS
│   ├── capture-submit.ts            # Dorothy's phone POSTs photos here
│   ├── capture-poll.ts              # Rob's PlanMatch polls this every 2s
│   └── vision-extract.ts            # Calls Claude Vision, returns structured JSON
├── capture/                         # Dorothy's mobile page (separate Vite entry)
│   ├── index.html
│   └── src/
│       ├── capture-main.tsx
│       └── CaptureApp.tsx           # Welcome → Camera → Preview → Done
├── vercel.json
├── vite.config.ts
├── tailwind.config.ts
└── .env.example
```

---

## Environment Variables

```env
# Anthropic
ANTHROPIC_API_KEY=

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=+18287613326

# Supabase
SUPABASE_URL=https://wyyasqvouvdcovttzfnv.supabase.co
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Vercel Blob
BLOB_READ_WRITE_TOKEN=

# AgentBase
AGENTBASE_API_URL=https://agentbase-crm.vercel.app/api

# App
VITE_APP_URL=https://planmatch.vercel.app
```

---

## Phase 1 — Foundation (Week 1)

**Goal:** Shell running on Vercel with routing, theme, layout, and session state.

### Tasks
1. `npm create vite@latest planmatch -- --template react-ts`
2. Install: Tailwind, Zustand, React Query, @anthropic-ai/sdk, @supabase/supabase-js, twilio
3. Set up `vercel.json` with `/api` serverless functions and `/capture` route
4. Build `Topbar`, `Sidebar`, `TabColumn` layout shell
5. Implement `useTheme` hook — CSS variable swap for dark/light, toggle persists to localStorage
6. Implement `useSession` with Zustand — client data, meds, providers, notes, mode
7. Build `NotepadPanel` with 10-point quick-add system and note types
8. Deploy to Vercel, confirm auto-deploy from GitHub push

### CSS Variables (copy exactly from prototype)
```css
:root {
  --sage: #4E7D63; --sl: #EBF3EE; --sm: #B8D8C4;
  --warm: #F7F3EE; --wh: #fff; --w2: #EDE8E1; --w3: #DDD8CF;
  --ink: #2A2720; --i2: #5C574F; --i3: #9A9389;
  --blue: #2C5F9E; --bt: #EEF3FA;
  --amb: #9A6B1A; --at: #FDF3E3;
  --red: #9A2C2C; --rt: #FCEAEA;
  --pur: #5A3D8C; --pt: #F0EBF8;
  --teal: #0F6E56; --tl: #E1F5EE;
  --enroll: #2D8B55;
  --navy: #0A4A5C; --nvlt: #E8F5FA; --nvbd: #B5D8E8;
}
.dark {
  --warm: #1A1714; --wh: #242220; --w2: #3A3834; --w3: #4A4844;
  --ink: #E8E4DE; --i2: #B8B4AE; --i3: #6A6660;
  --sl: #162A1E; --sm: #2A4A34; --bt: #0E1828; --at: #22180A;
  --rt: #2A1010; --pt: #1A1430; --tl: #0A2018;
  --nvlt: #0A1E28; --nvbd: #1A3840;
}
```

---

## Phase 2 — Data Layer (Week 2)

**Goal:** All external APIs integrated, CMS plan data loaded, formulary cross-reference working.

### Tasks
1. **RxNorm API** (`lib/rxnorm.ts`)
   - `searchDrug(query: string)` → `{rxcui, name, synonym}`
   - Base URL: `https://rxnav.nlm.nih.gov/REST`
   - No auth required

2. **NPI Registry API** (`lib/npi.ts`)
   - `searchProvider(name: string)` → `{npi, name, specialty, address, phone}`
   - Base URL: `https://npiregistry.cms.hhs.gov/api`
   - No auth required

3. **FHIR carrier directories** (`lib/fhir.ts`)
   - UHC: `https://directoryapi.uhc.com/`
   - Humana: `https://fhir.humana.com/`
   - Aetna: `https://fhir.aetna.com/`
   - `checkNetwork(npi: string, planId: string)` → `{listed: boolean}`

4. **CMS Plan data** (`lib/cmsPlans.ts`)
   - Download CY2026 landscape files for NC, TX, GA from CMS.gov
   - Parse into Supabase table `plans` (contract_id, plan_id, carrier, plan_name, county, benefits JSON)
   - `lookupByHNumber(h: string)` → `Plan | null`

5. **Supabase schema** — create tables:
   - `plans` — CMS plan data
   - `formulary` — drug × plan tier mapping
   - `capture_sessions` — photo capture session tokens + payloads

---

## Phase 3 — Photo Capture System (Week 3) ⚡ Priority feature

**Goal:** Rob sends a link, Dorothy photographs her bottles, meds + providers auto-populate in real time.

### Architecture

```
Rob clicks "Send capture link"
  → POST /api/capture-start
    → Generate session token (UUID)
    → Store in Supabase capture_sessions {token, status: 'waiting', created_at}
    → Send Twilio SMS to Dorothy: "Hi Dorothy! Rob Simm asked you to photograph your medications..."
    → Return {token, link: `${APP_URL}/capture/${token}`}
  → PlanMatch shows waiting state, begins polling /api/capture-poll?token=xxx every 2s

Dorothy opens link on phone → CaptureApp loads
  → Welcome screen → Open camera
  → Takes photo (one bottle or full bowl)
  → Preview screen shows photo
  → POST /api/capture-submit {token, imageBase64, mimeType}
    → Store image in Vercel Blob
    → Call /api/vision-extract with image
      → Claude Vision API call with structured prompt
      → Returns ExtractedLabel JSON
    → Append to capture_sessions.payload[]
    → Update status: 'has_results'
  → Dorothy sees "Sent to Rob ✓"

Rob's PlanMatch polls /api/capture-poll?token=xxx
  → Returns new items since last poll
  → Each item appears as IncomingCard with approve/reject
  → Approve → adds to session meds/providers
  → Prescribing physician auto-extracted → seeds provider search
```

### Claude Vision Prompt (use verbatim)

```
You are reading a medication bottle label or prescription printout.
Extract the following fields and return ONLY valid JSON, no markdown, no explanation.

{
  "type": "medication",
  "drug_name": "exact name from label",
  "strength": "e.g. 500mg",
  "form": "tablet|capsule|liquid|injection",
  "dosage_instructions": "exact instructions from label",
  "prescribing_physician": "full name and credentials if present",
  "pharmacy_name": "pharmacy name if present",
  "pharmacy_phone": "pharmacy phone if present",
  "refills_remaining": "number or null",
  "last_filled": "date string or null",
  "ndc_code": "NDC code if present or null",
  "confidence": "high|medium|low"
}

If multiple labels are visible, return an array of these objects.
If this is a provider business card instead of a medication label, return:
{
  "type": "provider",
  "provider_name": "full name",
  "credentials": "MD|DO|NP|PA etc",
  "specialty": "specialty if present",
  "practice_name": "practice name if present",
  "phone": "phone if present",
  "address": "address if present",
  "accepting_new_patients": true|false|null
}
```

### Dorothy's Mobile Page (`/capture/[token]`)

4 screens — keep it dead simple:
1. **Welcome** — "Hi [Name]! Rob asked you to photograph your medications." → Open camera button
2. **Camera** — Viewfinder with mode toggle (one bottle / full bowl) + shutter button
3. **Preview + extracted data** — Shows what Claude read, confirm + send to Rob button, + Add another button
4. **Done** — "All done! Rob can see your medications." → List of what was sent

Design requirements for Dorothy's page:
- Mobile-first, 390px viewport
- Large touch targets (min 44px)
- Source Sans 3 font (loaded from Google Fonts)
- Sage green primary, purple accents
- No login, no password — token in URL is the auth
- Works on iOS Safari and Android Chrome
- Camera: use `<input type="file" accept="image/*" capture="environment">` for max compatibility

---

## Phase 4 — Core Steps (Weeks 4–6)

Build Steps 1–6 in order. The PlanMatch v2 prototype widget in the Claude chat session is the exact visual reference for every component — match it pixel-for-pixel.

### Step 3: Medications
- RxNorm command bar (search as you type, 300ms debounce)
- Results list with tier badge
- Added drugs list with formulary status per plan
- Photo capture button + CapturePanel (Phase 3)

### Step 4: Providers
- NPI search command bar
- FHIR network check per finalist plan (run in background after search)
- Verification card per provider (network status + manual confirmation checkbox)
- Photo capture for provider cards + insurance cards
- Auto-populated providers from medication label extractions

### Step 5: Benefit Filters
- 8 benefit categories: Dental, Vision, Hearing, Transportation, OTC, Food card, Diabetic supplies, Fitness
- Each has master toggle (on = hard elimination filter) + sub-toggles + tier buttons
- Funnel strip: 22 plans → providers ✓ → Rx ✓ → N finalists (live count)
- Cut tags: eliminated plans with specific reason

### Step 6: Quote & Delivery
- Mode toggle: New quote | Annual review 2027
- **New quote:** side-by-side comparison table, client delivery card, broker action buttons
- **Annual review:** CMS import + H-number plan ID lookup with found/not-found/manual states, Stay vs Switch banner, premium strip, key changes panel, delta comparison table

---

## Phase 5 — Compliance + Enrollment (Week 7)

### CMS Compliance Checklist
- 16 items total, progress bar in checklist header
- 3 required disclaimers (expandable, verbatim read-aloud text, confirm button)
- 13 discussion topic checkboxes across 6 sections
- 2 items flagged "New 2026": LIS/MSP discussion, Medigap GI rights
- Enroll Now button **blocked** until all 16 checked

### TPMO Disclaimer (verbatim, required within first minute)
> "We do not offer every plan available in your area. Currently we represent [N organizations and N plans] in your area. Please contact Medicare.gov, 1-800-MEDICARE (TTY: 1-877-486-2048) 24 hours a day, 7 days a week, or your local State Health Insurance Program (SHIP) to get information on all of your options."

### Call Recording Notice (verbatim)
> "This call may be recorded for quality assurance and compliance purposes. By continuing this call, you acknowledge that it may be recorded."

### SOA Confirmation (verbatim)
> "Before we begin, I want to confirm the types of products we agreed to discuss today. You've agreed to discuss Medicare Advantage plans, specifically Dual Special Needs Plans (D-SNP). Is that correct?"

### SunFire Matrix Deep Link
```
https://www.sunfirematrix.com/app/consumer/medicareadvocates/10447418/#/
```
Opens in new tab when Rob clicks "Open SunFire Matrix →".

---

## Phase 6 — AgentBase Sync (Week 8)

### New AgentBase endpoint needed
`POST /api/planmatch-session` in the AgentBase CRM repo (`robert9907/agentbase-crm`)

Payload:
```typescript
{
  client: { name, phone, dob, zip, county, plan_type, medicaid_confirmed },
  session: { started_at, mode, session_token },
  medications: ExtractedMedication[],
  providers: ExtractedProvider[],
  plans_compared: string[],
  recommendation: 'plan_a' | 'plan_b' | 'stay' | null,
  compliance: { items_checked: number, total: number, disclaimers_confirmed: boolean },
  notes: SessionNote[],
  status: 'pending'
}
```

AgentBase shows flashing amber "PlanMatch session pending" button in header. Rob approves → saves to client record.

---

## Key Business Constants (never change these)

```typescript
export const BROKER = {
  name: 'Rob Simm',
  license: 'NC #10447418',
  npn: '10447418',
  phone: '(828) 761-3326',
  email: 'robert@generationhealth.me',
  calendly: 'calendly.com/robert-generationhealth/new-meeting',
  sunfire: 'https://www.sunfirematrix.com/app/consumer/medicareadvocates/10447418/#/',
  address: '2731 Meridian Pkwy, Durham NC 27713',
  states: ['NC', 'TX', 'GA'],
};
```

---

## 2026 Medicare Figures (CMS confirmed — hardcode these)

```typescript
export const MEDICARE_2026 = {
  partB_premium: 202.90,
  partB_deductible: 283,
  partA_deductible: 1736,
  partD_oop_cap: 2100,
  ma_oop_max: 9350,
  insulin_cap: 35,
  hd_plan_g_deductible: 2870,
  msp_income_limit: 1816,      // per month
  lis_income_limit: 22590,     // per year
};
```

---

## Hard Rules

- **Phone number is (828) 761-3326** — never 3324, never any other number
- **License is NC #10447418** — appears in every client delivery card and disclaimer
- **CTA language:** "Talk to Rob" or "Let's figure out what's right for you" — never "Get a Free Quote"
- **Dark mode** must be complete — every surface, every panel, every badge responds to `.dark` on `<body>`
- **All figures must be 2026 vintage** — never use 2025 values
- Compliance checklist verbatim text is fixed — never paraphrase
- Dorothy's capture page must work without any login — token in URL is the only auth
- Photo sessions expire after 24 hours — delete from Supabase and Vercel Blob

---

## First Claude Code Session Prompt

Paste this to start the first session:

```
I'm building PlanMatch — a Vite + React + TypeScript Medicare Advantage quoting tool for a solo insurance broker.

Repository: robert9907/planmatch (create if it doesn't exist)
Reference doc: PlanMatch_ClaudeCode_Kickoff.md (attached or in repo root)

Start with Phase 1 — Foundation:
1. Scaffold with: npm create vite@latest planmatch -- --template react-ts
2. Install Tailwind CSS, Zustand, React Query, @anthropic-ai/sdk, @supabase/supabase-js
3. Set up vercel.json for /api serverless functions
4. Build the Topbar, Sidebar, TabColumn shell layout using the CSS variables in the brief
5. Implement useTheme hook with dark/light mode persisted to localStorage
6. Implement useSession with Zustand covering client, meds, providers, notes, mode
7. Build NotepadPanel — sliding 310px panel from right, 7-point quick-add system
8. Deploy to Vercel and confirm auto-deploy

Do not build Step components yet — foundation and layout only.
Match the color system exactly — CSS variables are defined in the brief.
The Topbar contains: logo, "PlanMatch · Medicare Advantage" label, state pills (NC/TX/GA), notes button with count badge, client chip, night/day toggle.
```

---

## Reference

- **Full UI prototype:** PlanMatch v2 widget in the GenerationHealth Claude chat project (April 2026)
- **AgentBase CRM repo:** `robert9907/agentbase-crm` (Supabase + Twilio patterns to reference)
- **Command Center v2:** `robert9907/gh-command-center-v2` (Vercel deploy pattern to reference)
- **Existing Supabase project:** `wyyasqvouvdcovttzfnv`
- **Existing Twilio phone:** (828) 761-3326 | TwiML App SID: `AP76b408ab9c23b9ef4a68ebaf641ad3be`
