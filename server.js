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

const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const AI_TIMEOUT_MS = 8000;
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
async function callGemini(body, apiKey, signal) {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  return res.json();
}

async function explainWithAI({ sampleId, guess, reason }, signal) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("No API key");

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
    const data = await callGemini({ ...baseRequest, contents }, apiKey, signal);
    const content = data && data.candidates && data.candidates[0] && data.candidates[0].content;
    if (!content || !Array.isArray(content.parts)) throw new Error("Empty response");

    const calls = content.parts.filter((p) => p.functionCall);
    if (calls.length === 0) {
      // Final answer. Require that the model actually used our data first.
      if (!toolSucceeded) throw new Error("Model did not use the tool");
      const text = content.parts
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text)
        .join("")
        .trim();
      if (!text || text === MODEL_FALLBACK_TEXT) throw new Error("No explanation");
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
  throw new Error("Too many tool rounds");
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
    // Deliberately not logged: errors could carry request content.
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
