# System changes — Sean training call, 08/09/2026 (Kris, Tomás, Sean)

Companion to `TASKS_FROM_JOANA_TRAINING_CALL_08092026.md`, same day, same
format. This file is **only the system/bug half** of that session — the
coaching half is in `Discovery_Playbook_Sean.md` and deliberately isn't
repeated here.

Kris said it out loud on the call, so it's on the record that this was
expected to be picked up: *"it's listening to our call right now... fucking
AI work out what to do. Send us a plan."*

---

## 1. ⚠ The framework rubric is wrong — it wants all three legs, it should want ONE

The most consequential finding on the call, and it affects every rep's
scores right now, not just Sean's.

> **Tomás:** "on the framework — it says here, obviously, it doesn't deliver the framework. We're not always going to deliver ALL the frameworks. We're going to deliver THE framework. It can't be something from being the #1 podcast in your city, or selling more houses, or recruiting agents. It's never going to be all of them."
> **Kris:** "It's gonna be a framework, it's not gonna be all the frameworks."
> **Tomás:** "All of the frameworks, yeah."

The current rubric (`frameworkRubricPrompt_` / `deriveFrameworkFields_`,
`Phase2_CallScoring.gs`) marks a call down unless all three legs are
explained, and the emails say so verbatim — Frank Pirrone's feedback reads
*"Framework explained: false (missing: recruit agents, #1 podcast in your
city, sell more houses)"*, i.e. penalised on all three at once.

Per Tomás that is simply not the job. The right framework is **chosen** for
the lead from what discovery surfaced — his own example on the same call:
Ray Ferraro's framework depends on whether he's investing in loans or
escrows, because *"you can probably do the loans statewide, he can't do the
escrows statewide."*

**Fix:** framework should be graded as "was a framework delivered, and was
it the right one given this lead's goal/pain", not "were all three
recited". Needs Tomás's sign-off on the exact wording before it ships,
since it changes every framework score in the system.

---

## 2. Frank Pirrone's transcript is corrupted — 3,933 repetitions

Confirmed with a number, and it is NOT the blank-audio case already fixed:

> **Tomás:** "The transcript is basically half a page of real transcript. And then it's 3,933 times that it says 'I'm going to do it this way.'"
> **Kris:** "Note that, Mr. AI, and work out that bug."

The guard shipped earlier today (`transcriptIsUnusableForScoring_`,
`Phase2_CallScoring.gs`) catches empty and `[BLANK_AUDIO]` transcripts, but
**not** a repetition loop — a few thousand repeats of one sentence sails
past a word-count floor. So Frank Pirrone is still scoring 1/5 and still
leading Sean's training email. Needs a degenerate-repetition check
(unique-token ratio, or a repeated-n-gram check) on top of the existing one.

## 3. Same corruption on at least three more of Sean's calls

> **Sean:** "the one that I thought I did the absolute best on was the framework one. I actually really studied hard for that... and it gave me, like, a 1.5. I was like, what!"
> **Tomás:** "Yeah, all of the bad ratings that you have are transcripts that did not [work]."

Named on the call: **Frank Pirrone**, **Anthony/Antonio Camperi**, **Stuart
Ramirez**, and the "Trojan horse" framework call. Sean's low scores are
substantially a transcription problem, not a performance one — worth saying
plainly to him, and worth a sweep for how many rows are affected.

## 4. Explicit instruction: a broken transcript must not produce a rating

> **Tomás:** "if it's a 1, it needs to be flagged. And if it's a problem with the transcript, don't rate the call."
> **Kris:** "Yeah, don't rate the calls, [flag] the transcripts. And then we can look at why. That's a much better way for the system to work. Not giving shit ratings on stuff that's inaccurate."

Confirms the direction of today's A4 fix and extends it to §2 above.

---

## 5. Use the Zoom transcript when there is one

> **Kris:** "let's just make sure we add the Zoom transcript, and — AI is listening to this — I'm giving it the command of: Sean and Joana are going to upload the Zoom transcript, and if it's there, use that. If it's not, then transcript your own one."
> **Kris:** "is the Zoom transcript do a better job?"
> **Tomás:** "Oh, 100%."

So: prefer an existing Zoom `.vtt` in the recording folder over generating
one ourselves, and only fall back to our own transcription when Zoom's is
absent. This is plausibly the root fix for §2/§3 — our own transcription is
what produced the repetition loops.

---

## 6. Bruce Henson — "booked second call with Tomás: false" is wrong

> **Tomás:** "here it's wrong, because it says 'booked second call with Tomás: false', but it is true."
> **Sean:** "Yes sir, correct."

Same class of flag error as Lindsey Graves on Joana's side (see the Joana
task list, A2). Row 377. Worth checking whether this survives the rescore
now that the rubric moved, or whether it's a genuine judging miss.

## 7. Keith Brown — a display/staleness question, probably not a bug

> **Tomás:** "at first we got Keith Brown, it's a 4 out of 5... here you're even saying that it's a 5 out of 5, not 4."

Sean confirmed Keith Brown genuinely was a QC, so the Call Type is correct
for him (Sean's types come from folder labels, unlike Joana's). The 4-vs-5
discrepancy is most likely Tomás reading the email sent **before** today's
rescore, which moved several scores. Worth a look but low priority — flagged
so it isn't lost.

---

## 8. Sean's QC form has not reached the CRM for months

> **Sean:** "I do [fill out the form], but when I submit it, it doesn't upload to the CRM. And I don't know why... it's been happening so many times, I just thought there's a glitch."
> **Sean:** "I did bring it up, but it was a while ago... this has been months ago."

A real, long-standing data-loss bug: every QC Sean has run in that period
has details that never reached GoHighLevel. Needs tracing from the form
submission through to the CRM write. Tomás separately made the process
point to Sean (speak up immediately) — that's in his playbook, not here.

## 9. CRM tagging — auto going forward, backfill needed for existing

> **Tomás:** "I already adjusted, for example, ICONS 100 to be set as a tag every time it's booked on Bens's calendar. But the ones that exist now — I don't know if there's a way of automatically tagging them, or if we need to manually do it."
> **Kris:** "you should be able to go back and do some."
> **Tomás:** "if we give a list, like, hey, this is the list we want tagged."

Why it matters, in Tomás's words: *"when one lead closes from ICONS 100, I want to know if she's been a guest on a podcast before, if she was cold called before — this is where the tagging comes in."*

## 10. Put recordings and transcripts into the CRM

> **Tomás:** "I'm pretty sure that we can start putting even the recordings there. And then it's only up to you to check if they can pick up the recordings and the transcripts directly from the CRM."

Same family as D1/D2 in the Joana task list (transcripts into GHL contact
notes, one evolving handoff document per contact) — worth building as one
piece of work rather than three.

---

## Priority

1. **§2 + §5** — the transcript corruption is actively producing false
   ratings for Sean *this week*, and preferring Zoom's transcript may fix
   the cause rather than the symptom.
2. **§1 framework rubric** — wrong for every rep, every call. Needs Tomás's
   wording before it ships.
3. **§8 QC form → CRM** — months of lost data.
4. §9/§10 CRM work — bundle with the Joana list's D1/D2.
5. §6/§7 — verify against the post-rescore state first.

---

_Compiled 08/09/2026 from the Sean training call recording. Coaching content from the same call is in `Discovery_Playbook_Sean.md`._
