# Live Voice Translation — Master Build Plan
### (Third startup — working name TBD, suggest "Duet" as a placeholder until you land on something)

**Core bet:** slang-aware, low-latency, natural-speech translation for personal video calls — a gap the enterprise interpretation players (KUDO, Wordly, Interprefy) don't cover because they're built for formal conference speech, not family Spanish with slang. That's the whole pitch. Don't drift from it.

---

## Architecture correction — read this first

Skyler's real vision is a **standalone conversation app** (phone/web, own mic + speaker), not a Google Meet integration. That's good news: no `tabCapture`, no Safari/iOS walls, no extension store review — all of that was solving a problem he doesn't actually have. Standard mic input (`getUserMedia`) + standard audio playback (`<audio>`) already routes through whatever output device is active, Bluetooth included, with zero special code. The Chrome-extension plan below (Phase 4) is now post-hackathon, not the prototype.

## 10-Day Hackathon Prototype (Sep 20–30) — this supersedes Phase 1/2 below for now

**Product, scoped down:** one shared device, two people talking near it. App auto-detects which of the two configured languages an utterance is in, translates to the other, shows both original + translated text on screen, and speaks the translation aloud. Region setting (neutral / Mexican / Peruvian / Argentinian, etc.) is a prompt parameter, not new infra — cheap to include, and it's Skyler's specific differentiator, so keep it in scope.

**Explicitly out of scope for these 10 days:** payments, accounts/auth, group/multi-speaker mode, the Chrome extension, mobile app store builds, "mirror conversation" dual-device sync. All real, all later.

**Stack (unchanged core, just no extension):**
- Mic + playback: plain web page, `getUserMedia` + `<audio>`
- ASR: AssemblyAI streaming
- Translation: one LLM call — language auto-detect + region + slang-aware translation together
- TTS: ElevenLabs Flash v2.5
- Backend: lightweight WebSocket server (Claude Code builds this)
- Hosting: Railway or Render — good enough for a demo link

**Day-by-day:**
- **Sep 20–21:** Core pipeline only, no UI. Mic → AssemblyAI → LLM (region + slang) → ElevenLabs → playback + on-screen transcript. Test against real Spanish slang audio.
- **Sep 22–24:** Wrap it in an actual mobile-responsive page — mic button, live dual-language transcript, region dropdown. Deploy to a public URL.
- **Sep 25–26:** Real conversation testing (you + a Spanish speaker). Fix latency/accuracy.
- **Sep 27:** Send the link to Skyler to test with his family.
- **Sep 28–29:** Polish from his feedback, prep the hackathon demo/writeup.
- **Sep 30:** Submit to lablab.ai.

**Same-day, doesn't block coding:** confirm Paddle's Pakistan payout support — 5 minutes, needed eventually, not needed to ship this.

---

## Start here — today, in this order

1. AssemblyAI + LLM provider API keys (if not already done)
2. Gather 10-15 real Spanish clips with genuine slang
3. Claude Code: build the pipeline script above — audio in, translated audio + text out, latency logged
4. Everything else in the day-by-day above follows from there

## Technical Implementation Guide — 10-Day Prototype

**Architecture, one line:** browser page (mic in, audio out) ↔ WebSocket ↔ your backend ↔ AssemblyAI + LLM + ElevenLabs. No Chrome extension anywhere in this.

**Folder structure — give this to Claude Code directly:**
```
/prototype
  /backend
    server.(js|py)        — WebSocket server, orchestrates the pipeline
    assemblyai_client.*   — streams mic audio to AssemblyAI, receives transcripts
    translate.*           — single LLM call: language + region + slang-aware translation
    tts_client.*          — streams translated text to ElevenLabs Flash, gets audio back
  /frontend
    index.html            — mic button, dual-language transcript panel, region dropdown
    app.js                — getUserMedia, WebSocket client, audio playback
  .env                     — API keys, never committed
```

