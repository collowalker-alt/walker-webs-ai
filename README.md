# Walker Webs Backend

This backend matches the updated Walker Webs frontend.

## Features

- `/api/generate` — AI website generation through Groq.
- `/api/edit` — authenticated AI website editing.
- `/api/publish` — authenticated publishing with the first 3 publishes free.
- `/api/usage` — authenticated usage counters.
- `/api/payments/submit` — USDT TRC20 payment submission.
- `/api/payments/:paymentId` — payment status.
- `/p/:publishId` — public published website.
- Firebase Admin authentication and Firestore usage/subscription storage.
- Automatic TRON USDT payment verification.

## Install

```bash
npm install
npm start
```

Node 18+ is required.

## Required environment variables

Copy `.env.example` to `.env` for local development, or add the same values in your hosting provider.

You need:

- GROQ_KEY
- FIREBASE_PROJECT_ID
- FIREBASE_CLIENT_EMAIL
- FIREBASE_PRIVATE_KEY
- TRONGRID_API_KEY
- TRC20_WALLET
- PUBLIC_URL
- ALLOWED_ORIGINS

Do not put Firebase Admin private keys or the Groq key in the frontend.

## Firebase

Create a Firebase project, enable Authentication (Email/Password), enable Firestore, and create a Firebase Web App.

For the backend, create a Firebase service account and use its project ID, client email and private key as environment variables.

## Firestore collections

The backend creates these automatically:

- `usage/{uid}`
- `subscriptions/{uid}`
- `payments/{paymentId}`
- `published/{publishId}`

## Free allowances

The backend, rather than localStorage, enforces:

- first 3 publishes free
- first 3 edits free
- paid plans after the free publishing/editing allowance

The HTML download itself is a client-side Blob download, so no download endpoint is required for the first-three-download rule. If you want download entitlement to be enforced server-side too, add a `/api/download` endpoint and make the frontend request it.

## Important

The payment wallet is:

TKRAT57UckeS15pxfkGyaxvyHmdKuupZgD

Network: TRC20

The official USDT TRC20 contract is configured by default as:

TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
