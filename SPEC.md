# Second-Look — Spec

## What this is

A "Real or AI?" game for kids ages 10–14, run by an after-school leader on one shared screen (laptop \+ projector or TV). The group looks at an image, discusses, and the leader enters the group's guess and reason. The app reveals the answer, and an AI helper explains which clues the group caught and which they missed.

One session \= 10 images, about 20 minutes.

## Who uses it

- **Main user:** the after-school leader. They control the screen and type for the group.  
- **Kids** watch, discuss, and call out answers. Kids never log in or type into the app themselves.

## Non-negotiable rules

1. **The AI never decides real vs. AI.** The correct answer always comes from `data/samples.json`. The AI only explains.  
2. **No accounts, no saving, no logging.** Nothing the group types is stored anywhere — not in a database, not in files, not in server logs.  
3. **No uploads.** The app only uses our own pre-labeled sample set.  
4. **Safe samples only.** No real people's faces. Real images \= animals, places, food, objects. AI images \= the same kinds of subjects.  
5. **The API key stays on the server.** It's read from an environment variable (`.env` locally, Replit Secrets on Replit). It never appears in front-end code or in GitHub.  
6. **Honest labeling.** Every AI explanation is labeled "AI helper — can make mistakes."

## Tech stack

- Front end: plain HTML, CSS, JavaScript (no framework)  
- Back end: Node.js \+ Express (serves the pages and makes the AI call)  
- AI: Google Gemini API, called only from the server. Key is read from the `GEMINI_API_KEY` environment variable.  
- Runs on Replit; code lives in GitHub (MrsDupoux/Second-Look)

## Folder structure

```
/public
  index.html
  style.css
  app.js
  /images        ← sample images
/data
  samples.json   ← labels and clues (source of truth)
server.js
package.json
.env             ← never committed
SPEC.md
```

## Sample data format (`data/samples.json`)

```json
[
  {
    "id": 1,
    "image": "images/01.jpg",
    "label": "ai",
    "clues": [
      "The fur blends into the background at the edges",
      "The shadow points the wrong way for the light",
      "The text on the sign is scrambled"
    ],
    "credit": "Made by Second-Look team"
  }
]
```

`label` is `"real"` or `"ai"`. Real images need a credit to a public-domain source.

## Screens

**1\. Start screen (for the leader)**

- Title: Second Look  
- One-line description, plus 3 short "how to run this" tips  
- Button: Start session

**2\. Image screen**

- Image (large), counter ("3 of 10")  
- Text box: "What did the group notice?" (optional, max 200 characters; placeholder says "Don't type names")  
- Two big buttons: Real / AI

**3\. Reveal screen**

- The correct answer, from the data (big and clear)  
- "You got it\!" or "Tricky one\!"  
- AI helper explanation (2–3 short sentences, labeled "AI helper — can make mistakes")  
- The pre-written clue list from the data  
- Button: Next

**4\. Results screen**

- Group score (X out of 10\)  
- The 3 most important clues to remember  
- Exit question: "If you saw something like this online, what would you do?" (Share it / Check it first / Tell a trusted adult). Shows the count for the session only; nothing is saved.  
- Message: "If something online makes you uncomfortable, tell a trusted adult."  
- Button: Play again

## AI explanation (`POST /api/explain`)

- **Request from the front end:** `{ sampleId, guess, reason }`  
- **The server:**  
  1. Looks up the sample in `samples.json` by `sampleId`. It never trusts a label sent from the browser.  
  2. Builds a prompt with: the correct label, the clue list, the group's guess, and their reason.  
  3. Calls the AI and returns 2–3 sentences at a 4th–5th grade reading level: what clues the group caught, which one they missed.  
- **If the AI call fails or times out (8 seconds):** show only the pre-written clues. The game never breaks.  
- The system prompt lives in its own file so it's easy to edit (due with the Day 4 milestone).  
- Day 3 (Nov 7\) covers LangChain agents. Check whether the AI call is expected to use LangChain before building this part.

## Build order

1. **Phase 1, no AI:** Express server serves the pages; game loads `samples.json`; Start → 10 images → reveal (clues only) → results. Push to GitHub.  
2. **Phase 2, AI:** add `/api/explain` and show the AI explanation on the reveal screen, with the fallback. Push.  
3. **Phase 3, polish:** big readable text for a projector, works in light and dark rooms, keyboard-friendly buttons.

## Done when

- [ ] A leader can run a full 10-image session without help  
- [ ] The answer always comes from our data, never from the AI  
- [ ] If the AI is down, the game still works  
- [ ] Nothing the group types is saved or logged  
- [ ] No API key in any file in GitHub

## Stretch (only if time allows)

- Pre-check and post-check rounds to measure improvement  
- A second, harder set of images  
- Spanish version  
- Printable clue card

## Out of scope (not now)

Kid accounts, uploading your own images or videos, a deepfake detector, teaching kids to code, an app-building course, app store release.