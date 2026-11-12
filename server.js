// Second-Look server.
// Serves the front end, the pre-labeled sample set, and the AI helper (POST /api/explain).
// Privacy: no request logging. The group's reason text is never logged or stored.

const path = require("path");
const fs = require("fs");
const express = require("express");

// Load .env locally if present (on Replit, Secrets set the environment instead).
try {
  if (typeof process.loadEnvFile === "function") process.loadEnvFile(path.join(__dirname, ".env"));
} catch (err) {
  // No .env file: fine.
}

const app = express();
const PORT = process.env.PORT || 3000;
const SAMPLES_PATH = path.join(__dirname, "data", "samples.json");
const SYSTEM_PROMPT_PATH = path.join(__dirname, "system.md");

// Flash-Lite: faster and less busy than Flash; its default thinking level is already "minimal".
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const AI_TIMEOUT_MS = 15000;
const MAX_REASON_LENGTH = 200;
// system.md tells the model to reply with this if ANSWER or CLUES are missing; treat it as a fallback.
const MODEL_FALLBACK_TEXT = "Let's look at the clues together!";

function loadSamples() {
  return JSON.parse(fs.readFileSync(SAMPLES_PATH, "utf8"));
}

function findSample(id) {
  return loadSamples().find((s) => s.id === id);
}

// ---- Gemini call ----

// Errors we create ourselves have fixed messages that are safe to log
// (they never contain the group's reason text or the model's reply).
function safeError(message, status) {
  const err = new Error(message);
  err.safeToLog = true;
  if (status) err.status = status;
  return err;
}

// Google answers these when it is busy or rate-limited; worth a quick retry.
const RETRYABLE_STATUSES = [429, 500, 503, 504];
const RETRY_DELAY_MS = 500;
// Most requests answer in 1-3 seconds; one still waiting after this is likely stuck,
// so send it again (a fresh request usually comes back quickly).
const STEP_TIMEOUT_MS = 4000;
// Tries: the first try plus up to 2 resends. The last try gets whatever
// time is left of the overall limit instead of the 4-second cutoff.
const MAX_TRIES = 3;

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(safeError("timed out"));
    }, { once: true });
  });
}

async function callGemini(body, apiKey, signal) {
  // Timing log (status and seconds only, never content).
  const started = Date.now();
  const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
  console.log("AI helper: asking Gemini...");
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    console.log(`AI helper: Gemini answered HTTP ${res.status} after ${seconds()}s`);
    throw safeError(`HTTP ${res.status}`, res.status);
  }
  const data = await res.json();
  console.log(`AI helper: Gemini answered after ${seconds()}s`);
  return data;
}

// One request: the server looks up the answer and clues in samples.json itself and
// sends them to Gemini, so the AI never decides real vs. AI.
async function explainWithAI({ sample, guess, reason }, signal) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw safeError("no GEMINI_API_KEY set");

  // Up to 3 tries: the request is sent again if Gemini says it's busy, or if
  // it is still waiting after 4 seconds. The overall 15-second limit always applies.
  async function callWithRetry(body) {
    for (let tryNumber = 1; ; tryNumber++) {
      const lastTry = tryNumber === MAX_TRIES;
      if (lastTry) return callGemini(body, apiKey, signal);

      const thisTry = new AbortController();
      const stopThisTry = () => thisTry.abort();
      signal.addEventListener("abort", stopThisTry, { once: true });
      const stepTimer = setTimeout(stopThisTry, STEP_TIMEOUT_MS);
      try {
        return await callGemini(body, apiKey, thisTry.signal);
      } catch (err) {
        if (signal.aborted) throw err; // out of time overall
        const stuck = thisTry.signal.aborted;
        if (!stuck && !RETRYABLE_STATUSES.includes(err.status)) throw err;
        if (stuck) {
          console.log(`AI helper: no answer after ${STEP_TIMEOUT_MS / 1000}s, sending it again`);
        } else {
          console.log(`AI helper: HTTP ${err.status} from Gemini, retrying`);
          await wait(RETRY_DELAY_MS, signal);
        }
      } finally {
        clearTimeout(stepTimer);
        signal.removeEventListener("abort", stopThisTry);
      }
    }
  }

  const systemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  const clues = (sample.clues || []).map((c) => `- ${c}`).join("\n");
  const userMessage =
    `ANSWER: ${sample.label}\n` +
    `CLUES:\n${clues}\n` +
    `GUESS: ${guess}\n` +
    `REASON: ${reason}`;

  const data = await callWithRetry({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
  });
  const content = data && data.candidates && data.candidates[0] && data.candidates[0].content;
  if (!content || !Array.isArray(content.parts)) throw safeError("empty response from Gemini");

  const text = content.parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("")
    .trim();
  if (!text || text === MODEL_FALLBACK_TEXT) throw safeError("model gave no explanation");
  return text;
}

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));

// The sample set (source of truth for labels and clues).
app.get("/api/samples", (req, res) => {
  try {
    res.json(loadSamples());
  } catch (err) {
    res.status(500).json({ error: "Could not load samples." });
  }
});

// AI helper. Body: { sampleId, guess, reason }. Never accepts a label from the browser.
// Always answers 200: { explanation: "..." } or { explanation: null } (fallback: show clues only).
app.post("/api/explain", express.json({ limit: "4kb" }), async (req, res) => {
  const fallback = () => res.json({ explanation: null });

  const body = req.body || {};
  const sampleId = Number(body.sampleId);
  const guess = body.guess;
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, MAX_REASON_LENGTH) : "";

  let sample;
  try {
    sample = Number.isInteger(sampleId) ? findSample(sampleId) : undefined;
  } catch (err) {
    return fallback();
  }
  if (!sample || (guess !== "real" && guess !== "ai")) return fallback();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const explanation = await explainWithAI({ sample, guess, reason }, controller.signal);
    res.json({ explanation });
  } catch (err) {
    // Log only a short, fixed description: never the reason text, the model's reply,
    // or raw error messages (which could carry request or response content).
    let why = "unexpected error";
    if (controller.signal.aborted) why = `timed out after ${AI_TIMEOUT_MS / 1000} seconds`;
    else if (err && err.safeToLog) why = err.message;
    console.log(`AI helper failed (showing clues only): ${why}`);
    fallback();
  } finally {
    clearTimeout(timer);
  }
});

// Bad JSON etc. on /api/explain: return the fallback quietly.
// (Express's default handler would print the error, which can include the request text.)
app.use((err, req, res, next) => {
  if (req.path === "/api/explain") return res.json({ explanation: null });
  res.status(err.status || 500).end();
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Second-Look running at http://localhost:${PORT}`);
});
