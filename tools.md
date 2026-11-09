# Second-Look: Tool Definitions

Second-Look's AI helper has one tool. It is read-only: it looks up our labeled sample data and never changes or saves anything.

## get_sample_details

**Purpose:** Look up the correct answer and clue list for a picture, so the AI never decides on its own whether a picture is real or AI.

**When the AI uses it:** Every time, before writing an explanation.

**Definition:**

```json
{
  "name": "get_sample_details",
  "description": "Look up the correct answer (real or ai) and the clue list for one picture in the Second-Look game. Always call this before explaining an answer. The answer it returns is final.",
  "parameters": {
    "type": "object",
    "properties": {
      "sampleId": {
        "type": "integer",
        "description": "The id of the picture the group just answered, from 1 to 10."
      }
    },
    "required": ["sampleId"]
  }
}
```

**Returns:**

```json
{
  "answer": "ai",
  "clues": [
    "The writing on the museum tag is gibberish",
    "The tag says MMXXIV, which is the year 2024",
    "The moss blends into the stone in a strange, painted-on way"
  ]
}
```

**Where the data comes from:** `data/samples.json` on the server. The browser never sends the answer, so it can't be faked or changed by a user.

**If the id doesn't exist:** returns `{ "error": "Sample not found" }`, and the AI falls back to: "Let's look at the clues together!"

## Why only one tool

The AI's only job is to explain. It doesn't need to search the web, save data, or look at images. Fewer tools means fewer ways for it to go wrong, which matters in an app for kids.
