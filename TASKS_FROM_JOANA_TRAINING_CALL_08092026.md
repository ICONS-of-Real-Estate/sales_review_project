# Task list — Joana training call, 08/09/2026 (Kris, Tomás, Joana)

Source: `260908_Recording` (Icons Training Recordings — Joana folder). Built from
the full transcript, not from memory. Every item cites what was actually said, so
nothing here is invented — where something is my inference rather than someone's
words, it says so.

Tomás explicitly asked whether he still needed to reply to the training email
thread with these corrections; Kris said no, the call would be transcribed and
analysed instead. **This document is that reply** — it is the record of what was
wrong and what happens about it.

---

## A. Scoring is wrong right now, and it's corrupting the training

These are not cosmetic. The weekly playbook emails are built on these grades, so
while they're wrong, Tomás is being pointed at the wrong calls.

### A1. Every one of Joana's calls is graded as a QC. All of them are Sales Calls. ⚠ ROOT CAUSE

> **Tomás:** "all of the calls that Joana has here are graded as a QC... So that's wrong."
> **Kris:** "Click on the sales call tab... See, it's got sales calls? Oh, so there's zero."
> **Joana:** "It says there that it was a QC, which is wrong."

Joana's leads come in as ICONS 100 guests, so the call she runs is the **Sales
Call**, not the qualification call:

> **Joana:** "No, it was an ICONS100 lead, so then it was a sales call for me."

This is almost certainly the root cause of A2 and A3 below, because Call Type
decides which rubric variant scores the row (`resolveRubricVariantForRow_` /
`rubricVariantForNewScore_`, `Phase2_CallScoring.gs`). A Sales Call graded under
the QC rubric is being marked against "did you book the Sales Call" instead of
"did you close / take the money", which is a different job entirely.

**Task:** find where Call Type is set for Joana's rows (calendar event title
matching in `Phase1_ComplianceCheck.gs` is the likely source), fix the
classification, then re-score her calls under the correct variant.

### A2. Lindsey Graves — "no second call booked" is false. It was booked on the call.

> **Tomás:** "she's booked in for me for Friday. I know that much. Right now, it says that it didn't book a sales call... Did it book after the call was done, or was it booked then?"
> **Joana:** "It was booked on the call."
> **Tomás:** "Yeah, so this is wrong."

Today's rescore moved this call **4 → 2**, and the AI feedback leads with the
booking failure as the headline problem. That grade is now wrong in the opposite
direction of the truth.

### A3. Stacie Staub — scored 2. She is a CLOSE.

> **Joana:** "it's the sales call, because it was an ICONS 100 lead... And I closed it."
> **Joana:** "she hasn't paid on the call, but we agreed that I would send the contract for her review and the invoice, and that she would pay until the discovery call that was 2 days later."
> **Kris:** "That's as close as we can get to money on the phone right now."

Today's rescore moved this call **5 → 2**. A closed deal is being handed to Tomás
as one of the week's worst calls. Whatever the rubric is rewarding, it is not
rewarding closing — worth checking directly once A1 is fixed, because "no Sales
Call booked" is a meaningless criticism of a call that closed.

### A4. A blank/failed transcript must never produce a score

> **Tomás:** "the worst call, it was graded One, and then you go to the transcript, and it's just this... this shouldn't be a grade, right?"
> **Kris:** "Upload the recording."

This is Frank Pirrone (Sean, 05/09) — most of the recording is blank audio, and
the system scored it 1/5 and put it top of Sean's training list as a real
coaching case. A missing/blank recording is an **upload problem**, not a rep
performance problem, and should be routed as "recording missing — upload it",
never as a 1/5.

### A5. Joana's playbook page shows Sean's material

> **Tomás:** "the playbook is not just about Joana, it's talking about Sean. And even the only example that it gives, it was about Sean. About the Frank Pirrone... this is Joana, so there's not really much to go for."

The Discovery Playbook published today is topic-based, so every rep's page shows
the same doc, and its one worked example is Sean's call. Needs per-rep discovery
content (which A1–A3 currently block, since Joana has no trustworthy discovery
data yet).

---

## B. Automations that have silently stopped or never existed

### B1. Handoff briefs have stopped arriving

> **Joana:** "I'm only receiving those for some leads. I'm not receiving them in the last days."
> **Tomás:** "I haven't seen them come through."
> **Kris:** "Alright, I'll check on the handoff."

Where they matter most, per Joana: qualification calls booked through her link by
spam-list leads — people she has never spoken to. For Bens-sourced leads she
already gets his briefing, and for QCs she ran herself she already has the
context.

**Task:** find out why `Phase3_HandoffBrief.gs` stopped firing (or stopped
matching) and fix it.

### B2. Bens' recordings never made it from Riverside to Drive