**Pipeline, step by step:**
1. Frontend captures mic audio (`getUserMedia`), streams it to your backend over WebSocket.
2. Backend forwards the audio stream to AssemblyAI's real-time streaming endpoint.
3. On each finalized transcript segment, backend makes ONE LLM call with: the transcript, the two configured languages (English/Spanish), the region setting, and an instruction to detect which language this segment is and translate naturally into the other, handling slang. Keep the prompt short — every extra instruction is added latency.
4. Backend sends the translated text to ElevenLabs Flash v2.5 streaming TTS.
5. Backend relays three things back over the same WebSocket: original text, translated text, translated audio chunks.
6. Frontend shows both text lines in a live transcript panel and plays the audio as it arrives — a normal `<audio>`/Web Audio call, which already routes to Bluetooth/wired headphones automatically if that's the phone's active output. No special code for that part.

**Region setting:** a dropdown (Neutral / Mexican / Peruvian / Argentinian / etc.) passed straight into the LLM prompt as a variable — "translate into {region} Spanish, using regionally natural vocabulary and slang." One prompt parameter, no separate infrastructure.

**Language handling:** don't build per-language ASR switching. Transcribe normally and let the single LLM call detect which of the two configured languages a segment is in — simple because the prototype only supports English↔Spanish.

**Env vars:** `ASSEMBLYAI_API_KEY`, your LLM provider key, `ELEVENLABS_API_KEY`.

**Latency:** log a timestamp at each stage (ASR final, LLM response, TTS first byte) from day one, so if it's slow you can see exactly where, instead of guessing.

## Roadmap at a glance

| Track | What it proves / delivers |
|---|---|
| Business Foundations (parallel, ongoing) | Payments actually work, legal basics exist, go-to-market isn't a mystery |
| Phase 1 — Core Translation POC | Slang handling + latency work, text only |
| Phase 2 — Voice Output + Toggle | Spoken translation, with captions/audio/mute-original as switches |
| Phase 3 — Group Mode | Multiple speakers, each with a consistent voice |
| Phase 4 — Chrome Extension | Runs on a real Google Meet call |
| Phase 5 — Backend, Accounts, Billing | Holds multiple paying users safely |
| Phase 6 — Controlled Beta | Validated on one real user before calling it a product |
| Phase 7 — Broader Launch Readiness | Pricing, positioning, mobile explicitly deferred |

## Full tool stack, consolidated

