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
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const AI_TIMEOUT_MS = 15000;
const MAX_REASON_LENGTH = 200;
const MAX_TOOL_ROUNDS = 3;
// system.md tells the model to reply with this if the tool fails; treat it as a fallback.
const MODEL_FALLBACK_TEXT = "Let's look at the clues together!";

function loadSamples() {
  return JSON.parse(fs.readFileSync(SAMPLES_PATH, "utf8"));
}

function findSample(id) {
  return loadSamples().find((s) => s.id === id);
}

// ---- Tool: get_sample_details (defined in tools.md) ----
const GET_SAMPLE_DETAILS_DECLARATION = {
  name: "get_sample_details",
  description:
    "Look up the correct answer (real or ai) and the clue list for one picture in the Second-Look game. Always call this before explaining an answer. The answer it returns is final.",
  parameters: {
    type: "OBJECT",
    properties: {
      sampleId: {
        type: "INTEGER",
        description: "The id of the picture the group just answered, from 1 to 10.",
      },
    },
    required: ["sampleId"],
  },
};

// Read-only lookup in data/samples.json. Only answers for the picture this request is about.
function getSampleDetails(args, allowedId) {
  const id = Number(args && args.sampleId);
  if (id !== allowedId) return { error: "Sample not found" };
  const sample = findSample(id);
  if (!sample) return { error: "Sample not found" };
  return { answer: sample.label, clues: sample.clues || [] };
}

// ---- Gemini call with tool use ----

// Errors we create ourselves have fixed messages that are safe to log
// (they never contain the group's reason text or the model's reply).
function safeError(message, status) {
  const err = new Error(message);
  err.safeToLog = true;
  if (status) err.status = status;
  return err;
}

// Google answers these when it is busy or rate-limited; worth one quick retry.
const RETRYABLE_STATUSES = [429, 500, 503, 504];
const RETRY_DELAY_MS = 500;

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
  // Timing log (step name + seconds only, never content) to see which call is slow.
  const step = body.contents.length === 1 ? "step 1, look up answer" : "step 2, write explanation";
  const started = Date.now();
  const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
  console.log(`AI helper: asking Gemini (${step})...`);
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    console.log(`AI helper: Gemini answered HTTP ${res.status} after ${seconds()}s (${step})`);
    throw safeError(`HTTP ${res.status}`, res.status);
  }
  const data = await res.json();
  console.log(`AI helper: Gemini answered after ${seconds()}s (${step})`);
  return data;
}

async function explainWithAI({ sampleId, guess, reason }, signal) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw safeError("no GEMINI_API_KEY set");

  // At most one retry per explanation, and only while the 15-second limit allows.
  let retried = false;
  async function callWithRetry(body) {
    try {
      return await callGemini(body, apiKey, signal);
    } catch (err) {
      if (retried || signal.aborted || !RETRYABLE_STATUSES.includes(err.status)) throw err;
      retried = true;
      console.log(`AI helper: HTTP ${err.status} from Gemini, retrying once`);
      await wait(RETRY_DELAY_MS, signal);
      return callGemini(body, apiKey, signal);
    }
  }

  const systemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  const contents = [
    {
      role: "user",
      parts: [{ text: `SAMPLE_ID: ${sampleId}\nGUESS: ${guess}\nREASON: ${reason}` }],
    },
  ];
  const baseRequest = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: [{ functionDeclarations: [GET_SAMPLE_DETAILS_DECLARATION] }],
  };

  let toolSucceeded = false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const data = await callWithRetry({ ...baseRequest, contents });
    const content = data && data.candidates && data.candidates[0] && data.candidates[0].content;
    if (!content || !Array.isArray(content.parts)) throw safeError("empty response from Gemini");

    const calls = content.parts.filter((p) => p.functionCall);
    if (calls.length === 0) {
      // Final answer. Require that the model actually used our data first.
      if (!toolSucceeded) throw safeError("model did not use the tool");
      const text = content.parts
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text)
        .join("")
        .trim();
      if (!text || text === MODEL_FALLBACK_TEXT) throw safeError("model gave no explanation");
      return text;
    }

    // Send the model's turn back unchanged (keeps Gemini 3 thought signatures), then the tool results.
    contents.push(content);
    const responses = calls.map((p) => {
      const { name, args } = p.functionCall;
      const result =
        name === "get_sample_details" ? getSampleDetails(args, sampleId) : { error: "Unknown tool" };
      if (!result.error) toolSucceeded = true;
      return { functionResponse: { name, response: result } };
    });
    contents.push({ role: "user", parts: responses });
  }
  throw safeError("too many tool rounds");
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
    const explanation = await explainWithAI({ sampleId, guess, reason }, controller.signal);
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
