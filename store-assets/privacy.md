# 小验子 / XAuthZee — Privacy Policy

Last updated: 2026-07-31

## Overview

XAuthZee (小验子) is a browser extension that stores Time-based One-Time
Password (TOTP) authenticator accounts locally in your browser. It is
designed so that **all data stays on your device** and is synced through
your browser's built-in sync infrastructure (Chrome Sync / Microsoft
Account sync). The extension does not communicate with any external
server operated by the developer.

## Single Purpose

The single purpose of this extension is to manage TOTP authenticator
codes: store account metadata, generate the time-based one-time code,
and paste that code into a website's verification input.

## Data We Store

The extension stores the following on your device, in the browser's
local storage and (optionally) synced via your browser account:

- **Account metadata you provide**: issuer, label, secret (the Base32
  TOTP seed), algorithm, digit count, period, list of bound hostnames,
  creation timestamp.
- **Encryption state (optional)**: if you enable a master password, a
  verifier ciphertext, KDF salt + iteration count, and a session-only
  derived key (session storage is cleared when the browser closes).
- **Preferences**: floating panel enable/disable, broad detection
  toggle, list of disabled hostnames, auto-lock timeout.

We **do not** collect, transmit, sell, or share any of this data with
the developer or with any third party.

## Permissions and Why

| Permission   | Why we need it                                                                 |
| ------------ | ------------------------------------------------------------------------------- |
| `storage`    | Read/write `chrome.storage.sync` to persist accounts and preferences.           |
| `activeTab`  | Read the URL of the current tab to bind a host and to capture a QR screenshot.  |
| `scripting`  | Inject the QR region-selector content script on demand.                         |
| `alarms`     | Schedule the master-password auto-lock timer.                                   |
| `idle`       | Detect when the operating system is locked, to immediately lock the extension.   |

We request `activeTab` (not `<all_urls>` host permission) so the
extension only runs when the user explicitly clicks the toolbar icon or
the scan button.

## What We Do Not Do

- We do not collect analytics, telemetry, or crash reports.
- We do not contact any server operated by the developer.
- We do not include any third-party analytics, advertising, or
  tracking SDKs.
- We do not execute remote code at runtime; all bundled JavaScript is
  included in the published package and signed by the store.
- We do not sell, rent, or share any data with any party.

## Data Sharing

No data leaves your device except through your browser's own sync
mechanism, which is governed by the browser vendor's terms (Google for
Chrome sync, Microsoft for Microsoft Account sync). The extension does
not initiate, observe, or modify that sync traffic.

## Children

This extension is not directed to children under 13, and we do not
knowingly collect any data from children.

## Changes

If this policy changes, the new version will be dated at the top and
the changes will be summarized here. For material changes, the next
release of the extension will include a brief in-product notice.

## Contact

For privacy questions, contact: `xauthzee at example.com`
(replace `example.com` with the address in the live store listing).
