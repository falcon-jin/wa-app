# 5sim WhatsApp Registration Debug Integration Design

Date: 2026-07-07

## Context

`wa-app` already has a dashboard-only registration debug flow:

- The React dashboard card `WaAccountAdd` accepts a phone number and country calling code.
- The dashboard BFF exposes `/api/wa/phone/sms-probe` for SMS availability probing.
- The dashboard BFF exposes `/api/wa/register` to request a WA verification code.
- The existing OTP submit path uses `/api/wa/actions/registration/resume-otp`.

This feature adds a 5sim-assisted debug path that buys a WhatsApp activation number, starts the existing WA registration debug flow, polls 5sim for the SMS OTP, and submits the OTP through the existing dashboard action.

The project boundary still applies: proto remains the WA application contract source of truth and must not expose supplier-specific endpoints, database tables, Redis keys, proxy URLs, or token details. 5sim is an implementation detail of the dashboard debug layer.

## Selected Approach

Use a dashboard-only 5sim adapter and keep the existing manual registration flow intact.

The service adds private HTTP endpoints under `/api/wa/debug/5sim/*`. These endpoints are served by the dashboard BFF, not by gRPC/proto. The frontend can list WhatsApp-capable countries/operators, buy one number within a selected price/count range, poll the order for an SMS code, and close or cancel the order.

The dashboard then reuses the current WA registration path:

1. Load 5sim WhatsApp inventory.
2. User selects country, operator/channel, and price/count filters.
3. Dashboard calls the BFF to buy a 5sim activation number for product `whatsapp`.
4. Bought number is normalized through the same existing phone parsing path.
5. Dashboard runs the existing SMS probe and registration request.
6. When the existing WA flow reaches OTP waiting, dashboard polls the 5sim order.
7. On first code, dashboard calls the existing OTP submit action.
8. If OTP submit succeeds, dashboard calls 5sim finish.
9. If the user cancels or the poll times out before an OTP arrives, dashboard calls 5sim cancel.

This keeps 5sim isolated from the core registration model and avoids duplicating the existing registration state machine.

## External 5sim Calls

Use the public 5sim API documented at `https://5sim.net/docs`.

Planned calls:

- Inventory: `GET https://5sim.net/v1/guest/prices?product=whatsapp`
- Buy activation: `GET https://5sim.net/v1/user/buy/activation/{country}/{operator}/whatsapp`
- Check order: `GET https://5sim.net/v1/user/check/{id}`
- Finish order: `GET https://5sim.net/v1/user/finish/{id}`
- Cancel order: `GET https://5sim.net/v1/user/cancel/{id}`
- Optional manual bad-number action: `GET https://5sim.net/v1/user/ban/{id}`

Authenticated calls use `Authorization: Bearer $token` and `Accept: application/json`.

## Configuration

Add service-side environment variables:

- `WA_APP_5SIM_TOKEN`: 5sim API token. If empty, all 5sim debug endpoints return `configured: false` and the UI disables the panel.
- `WA_APP_5SIM_API_BASE_URL`: optional override for tests; defaults to `https://5sim.net`.

The token must never be returned to the frontend, written to logs, stored in proto records, or persisted in account data.

## Backend Components

Add a small package or BFF module for 5sim:

- `FiveSimClient`: wraps HTTP calls, base URL, token, timeout, and response decoding.
- `FiveSimInventory`: normalized view of WhatsApp country/operator inventory with `country`, `operator`, `cost`, `count`, and optional rate fields.
- `FiveSimOrder`: normalized order view with `id`, `phone`, `country`, `operator`, `product`, `price`, `status`, `expires`, and redacted SMS metadata.
- `FiveSimSMS`: internal representation with `code` and text, but API responses should only expose the code when the frontend explicitly checks an active order.

Dashboard endpoints:

- `GET /api/wa/debug/5sim/status`
  - Returns whether token is configured.
- `GET /api/wa/debug/5sim/whatsapp-inventory`
  - Returns sorted WhatsApp country/operator inventory from guest prices.
- `POST /api/wa/debug/5sim/orders`
  - Request body: country, operator, optional max price.
  - Buys a WhatsApp activation and returns the normalized order plus parsed phone fields.
