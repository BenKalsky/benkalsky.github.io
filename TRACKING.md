# Tracking Plan — benkalsky.co.il

**Tools:** GTM `GTM-PXVVP37` → GA4 `G-Z3NYH9CH0F` · **Owner:** Ben Kalsky · **Last updated:** 2026-08-01

Consent: Google Consent Mode v2, all storage denied by default; `analytics_storage` granted only after the cookie banner is accepted (choice stored in `localStorage['bk-consent']`, revocable via the footer "הגדרות עוגיות" link). Events still push to the dataLayer regardless — GA4 handles them per consent state (cookieless pings or drop).

## Events

| Event | Convention | Properties | Trigger | Decision it informs |
|---|---|---|---|---|
| `generate_lead` | GA4 recommended | `method: "contact_form"` | Contact form POST returns 200 (success message shown) | Is the form earning its place; lead volume per traffic source |
| `whatsapp_click` | object_action | `cta_location: header \| hero \| float \| contact \| other` | Click on any `wa.me` link | Which placement drives WhatsApp conversations; float vs inline |
| `schedule_click` | object_action | `cta_location: header \| hero \| contact \| other` | Click on any `digitizer.li/schedule` link | Which CTA placement drives audit bookings; form vs meeting preference |

No personal data enters any event — no form values, no phone numbers, no free text. `cta_location` comes from a static `data-cta-loc` attribute.

## GTM setup (one-time, in the GTM UI)

1. **Variables:** two Data Layer Variables — `cta_location` (DLV name `cta_location`) and `method` (DLV name `method`).
2. **Trigger:** Custom Event, name `conv-events`, event name `generate_lead|whatsapp_click|schedule_click`, ✅ "Use regex matching".
3. **Tag:** GA4 Event, measurement ID `G-Z3NYH9CH0F`, Event Name `{{Event}}`, parameters `cta_location = {{cta_location}}` and `method = {{method}}`, trigger `conv-events`.
4. **GA4 → Admin → Key events:** mark `generate_lead`, `whatsapp_click`, `schedule_click` as key events (counting: once per session).
5. Optional: register `cta_location` as a custom dimension (event scope) in GA4.

## Validation checklist

- [ ] GTM Preview: each event fires once per action, `cta_location` populated
- [ ] GA4 DebugView shows all three events with parameters
- [ ] No duplicate events on double-click / re-submit
- [ ] Mobile Safari + Chrome checked
- [ ] Events absent from GA4 reports when consent declined (expected — cookieless)

## UTM log

Campaign links use lowercase UTMs, documented here before use. None yet.