- **Capture:** Chrome extension via `chrome.tabCapture` — desktop/Chrome only for v1 (Safari has no equivalent, iPhone is out of scope, see Phase 7)
- **Speech-to-text + diarization:** AssemblyAI — Universal-3.5 Pro Realtime streaming, plus streaming diarization for Phase 3
- **Translation:** a fast LLM (Claude or Gemini's Flash-tier) — one call combining correction + slang-aware translation, not a multi-hop chain
- **Text-to-speech:** ElevenLabs Flash v2.5 — one voice mapped per diarized speaker
- **Backend hosting:** a small VPS or a service like Railway/Fly.io running your WebSocket server — a real recurring cost, budget it separately from per-minute API costs
- **Payments:** Paddle (pending confirmed Pakistan payout support) or a US LLC + Wise Business fallback — not Stripe direct, not Lemon Squeezy, per the Business Foundations track below
- **Build tool:** Claude Code, for the pipeline scripts, backend, and extension itself
- **Legal:** ToS/Privacy Policy drafted early, plus an actual lawyer check on the consent flow once this goes beyond you and one tester

---

## Locked decisions before Phase 1 starts

- [ ] Pick the real name (don't let this block coding — placeholder it and move)
- [ ] Target user stays: personal/family video calls, not enterprise interpretation. Don't scope-creep toward B2B.
- [ ] Build the 3-way output toggle from Phase 2 onward regardless of Skyler's answer: **captions-only / +spoken translation / mute-original vs layered-audio**. This resolves both his open questions without needing a reply from him.

---

## How the work splits — you vs your AI agent

This division holds for every phase below, so it's stated once here, not repeated per phase.

**You own:**
- All API/account signups and holding the actual keys
- Every judgment call that requires human ears or eyes — does this translation sound natural, is this latency actually annoying, does this voice mapping feel right in a real conversation
- Product/business decisions (pricing, positioning, what ships in v1)
- Real-world testing — running actual test calls, gathering real Spanish slang audio
- Reviewing and approving what the agent builds before moving to the next phase

**Your AI agent (Claude Code) owns:**
- Writing and wiring all the actual code — pipeline scripts, backend, extension, integrations
- Boilerplate, tests, error handling, logging/instrumentation
- Iterating on implementation based on what you report broke or sounded wrong
- Documentation of what was built and how to run it

Rule of thumb: if it requires listening, deciding, or paying — it's you. If it's typing code — it's the agent.

---

## Parallel Track — Business Foundations (start now, alongside Phase 1, not after Phase 4)

These take real calendar weeks to resolve, so they can't be sequenced after the build — start them in parallel now.

**Payments — this needed fixing.** Stripe does not support Pakistan-registered businesses directly; using it requires a foreign entity (US LLC or UK Ltd) plus a foreign bank account (e.g. Wise Business) for payouts — real setup cost and weeks of lead time before you've made a sale. Lemon Squeezy is not a workaround — it pays out through Stripe Connect, which itself doesn't support payouts to Pakistan, so you could collect money but not withdraw it. Paddle runs its own payment rails, and there's specific reporting of Pakistan-based founders getting payouts working via Payoneer/Wise — this is the lead to chase, but confirm it directly on Paddle's own onboarding before committing; don't build the billing architecture on an unverified assumption twice.

- [ ] Confirm current Paddle payout support for Pakistan directly (not from blog posts)
- [ ] If that falls through, price out a US LLC + Wise Business as the fallback, with real setup time factored into your timeline
- [ ] Only lock Phase 5's billing architecture once this is actually confirmed

**Legal basics, drafted now, not after launch:**
- [ ] Terms of Service + Privacy Policy — needed before anyone beyond you and one tester touches this
- [ ] Explicit data retention decision: raw audio, transcripts, both, neither, and for how long — decide before the backend is built, not after
- [ ] Consent flow for the non-user party (Skyler's family) whose voice goes to third-party APIs — worth an actual legal check once this goes beyond just you two testing, given call-recording consent rules vary by jurisdiction (I'm not a lawyer — this is a flag to check, not a ruling)

**Vendor lock-in — cheap to prevent now, expensive to fix later:**
- [ ] Route ASR/LLM/TTS calls through a thin internal interface, not scattered direct SDK calls, so a pricing change, outage, or deprecation at any one provider means swapping a module, not rewriting the pipeline

**Go-to-market — the phases below build the product, not the customer base:**
- [ ] Decide how user #2 through #20 happens without relying on repeated cold LinkedIn outreach — your Inter AI Club network, content around the slang-gap positioning, and cross-border-relationship communities are worth exploring. Doesn't need answering before Phase 1, but needs an answer before Phase 6.

**Bandwidth — a real constraint:**
- [ ] You're running this alongside an active YC push for RabbitaAI and SceneDub. Decide honestly what weekly time this actually gets so the phase plan reflects reality, not best-case hours.

---

## Phase 1 — Core Translation Proof of Concept (text only, no voice, no extension)

**Goal:** prove the slang-aware translation actually works and measure real latency, before spending a dollar on anything else. This is the single highest-risk assumption in the whole project — de-risk it first.

**You do:**
- [ ] Create accounts + get API keys: AssemblyAI, an LLM provider (Anthropic or Google)
- [ ] Gather 10-15 real Spanish audio clips with genuine slang/casual speech (ask a Spanish-speaking contact, don't use clean scripted audio — it'll lie to you about accuracy)
- [ ] Set your own bar for "good enough": e.g. correctly and naturally translates at least 9/10 slang phrases in your test set
- [ ] Review every output personally — don't trust a passing automated metric here, your ear is the actual QA

**Agent does:**
- [ ] Minimal script: audio file → AssemblyAI transcription → single LLM call (correction + slang-aware translation combined, per earlier plan) → print translated text + per-stage latency
- [ ] Log latency at each stage (ASR, LLM, total) so you can see where time is going
- [ ] Iterate the translation prompt based on your feedback on specific failures

**Exit checklist (don't move to Phase 2 until all true):**
- [ ] End-to-end text latency consistently under your target (suggest ≤2s as the bar)
- [ ] Your slang test set passes your accuracy bar
- [ ] You've personally reviewed 10+ real exchanges and are genuinely satisfied, not just "good enough for now"

---

## Phase 2 — Voice Output + the 3-way Toggle

**Goal:** add spoken translated audio, built with the toggle from day one so you're never blocked on Skyler's answer.

**You do:**
- [ ] Get ElevenLabs API key, pick a default voice per language direction
- [ ] Listen for naturalness — flag if Flash's speed trades off too much quality for your bar
- [ ] Decide default toggle state (my suggestion: captions-only + audio on, original muted, both switchable)

**Agent does:**
- [ ] Wire translated text → ElevenLabs Flash v2.5 streaming TTS
- [ ] Build the three settings as independent toggles: show-text / speak-translation / mute-original
- [ ] Handle the audio-mixing logic for "layered" mode (original + translated playing together at sensible relative volumes)

**Exit checklist:**
- [ ] All 3 toggle combinations work without breaking playback
- [ ] Voice output latency added on top of Phase 1's text latency still lands under ~3s total
- [ ] You've done a real spoken back-and-forth test with someone, not just single clips

---

## Phase 3 — Group Mode (diarization + per-speaker voices)

**Goal:** support more than 2 people on a call, which is Skyler's group-setting ask and genuinely differentiates you.

**You do:**
- [ ] Test with a real 3+ person recording (or a staged one) — diarization quality on real overlapping speech is the thing to judge personally
- [ ] Approve the voice-to-speaker mapping (does it feel right that Speaker A always sounds like the same voice)

**Agent does:**
- [ ] Enable AssemblyAI streaming diarization, tune `max_speakers`
- [ ] Map each diarized speaker ID to a consistent ElevenLabs voice for the session
- [ ] Handle the messy cases: overlapping speech, a new speaker joining mid-call, short interjections

**Exit checklist:**
- [ ] Diarization correctly separates speakers in a real overlapping-speech test
- [ ] Voice mapping stays consistent for a speaker throughout a session
- [ ] Latency hasn't meaningfully degraded from Phase 2

---

## Phase 4 — Chrome Extension (capture + UI)

**Goal:** get this out of scripts and into something that actually runs on a real Google Meet call.

**You do:**
- [ ] Test on your own real Meet calls, on Chrome, before anyone else touches it
- [ ] Sign off on the minimal UI (connect button, live caption panel, the 3 toggles) — no polish yet, per your own call to deprioritize UI/UX
- [ ] Decide when it's ready to hand to a real outside tester

**Agent does:**
- [ ] Build the extension using `chrome.tabCapture`, WebSocket connection to your backend
- [ ] Render live captions/chat log + audio playback in the extension UI
- [ ] Handle connection drops and reconnects gracefully — don't let a network blip kill the whole session

**Exit checklist:**
- [ ] Runs on a real Meet call end-to-end without you babysitting the console
- [ ] Survives a deliberate network interruption without crashing
- [ ] You'd be comfortable letting someone else try it unsupervised

---

## Phase 5 — Backend, Accounts, Billing

**Goal:** turn the prototype into something that can hold multiple users and not bankrupt you.

**You do:**
- [ ] Set up the payment processor decided in the Business Foundations track above (Paddle, confirmed for Pakistan payouts, or the US LLC fallback) — decide the credit-pack price points (e.g. $X for Y hours of call time)
- [ ] Set your own hard cost ceiling per user per session (the safety net against a runaway bug)
- [ ] Confirm ToS/Privacy Policy and data retention decisions from the Business Foundations track are actually live before real users' data flows through this

**Agent does:**
- [ ] Build user accounts + auth
- [ ] Payment integration: one-time payments → credit balance (not metered subscriptions, per our earlier plan) — against whichever processor you've actually confirmed works for payouts to Pakistan
- [ ] Server-side balance enforcement: block session start at zero balance, decrement in real time during a call
- [ ] All API keys moved server-side only, nothing in the extension bundle

**Exit checklist:**
- [ ] A test purchase correctly credits an account
- [ ] A session is hard-blocked when balance hits zero — verify this, don't assume it
- [ ] No API key exists anywhere in the client-side extension code

---

## Phase 6 — Controlled Beta

**Goal:** validate with a real user before this becomes "the product," using Skyler if he responds, or another real Spanish-speaking contact if he's gone quiet — don't let his silence block this phase.

**You do:**
- [ ] Run one supervised test call yourself alongside the tester, watching for latency/accuracy issues live
- [ ] Only after that goes well, let them run an unsupervised real call, with you on standby
- [ ] Collect specific feedback: where did it feel slow, where did a translation feel wrong or unnatural, did the multi-voice mapping help or confuse

**Agent does:**
- [ ] Add lightweight session logging so you can review a session after the fact
- [ ] Fix issues as they surface from real usage, not hypothetical edge cases

**Exit checklist:**
- [ ] One full unsupervised real-world call completed without you intervening
- [ ] Tester's specific feedback addressed
- [ ] You'd trust this on your own personal call, honestly

---

## Phase 7 — Broader Launch Readiness

**Goal:** only start this once Phase 6 is genuinely done, not before.

**You do:**
- [ ] Decide pricing/packaging based on real cost data from beta usage
- [ ] Decide positioning/marketing (the slang-gap pitch)
- [ ] Explicitly punt mobile/iPhone to a separate future phase — it's a real multi-week native engineering problem (ReplayKit's own-audio-exclusion issue is currently unresolved even for other teams), not a v1 feature

**Agent does:**
- [ ] Onboarding flow, landing page, whatever ships alongside launch
- [ ] Basic monitoring/alerting so you find out about failures before your users do

---

## Standing Risk Checklist — apply across every phase, not just at the end

- [ ] What happens if AssemblyAI or ElevenLabs has an outage mid-call? (Suggest: degrade to captions-only rather than fail silently.)
- [ ] What happens on a network drop? (Should reconnect, not lose the session.)
- [ ] Is there a hard per-session cost ceiling so a bug can't run up an unbounded bill?
- [ ] Is the consent/disclosure step actually in place before any real outside person's voice hits third-party APIs?
- [ ] Do you have basic error logging so you find out about a broken session before a user complains?
- [ ] Is audio/transcript data encrypted in transit and at rest?
- [ ] Is there abuse/rate-limit protection so this can't be used to secretly translate or eavesdrop on someone without their knowledge?
- [ ] Chrome Web Store review: extensions requesting broad audio-capture permissions get extra scrutiny — budget real review time, don't assume same-day approval
- [ ] Backend/server hosting is a real recurring cost beyond per-minute API fees (a small VPS or a service like Railway/Fly.io) — budget for it separately, don't track only API cost

---

## The one rule that keeps this from becoming scope creep

Every phase has an exit checklist. Don't start the next phase until the current one's checklist is fully checked — including the "you're personally satisfied" items, not just the technical ones. "Leave no room for error" means enforcing these gates on yourself, not building every possible feature at once.
