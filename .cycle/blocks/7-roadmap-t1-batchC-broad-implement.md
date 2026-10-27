---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings) — closes three Known Open Issues follow-ons (Batch 11: email attachments stored but never sent; Batch 11: a failed email has no Retry and the Emails list doesn't show its error; Per-sistant POST /api/ai/review-summary answering 500 without a key — the e2e KNOWN_GAPS entry)
New capabilities (G/ST): Roadmap T1.5 Batch C —
  C1 an email's stored attachments go out with it (Send Now and the scheduler); a missing file or a total over 20MB fails the send with the reason instead of sending without them
  C2 a failed email shows "Not sent: <error>" in the Emails list with a Retry (single-flight, data-e2e-skip)
  C3 the model-calling AI routes answer 501 { error, ai_unavailable } without ANTHROPIC_API_KEY; the Review page skips its AI calls when AI isn't available
Files modified: apps/per-sistant/routes/attachments.js, apps/per-sistant/routes/emails.js, apps/per-sistant/server.js, apps/per-sistant/pages/emails.js, apps/per-sistant/routes/ai.js, apps/per-sistant/pages/review.js, e2e/pages.spec.js, apps/per-sistant/tests/roadmap-t1-batchc.test.js (new), tests/contract/persistent-batchc.contract.test.js (new)

CHANGES:
C1 | apps/per-sistant/routes/attachments.js | loadEmailAttachments(pool, emailId, { maxBytes = MAX_EMAIL_ATTACHMENT_BYTES (20MB), dir }) → nodemailer { filename: original_name, content, contentType } for every attachment of the email in id order; a legacy row is read from the old uploads/ file when present; a missing file throws code ATTACHMENT_MISSING ("Attachment "<name>" is no longer available — remove it or upload it again, then send."), a total over the cap ATTACHMENT_TOO_LARGE; exported with the constant (after the factory export, INV-19)
C1 | apps/per-sistant/routes/emails.js | Send Now loads the attachments BEFORE its claim — an ATTACHMENT_* error is a 400 with the reason and the email stays unsent; mail.attachments set when there are any
C1 | apps/per-sistant/server.js | processScheduledEmails loads the attachments inside its try, so a refusal marks the claimed row failed with the reason (error_message) — never sent without them
C2 | apps/per-sistant/pages/emails.js | a failed row shows "Not sent: <error_message>" under the subject (var(--warn)) and a Retry button (data-e2e-skip — it sends real mail) → retryEmail: withPending(btn, 'retry-email-'+id) → writeOk(tryFetch(POST /api/emails/:id/send)) — the existing claim allows a failed row and refuses a sent one (409), so it can't double-send; a success toast without Undo, list reloaded either way
C3 | apps/per-sistant/routes/ai.js | aiUnavailable(res) → 501 { error: "AI is not configured on this server (ANTHROPIC_API_KEY is not set).", ai_unavailable: true } in draft-email, task-breakdown, parse-todo, review-summary, adjust-tone, daily-briefing and suggest-tags — after each route's own 400s (feature off, missing input, a private note), before any query or model call (they used to reach callAI's throw and answer 500, logged as a server error)
C3 | apps/per-sistant/pages/review.js | GET /api/ai/models first; the AI summary and weekly-theme calls run only when `available` (the theme used to show the "AI is not configured" answer as the week's theme)
C3 | e2e/pages.spec.js | the /per-sistant/review KNOWN_GAPS entry removed (the list is empty)
Tests | apps/per-sistant/tests/roadmap-t1-batchc.test.js (11: loadEmailAttachments — order + shape, a legacy disk file, a missing file, the size cap, none; both senders' wiring; Send Now's 400 without a claim via supertest; the Emails page's error line, Retry, single-flight, data-e2e-skip and a parsing emitted script; all seven routes' 501 with valid input, a 400 still first; the Review page gate; the e2e gap removed), tests/contract/persistent-batchc.contract.test.js (5: Send Now with two stored attachments; a missing one → 400 and still a draft; the scheduler marking it failed with the reason + the failed list; Retry after removing the attachment sends once and a second Retry is 409; review-summary 501)

TEST RESULTS: npm test 1890/1890 (11 new); contract 165/165 (5 new); Playwright 57/57 (the Review page now passes without its KNOWN_GAPS entry); no schema change. Mutation check: dropping `mail.attachments = attachments` from Send Now turns the attachment contract test red.
REGRESSION RISKS:
- An email whose stored attachment is a legacy row with no file can no longer be sent until the attachment is removed (deliberate — it used to go out without it).
- The scheduler holds all of an email's attachments (≤20MB) in memory during the send.
- With no API key the AI routes now answer 501 instead of 500; the clients only read their success fields, so they stay hidden as before. A disabled feature still answers 400 first.
INVARIANTS AT RISK: None (INV-19: the helper is attached after the factory export; INV-117: Retry goes through writeOk(tryFetch(…)); INV-129: Retry uses withPending and carries data-e2e-skip; INV-130: the e2e KNOWN_GAPS map shrank; at-most-once delivery (PS-2 / PB-4) unchanged — Retry reuses the Send Now claim)
NET SCORE: 2 production fixes (attachments never sent — YES, any email with an attachment went out without it; the review-summary 500 — YES, on every Review page load without a key) − 0 new failure modes = 2 (C2's Retry is new capability)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Per-sistant Backend / Web UI: Render auto-deploys on push to `main` (PR robinchoudhuryums/pers-fin#133).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The compose dialog doesn't list an email's attachments or warn before Send that one is missing — the refusal arrives as the send's error toast.
- Retry sends a failed SCHEDULED email immediately rather than offering to reschedule it.
- The uncapped AI features (callAI) still don't charge Per-sistant's AI cost cap (pre-existing).

DOCUMENTATION UPDATES NEEDED:
- apps/per-sistant/CLAUDE.md: Email (attachments sent by both senders, the refusal rules), File Attachments, the Emails list error + Retry, the AI routes' 501, the Review page gate, the new test file, count 545.
- CLAUDE.md: Known Open Issues (remove the Batch 11 attachments / Retry follow-on and the review-summary 500 bullet; add the Batch C follow-ons), test counts (1890 / 93 files / Per-sistant 545, contract 165) + the two test-file descriptions, the e2e KNOWN_GAPS mention.
- README: counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