> **Tomás:** "he didn't have the recordings, so maybe he didn't pass them over from Riverside to Google Drive, so it would be nice to have, like, a reminder as well, like, upload your recordings."
> **Kris:** "there's no recordings. I don't know whether there weren't any recordings, or he hasn't put them in the folder, but he's got no training material this week."
> **Joana:** "No, but he had recordings last week. He booked me some sales calls."

This is exactly the gap identified separately this morning: **nothing checks that
a call which happened actually ends up with a recording on Drive.** Phase 1's
daily check only verifies the rep typed an outcome into the sheet, not that a
recording/transcript exists.

**Task:** build the calendar → Drive reconciliation, plus Tomás's requested
Friday "upload your recordings" reminder. This one fix explains both "Bens has no
training material" and A4 above.

---

## C. Discovery rubric — what it's missing

The current rubric grades three things (asked real questions before pitching /
understood their business / confirmed prior discovery). The call surfaced two
genuine gaps.

### C1. Add GOAL and PAIN as scored dimensions

> **Tomás:** "on the discovery part, you could put — find the goal. Find the pain, right? Where are they running towards, and where are they running from?"
> **Tomás:** "if I know where you're going, I know where to meet you, and I know how I can take you there."

Important nuance Tomás corrected Kris on, and it needs to be in the rubric
wording or it will grade badly — **"not selling enough houses" is not the pain**:

> **Tomás:** "the pain of being stuck at 5 calls, it's not particularly a pain. It's like a disease, it's a condition. The pain that they have is something more peculiar. For example: not having any presence on social media, not on Google. When you Google them, you don't find a professional profile. Not active on Instagram. Content lacking engagement. Don't have a big enough network in the community. Not well known in the community. That's where we can help."
> **Tomás:** "there are some pains that we uncover even when they're recruiting agents, and they can't have qualified conversations, or nobody takes them seriously."

Kris's framing of the goal side, which is compatible:

> **Kris:** "I'm selling 5 houses a month, and I want to sell 10... how long have you been at 5 houses? Are you really motivated to get to 10? Or did you just pull that number out of your ass? What stopped you getting there before? If you've got that goal, why aren't you achieving it right now?"

### C2. Candidate discovery metrics (Kris's suggestion, not yet designed)

> **Kris:** "how many minutes were spent on discovery? How many questions were asked? How many follow-up questions? Those are probably pretty decent metrics."

### C3. Study which discovery questions actually lead to wins

> **Tomás:** "figuring out what are the discovery call questions that are leading to positive outcomes... either booking a second call, or actually closing. For example, Stacie — that's a winning one. They can check which calls were successes, and how was the discovery there."

Blocked on A3 — Stacie is currently scored 2, so the system doesn't yet know she
is one of the wins.

---

## D. CRM (GoHighLevel) — get the data out of people's heads

### D1. Push call transcripts / notes into the GHL contact

> **Tomás:** "how can we add on the notes... the transcript of the call here."
> **Kris:** "we've got API access to GoHighLevel, so it can send that. It should be able to put in those notes. I'll get it updated so it adds it there."
> **Tomás:** "here, when we want to follow up with someone, we go to the CRM, so you need to be here."

**Kris committed to this on the call.**

### D2. One evolving handoff brief per contact, linked in the CRM

> **Tomás:** "I wouldn't even say that it needs more tabs. It's only one handoff brief, it just evolves as it moves forward. We have more information, but it's the same... it's like the profile."
> **Tomás:** "if by the time it gets there we want to follow up with them, we can just look at that, and even AI can look at that and make a whole plan around it."

So: not a new document per stage (QC → Sales Call → second call), but **one
document per contact that gets updated** as the lead moves through stages, linked
from the GHL contact record.

### D3. The handoff brief should extract goal + pain from the transcript

> **Tomás:** "you can pick up the transcripts and then make it into — what is the goal? What is the pain?"
> **Kris:** "But that should be sent in the handoff document anyway."

### D4. Joana isn't filling in the QC form, so nothing reaches the CRM

> **Tomás:** "When you do the QC, you do put the details on the form, right?"
> **Joana:** "Usually no. I just use AI to get me all the details. It's easier to have a conversation with them than sharing the screen and writing everything."
> **Tomás:** "it's just that then it's not registered with the CRM."

Not a discipline problem to nag about — D1/D2 are the actual fix, since the AI
already has the transcript. Flagged here so the connection is explicit.

---

## E. Schedule change — supersedes the Monday cadence we just built

> **Kris:** "How about I change the schedules to do everything over the weekend, send everything to everyone to review on Monday, to see that it's okay for training on Tuesday, and if not, reply back on Monday. I get up hours before you guys, so I can work on it so that it's tidier."
> **Tomás:** "you'll have a cadence of maybe Monday to Friday, which is better... [the recording reminder] you can have on Friday, for example. And then you can work on the playbooks on Saturday morning."