- `GET /api/wa/debug/5sim/orders/{id}`
  - Checks current order status and SMS list.
- `POST /api/wa/debug/5sim/orders/{id}/finish`
  - Finishes an order after successful OTP submit.
- `POST /api/wa/debug/5sim/orders/{id}/cancel`
  - Cancels an unused order.
- `POST /api/wa/debug/5sim/orders/{id}/ban`
  - Optional manual action for numbers that cannot receive a usable OTP.

Request validation:

- Country and operator are path-safe slugs from inventory only.
- Product is fixed to `whatsapp` server-side.
- Order id must be numeric.
- Max price, if provided, is enforced before buying based on fresh inventory.

Logging:

- Log operation name, order id, country, operator, status, count, cost, and phone hash.
- Do not log token, SMS text, OTP code, raw response bodies containing SMS, or full phone number.

## Frontend Components

Add a compact 5sim debug panel inside `WaAccountAdd` above the manual phone fields or as a collapsible section.

Controls:

- Enable status badge based on `/api/wa/debug/5sim/status`.
- Country select populated from WhatsApp inventory.
- Operator/channel select populated from the selected country.
- Optional min count and max price inputs.
- "Get number" button.
- Order status row showing order id, country/operator, count/cost snapshot, WA registration stage, and poll state.
- Cancel button while waiting.

Flow behavior:

- Buying a number fills `countryCallingCode` and `phone` using the normalized phone result from the BFF.
- After buy, the UI automatically calls the existing probe path.
- If probe allows SMS, the UI automatically starts the existing SMS registration path.
- After registration returns `wa_account_id` and `verification_request_id`, the UI polls the 5sim order every 5 seconds for up to a bounded timeout.
- When a code appears, the UI sets the OTP state and calls the existing `submitWaRegistrationOTP` helper.
- On submit success, the UI calls finish and refreshes accounts.
- On submit failure, the UI keeps the order visible and lets the user retry/cancel/ban.

The manual phone input, manual probe, manual channel buttons, and manual OTP card remain available.

## Error Handling

- Token missing: disable panel and show not configured.
- Inventory load failure: show retry without affecting manual registration.
- No matching inventory: disable buy and explain that the selected filter has no stock.
- Buy failure: show provider error after sanitizing sensitive fields.
- Phone normalization failure after buy: cancel the order if possible and show the validation error.
- WA probe/register failure: keep the 5sim order visible so the user can cancel or ban it.
- Poll timeout: stop polling and offer cancel.
- 5sim returns no SMS yet: continue polling until timeout.
- OTP submit failure: do not finish order automatically; keep manual controls available.
- Finish failure after successful registration: show warning, but do not roll back local WA registration state.

## Security And Data Rules

- 5sim token stays server-side.
- OTP and SMS text are sensitive. Do not log them.
- The frontend may temporarily hold the OTP because the existing debug UI already accepts manual OTP entry.
- Do not add 5sim concepts to proto messages.
- Do not persist provider order details in WA account records.
- Do not expose provider endpoint URLs in public contracts.
- Keep this feature clearly scoped to dashboard debugging and internal testing.

## Tests

Backend:

- Unit tests for inventory normalization from 5sim price JSON.
- Unit tests for order response normalization and SMS code extraction.
- `httptest` client tests for configured/unconfigured status and Authorization headers.
- BFF handler tests for path validation, missing token behavior, buy with max-price enforcement, and sanitized errors.

Frontend:

- API helper type coverage for status, inventory, buy, check, finish, cancel.
- Component/source tests for: disabled when unconfigured, filtered country/operator options, buy filling phone fields, polling stop on code, and finish after successful submit.

Verification:

- `go test ./...`
- `npm run lint` in `webui`
- Optional manual dashboard check with a test token and low-cost country/operator, only in an authorized internal test environment.

## Out Of Scope

- Persisting 5sim order history.
- Adding 5sim to proto/gRPC contracts.
- Supporting non-WhatsApp 5sim products.
- Background jobs that continue after the dashboard session is closed.
- Bypassing existing WA probe, registration, or OTP submit flows.
