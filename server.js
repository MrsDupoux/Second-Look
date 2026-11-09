// Second-Look server (Phase 1: no AI).
// Serves the front end and the pre-labeled sample set.
// Privacy: no request logging, nothing the group types is received or stored.

const path = require("path");
const fs = require("fs");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const SAMPLES_PATH = path.join(__dirname, "data", "samples.json");

function loadSamples() {
  return JSON.parse(fs.readFileSync(SAMPLES_PATH, "utf8"));
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Second-Look running at http://localhost:${PORT}`);
});