Proposed shape:
- **Friday** — "upload your recordings" reminder to the reps (B2)
- **Saturday morning** — scoring/playbooks generated, Kris reviews and tidies
- **Monday** — playbooks sent to Tomás/Joana/Sean to review; corrections replied same day
- **Tuesday** — training sessions run off reviewed material

⚠ This replaces the Monday-reminder/Monday-final two-stage schedule shipped
earlier today. **Needs Kris to confirm before I change the triggers** — and note
the project is at the 20-trigger Apps Script cap, so this is a re-shuffle, not
an addition.

---

## F. Explicitly decided AGAINST — don't build this

> **Kris:** "Do you think it'd be useful to get the system to format the transcripts nicely? Rather than a wall of text?"
> **Tomás:** "I don't think nobody's ever gonna [read] the transcripts. At best, they'll copy-paste them into AI."

Recorded so nobody builds transcript prettification later thinking it was an
open request. The handoff brief (D2/D3) is the answer instead.

---

## G. Coaching content for the Discovery Playbook (Tomás's own method)

Not system tasks — this is the material that should replace the generic technique
library in `Discovery_Playbook.md`, since it is Tomás's actual process, taught
live on this call using Xavier Long as the worked example.

**Do the due diligence before the call.** Tomás found, in a few minutes of
searching, that Xavier has ~600k TikTok followers, is a founding member of the
Ethos Alabama Birmingham expansion team, sells cars alongside real estate, and
was a boxer. Joana knew almost none of this going into a call scheduled that day.

> **Kris:** "If the dude knows how to get half a million followers, and he's brand new to real estate, he's gonna crush it."
> **Tomás:** "do you know what his plan is on TikTok? On how he's going to leverage his half a million followers?"
> **Joana:** "Not really."

**Write the questions down before the call.**
> **Tomás:** "note down a few questions. Don't keep it in your mind."

**Take notes during the call, visibly.**
> **Tomás:** "active listening is super important, but do take notes... people would even be curious, like, 'oh wow, she's actually taking notes' — and not just asking empty questions so she can go into the pitch."

**The confirm-and-deepen opener for any second/sales call:**
> **Tomás:** "hey X, this is from our previous call, this is what I uncovered, just want to confirm that... and then I have some further questions that are gonna help me understand the full scope of your business. Is it alright if I go through them right now?"

**Never pitch before the full scope is known.**
> **Tomás:** "we can only ever sell someone, and pitch someone, once we found the full scope of who they are as a real estate agent, and what they are trying to accomplish."

**Qualify the mentality, not just the budget** — the "top producing agents" frame:
> **Tomás:** "usually we only work with top producing agents. It's not because of our pricing — that remains accessible. It is more because of the mentality of top producing agents, of wanting to build a brand that feeds their business, instead of waking up at 5am and coming back at 8pm every day. So it's not that you can't do a podcast, but it will depend on your mentality. Is this a long-term play for you? Is this a cash-and-grab situation? Because if it is a cash-and-grab, we can't help you — we'd be building a brand for something that's not going to exist in 2 years."

**Qualify budget before showing the offer:**
> **Tomás:** "before I even show you the strategy... the service that we do is not free. So just to understand, what would be a budget? Just throw a number... if he says $50 or $10, you can just say, hey, I'm not gonna show you the goodies if that's all you have. And just be honest with them. That will save you some time."

**Focus mismatch is a real disqualifier, and naming it is a technique:**
> **Tomás:** "people don't want to buy bananas from people that grow apples. We are working with a very competitive market, and you're fighting against people that are full-time on real estate. And the same thing with cars... What is your plan? What do you plan to achieve?"
> **Tomás:** "we've really never done a podcast to help people sell cars, but if you want a podcast to help you sell houses — that's what we live for. So is that something that you're looking for?"

**Don't re-run the QC's discovery from scratch on the sales call** — Tomás holds
himself to this too:
> **Tomás:** "sometimes trying to get ahold of myself on second calls, I should prepare a little bit better, because sometimes I may ask questions that we already know. That shouldn't happen."

---

## Suggested order of work

1. **A1** (Call Type) — everything else in section A is downstream of it
2. **A4** (blank transcript ≠ score 1) — one-line-ish guard, stops bad coaching cases immediately
3. **B2** (calendar → Drive reconciliation + Friday reminder) — fixes Bens having no material at all
4. **B1** (handoff briefs stopped) — Joana is flying blind on spam-list QCs right now
5. **A2/A3** re-score and verify — confirms A1 actually worked
6. **E** (schedule) — needs Kris's confirmation first
7. **C1** (goal/pain in the rubric), then **C3** and per-rep playbooks
8. **D1/D2/D3** (CRM notes + evolving handoff brief) — biggest build, least urgent

---

_Compiled 08/09/2026 from the training call recording. Anything marked ⚠ needs a
human decision before I touch it._
