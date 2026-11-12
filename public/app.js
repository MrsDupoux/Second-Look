// Second Look — game logic.
// The correct answer always comes from data/samples.json.
// Everything here lives in memory only; nothing is saved. The group's reason is sent
// only to our own server's /api/explain, which does not store or log it.

const SESSION_LENGTH = 10;

let samples = [];
let session = [];   // samples for this round, shuffled
let index = 0;
let score = 0;
let missed = [];    // samples the group got wrong (for "clues to remember")
let exitCounts = { share: 0, check: 0, adult: 0 };

const $ = (id) => document.getElementById(id);

function show(screenId) {
  document.querySelectorAll(".screen").forEach((s) => { s.hidden = s.id !== screenId; });
  window.scrollTo(0, 0);
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function labelText(label) {
  return label === "ai" ? "AI-made" : "Real";
}

function fillList(listEl, items) {
  listEl.innerHTML = "";
  items.forEach((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    listEl.appendChild(li);
  });
}

// ---- Load data ----
async function loadSamples() {
  try {
    const res = await fetch("/api/samples");
    if (!res.ok) throw new Error("bad response");
    samples = await res.json();
    if (!Array.isArray(samples) || samples.length === 0) throw new Error("no samples");
    $("btn-start").disabled = false;
  } catch (err) {
    $("load-error").hidden = false;
  }
}

// ---- Session flow ----
function startSession() {
  session = shuffle(samples).slice(0, SESSION_LENGTH);
  index = 0;
  score = 0;
  missed = [];
  exitCounts = { share: 0, check: 0, adult: 0 };
  showImage();
}

function showImage() {
  const sample = session[index];
  $("counter").textContent = `${index + 1} of ${session.length}`;
  $("sample-image").src = sample.image;
  $("reason").value = "";
  $("char-count").textContent = "0";
  show("screen-image");
}

// Ask the server's AI helper. Sends only sampleId, guess and reason (never the label).
// If anything fails, the box is hidden and the reveal shows only the pre-written clues.
let explainRequest = 0;

async function loadExplanation(sampleId, guess, reason) {
  const requestId = ++explainRequest;
  const box = $("ai-helper");
  const text = $("ai-text");
  text.textContent = "AI helper is thinking…";
  text.classList.add("loading");
  box.hidden = false;

  let explanation = null;
  try {
    const res = await fetch("/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sampleId, guess, reason }),
      signal: AbortSignal.timeout(17000), // a bit longer than the server's 15-second limit
    });
    if (res.ok) explanation = (await res.json()).explanation;
  } catch (err) {
    explanation = null;
  }

  if (requestId !== explainRequest) return; // the leader already moved on
  if (typeof explanation === "string" && explanation.trim()) {
    text.textContent = explanation;
    text.classList.remove("loading");
  } else {
    box.hidden = true;
  }
}

function submitGuess(guess) {
  const sample = session[index];
  const reason = $("reason").value.trim().slice(0, 200);
  $("reason").value = "";
  loadExplanation(sample.id, guess, reason);

  const correct = guess === sample.label;
  if (correct) score++;
  else missed.push(sample);

  $("reveal-counter").textContent = `${index + 1} of ${session.length}`;
  const answer = $("answer");
  answer.textContent = `This one is ${labelText(sample.label)}`;
  answer.className = `answer ${sample.label}`;
  $("verdict").textContent = correct ? "You got it!" : "Tricky one!";
  $("reveal-image").src = sample.image;
  $("clue-heading").textContent =
    sample.label === "ai" ? "How you can tell it’s AI" : "How you can tell it’s real";
  fillList($("clue-list"), sample.clues || []);
  $("credit").textContent = sample.credit ? `Image: ${sample.credit}` : "";
  $("btn-next").textContent = index + 1 < session.length ? "Next" : "See results";
  show("screen-reveal");
}

function next() {
  explainRequest++; // ignore any explanation still on its way
  $("ai-helper").hidden = true;
  index++;
  if (index < session.length) showImage();
  else showResults();
}

// Pick 3 clues: first from images the group missed, then from the rest.
function topClues() {
  const order = missed.concat(session.filter((s) => !missed.includes(s)));
  const picked = [];
  for (const s of order) {
    if (s.clues && s.clues.length) picked.push(s.clues[0]);
    if (picked.length === 3) return picked;
  }
  // Not enough samples: fill with second clues.
  for (const s of order) {
    if (s.clues && s.clues[1] && !picked.includes(s.clues[1])) picked.push(s.clues[1]);
    if (picked.length === 3) break;
  }
  return picked;
}

function showResults() {
  $("score").textContent = `${score} out of ${session.length}`;
  fillList($("top-clues"), topClues());
  updateExitCounts();
  show("screen-results");
}

function updateExitCounts() {
  $("count-share").textContent = exitCounts.share;
  $("count-check").textContent = exitCounts.check;
  $("count-adult").textContent = exitCounts.adult;
}

// ---- Wire up ----
$("btn-start").addEventListener("click", startSession);
$("btn-next").addEventListener("click", next);
$("btn-again").addEventListener("click", () => show("screen-start"));

document.querySelectorAll(".btn-choice").forEach((btn) => {
  btn.addEventListener("click", () => submitGuess(btn.dataset.guess));
});

document.querySelectorAll(".btn-exit").forEach((btn) => {
  btn.addEventListener("click", () => {
    exitCounts[btn.dataset.choice]++;
    updateExitCounts();
  });
});

$("reason").addEventListener("input", (e) => {
  $("char-count").textContent = e.target.value.length;
});

loadSamples();
