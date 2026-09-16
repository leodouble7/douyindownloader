# Media Security Lab UX contract

## Authority

| Business rule | Authoritative source | UI consequence |
|---|---|---|
| Authorization, one-page scope, no DRM bypass | `docs/superpowers/specs/2026-09-15-media-security-lab-design.md` sections 2, 5 | Explicit authorization checkbox; scope copy; encrypted tracks unavailable for download |
| Full retrieval needs explicit initiation | Same specification, section 5.4 | Mode selection alone never starts full download; separate workbench button |
| Sanitized evidence and local persistence | Same specification, sections 8–9; `src/main/reports/report-bundle.ts` | History reopens sanitized records; disk reports never regain live trust after restart |
| Concurrency maximum 4 | `src/shared/schemas.ts` | Native 1–4 selector; main-side enforcement |
| Cancellation preserves evidence | Same specification, section 9 | Persistent cancelled status, no deletion confirmation |

## Canonical UI resolution

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Form | `src/renderer/components/NewRunForm.tsx` | shared Zod schema and this contract | masked URL, authorization, output directory | unit + browser QA |
| Select/Listbox | native select in NewRunForm and MediaTracks | DESIGN.md | OS popup accepted; single select | keyboard + browser QA |
| Scrollbar | `src/renderer/styles.css` global baseline | DESIGN.md | geometry-only stable gutters | computed browser style |
| Toast | App reserved status band | this contract | info / error with retry | browser error and loading evidence |
| CRUD | App run command helper and WorkbenchService | domain specification | start / cancel / inspect / export | real service integration + UI QA |
| Table Selection | MediaTracks controlled checkboxes | selected asset and shared DTO | maximum two tracks from one asset | main gate + browser selection |

## Flow ledger

Create: new run → validate fields → busy → live workbench → status message. Failure preserves draft and focuses an invalid field. New-run remains mounted during history navigation. Source: specification sections 5.1 and 7.1.

Observe: isolated preview → explicit stop or bounded observation timer → bounded probes → standard report, or full-download ready state. Source: specification sections 5.2–5.4.

Download: ready → explicit click with selected tracks → progress → verified artifacts or partial evidence → report. Source: specification section 5.5. No optimistic completion.

Cancel: active run → immediate abort → cancelled record → available history. Routine cancellation is reversible by starting a new run and does not delete evidence, so there is no additional modal confirmation.

Inspect history: local index → 20-row page → result → evidence link → live-style read-only timeline. Original report trust is intentionally unavailable after restart. Source: report-bundle verifier contract.

Export: main revalidates original report object and chosen directory → returns verified content and already-published local path → stable status band reports location. No raw path from the target or renderer can authorize file access.

## Async and accessibility

Commands share a duplicate-submit guard and stable typed error copy. Snapshot reads ignore superseded responses. Periodic refresh retains the last valid evidence during temporary failure. Evidence is deduplicated by ID and sorted by sequence; terminal states win over late progress.

Buttons, labels, native radio/checkbox/select semantics, visible focus and a skip link are required. Progress and global feedback use aria-live. All screen titles are Chinese and document.title follows navigation. Local timezone is stated in the footer. Render all external text through React text nodes, never HTML.

The renderer is PRODUCT. The untrusted WebContentsView has no preload or IPC and is hidden outside the visible aperture and on view changes. No modal/popover is layered over it. Native selects occur outside its bounds.
