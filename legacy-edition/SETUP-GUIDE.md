# Legacy Edition — Stripe + Supabase Setup Guide

**Book:** Legacy Edition | **Price:** $149.95 | **Limit:** 190 copies  
**Stack:** Stripe (live) · Supabase (free tier) · Custom HTML/JS purchase page

---

## Overview

```
Buyer clicks "Buy Now"
      ↓
Stripe Payment Link (checkout)
      ↓
Payment succeeds → Stripe fires webhook
      ↓
Supabase Edge Function increments counter
      ↓
If counter = 190 → Stripe Payment Link deactivated
      ↓
Purchase page checks counter on load → shows SOLD OUT button
```

---

## Files in this folder

| File | Purpose |
|---|---|
| `1-supabase-setup.sql` | Run once in Supabase SQL Editor |
| `2-stripe-webhook/index.ts` | Deploy as Supabase Edge Function |
| `3-check-availability/index.ts` | Deploy as Supabase Edge Function |
| `4-purchase-page-button.html` | Paste into your purchase page |

---

## STEP 1 — Create a Supabase Account & Project

1. Go to **https://supabase.com** → click **Start your project** (free, no credit card)
2. Sign up with GitHub or email
3. Click **New project**
   - Organisation: your name or leave default
   - Project name: `legacy-edition` (or anything you like)
   - Database password: generate a strong one and **save it**
   - Region: **Sydney (ap-southeast-2)** — closest to Australia
4. Wait ~2 minutes for the project to spin up

---

## STEP 2 — Run the SQL Setup

1. In your Supabase project, click **SQL Editor** (left sidebar)
2. Click **+ New query**
3. Open `1-supabase-setup.sql` from this folder, copy the entire contents, paste it in
4. Click **Run** (or press Cmd/Ctrl + Enter)
5. You should see: *Success. No rows returned*

**Verify it worked:**  
Go to **Table Editor** → you should see a `book_sales` table with one row: `id=1, sold_count=0`

---

## STEP 3 — Create the Stripe Product & Payment Link

### 3a. Create the Product

1. Log into **https://dashboard.stripe.com** (make sure you're in **Live mode** — toggle top-left)
2. Go to **Product catalogue** → **+ Add product**
3. Fill in:
   - Name: `Legacy Edition`
   - Description: *(optional — appears on checkout page)*
   - Image: *(optional — upload book cover)*
4. Under **Pricing**:
   - Pricing model: **Standard pricing**
   - Price: `149.95`
   - Currency: `AUD` (or USD — your choice)
   - Payment type: **One time**
5. Click **Save product**

### 3b. Create the Payment Link

1. Go to **Payment Links** (left sidebar) → **+ New**
2. Select your **Legacy Edition** product, quantity: **1**
3. Under **Options**:
   - ✅ **Limit the number of times this link can be used** → set to `190`
   - This is a safety net *in addition* to your Supabase counter
4. Click **Create link**
5. **Copy the Payment Link URL** — looks like `https://buy.stripe.com/XXXXXXXX`
6. **Copy the Payment Link ID** — click the link, look at the URL bar in Stripe: it will show `plink_XXXXXXXXX`. You can also find it under the link details. You need this ID (not the URL) for the webhook function.

---

## STEP 4 — Deploy the Supabase Edge Functions

### Prerequisites: Install Supabase CLI

```bash
# macOS
brew install supabase/tap/supabase

# Windows (via Scoop)
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase

# Or via npm
npm install -g supabase
```

### 4a. Set up your project locally

```bash
# Create a new folder anywhere on your computer
mkdir legacy-edition-functions
cd legacy-edition-functions

# Initialise Supabase
supabase init

# Log in
supabase login
```

### 4b. Create the two Edge Functions

```bash
supabase functions new stripe-webhook
supabase functions new check-availability
```

This creates:
```
supabase/
  functions/
    stripe-webhook/
      index.ts
    check-availability/
      index.ts
```

Replace the contents of each `index.ts` with the code from `2-stripe-webhook/index.ts` and `3-check-availability/index.ts` in this folder.

### 4c. Link to your Supabase project

```bash
# Get your project ref from: Supabase Dashboard → Settings → General
supabase link --project-ref YOUR_PROJECT_REF
```

### 4d. Set environment secrets

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_live_XXXXXXXX
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_XXXXXXXX
supabase secrets set STRIPE_PAYMENT_LINK_ID=plink_XXXXXXXX
```

> **Note:** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set automatically — you don't need to add them.

### 4e. Deploy both functions

```bash
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy check-availability --no-verify-jwt
```

Your function URLs will be:
```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/stripe-webhook
https://YOUR_PROJECT_REF.supabase.co/functions/v1/check-availability
```

---

## STEP 5 — Register the Stripe Webhook

1. In Stripe Dashboard → **Developers** → **Webhooks** → **+ Add endpoint**
2. Endpoint URL: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/stripe-webhook`
3. Select events to listen to: `checkout.session.completed`
4. Click **Add endpoint**
5. Click the webhook you just created → **Signing secret** → **Reveal**
6. Copy the `whsec_XXXXXXXX` value
7. Run:
   ```bash
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_XXXXXXXX
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```
   *(Re-deploy so the function picks up the new secret)*

---

## STEP 6 — Add the Button to Your Purchase Page

1. Open `4-purchase-page-button.html`
2. Replace the two placeholder values at the top of the `<script>` block:
   ```js
   var AVAILABILITY_URL = "https://YOUR_PROJECT_REF.supabase.co/functions/v1/check-availability";
   var PAYMENT_LINK_URL = "https://buy.stripe.com/YOUR_PAYMENT_LINK";
   ```
3. Paste the `<div id="legacy-edition-wrap">` block where you want the button in your page
4. Paste the `<script>` block just before `</body>`
5. Optionally change the `activeStyles.background` colour to match your site's brand colour

---

## STEP 7 — Test Everything

### Test in Stripe test mode first
1. Temporarily swap to a **test** Stripe secret key and create a test payment link
2. Use Stripe's test card: `4242 4242 4242 4242`
3. Complete a checkout → check Supabase Table Editor → `sold_count` should increment to 1
4. Check the page → remaining count should update

### Go live checklist
- [ ] Stripe keys are live (`sk_live_...`)
- [ ] Payment Link is live and max redemptions = 190
- [ ] Webhook endpoint is registered with `checkout.session.completed`
- [ ] Both Edge Functions deployed with correct secrets
- [ ] Purchase page button URLs updated and working

---

## How the SOLD OUT state works

When `sold_count` reaches **190**:
1. The webhook function calls Stripe to **deactivate** the Payment Link (belts)
2. The `check-availability` function returns `{ available: false }` (suspenders)
3. The purchase page button becomes **grey** and reads **SOLD OUT**

If somehow a buyer reaches the Stripe checkout with an old URL, Stripe will reject it because the link is deactivated.

---

## Monitoring

- **Sales count:** Supabase → Table Editor → `book_sales`
- **Webhook events:** Stripe Dashboard → Developers → Webhooks → your endpoint → Event logs
- **Function logs:** Supabase → Edge Functions → your function → Logs

---

## Supabase Free Tier Limits (as of 2025)

| Resource | Free limit | Your usage |
|---|---|---|
| Edge Function invocations | 500,000/month | Minimal |
| Database size | 500 MB | ~1 KB |
| Bandwidth | 5 GB/month | Negligible |

You will not exceed free tier limits for this use case.
