
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// Serve index.html and other static files in the project folder
app.use(express.static("."));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// REQUIRED for deployment: set this in your host (Render) environment variables
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;
if (!VECTOR_STORE_ID) {
  throw new Error("Missing VECTOR_STORE_ID environment variable.");
}

// Exact required strings
const REFUSAL = "Your request is beyond the scope and purpose of this app.";
const SOIL_TOOL_LINE =
  "For soils in Vermont, use the official soil map tool: https://casoilresource.lawr.ucdavis.edu/gmap/.";
const DEVELOPER_LINE =
  "Please contact the developer with your questions or feedback (steve@northeastforests.com).";

// Allowed sources list (titles, as the model should refer to them)
const ALLOWED_SOURCES_TEXT = `
Authoritative sources for this app (use only these):
- Vermont AMP Guide
- 2017 Vermont Forest Action Plan
- Silvicultural Guides
- Tree Owner’s Manual
- Steven Bick publications
- Vermont FIA Data
- Combined Culvert Information
- USDA Forest Service manuals (e.g., Wood Handbook)
`.trim();

const SYSTEM_INSTRUCTIONS = `
Purpose:
You are VT Woods App, a Vermont-only forestry assistant that provides technical, actionable information about:
- Vermont forestry and silviculture practices
- Climate adaptation for Vermont forests
- Water quality and erosion control as related to forestry
- The Vermont forest products industry

Scope:
Refuse any question not primarily about Vermont forestry or the topics above using EXACTLY:
"${REFUSAL}"

Sources:
Use ONLY the provided documents returned by file_search AND treat the authoritative list below as the only acceptable basis for answers.
If you cannot support an answer from those documents, say you can’t find it in the provided documents (and do not guess).
${ALLOWED_SOURCES_TEXT}

Behavior:
- Ask at most ONE clarifying question when needed.
- If the question is clearly out of scope, do NOT ask a clarifying question; refuse with the exact refusal sentence.
- Prefer practical, field-ready outputs (steps, checklists, decision rules) when the documents support them.
- Keep terminology precise: say "forest products industry" (not "forestry industry").
- Avoid speculative, vague, or nontechnical language.

Soils:
If the user asks about soils (soil type, mapping, classification, soil at a location), respond ONLY with:
"${SOIL_TOOL_LINE}"

Citations:
Only provide citations when the user explicitly requests citations/sources/references/quotes.
When citations are requested:
- Cite by document title plus the most specific locator you can (section heading, page number, or both).
- Keep it clean. Use a short "Sources:" block at the end (only when requested).

Developer contact:
Do NOT include developer contact info unless the user asks who made this app, how to send feedback, how to make suggestions, who wrote it, how to report an issue, or similar.
If asked, include:
"${DEVELOPER_LINE}"
`.trim();

// Simple sanity check endpoint
app.get("/test", async (req, res) => {
  try {
    const response = await client.responses.create({
      model: "gpt-5",
      input: "Reply with exactly these words: API key working.",
    });
    res.json({ success: true, output: response.output_text });
  } catch (err) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.post("/chat", async (req, res) => {
  const message = req.body?.message;

  if (!message || typeof message !== "string") {
    return res
      .status(400)
      .json({ error: "Missing message (string) in JSON body." });
  }

  // Explicit citations trigger (tight on purpose)
  const citationRequested =
    /\b(cite|citations|citation|sources|source|references|reference|quote|quoted)\b/i.test(
      message
    );

  // Developer/feedback/attribution trigger (only then include developer line)
  const developerInfoRequested =
    /\b(feedback|suggestion|suggestions|who (made|built|created|wrote)|developer|maintainer|contact|email|how do i (send|give) feedback|how do i report|report (a )?(bug|issue)|make a suggestion|feature request)\b/i.test(
      message
    );

  // Soil question trigger (enforce hard redirect)
  const soilAsked =
    /\bsoil\b|\bsoils\b|\bsoil map\b|\bsoil type\b|\bsoil classification\b|\bWeb Soil Survey\b|\bNRCS\b/i.test(
      message
    );

  if (soilAsked) {
    // Soil response must be ONLY the soil tool line (plus developer line only if asked)
    const answer = developerInfoRequested
      ? `${SOIL_TOOL_LINE}\n\n${DEVELOPER_LINE}`
      : SOIL_TOOL_LINE;
    return res.json({ answer });
  }

  const citationModeNote = citationRequested
    ? `User explicitly requested citations. Include a short "Sources:" block with document titles and section/page locators.`
    : `User did not explicitly request citations. Do NOT include citations, sources, references, quotes, or a "Sources:" block.`;

  const developerModeNote = developerInfoRequested
    ? `User asked about the app/developer/feedback. Include this sentence somewhere appropriate in your reply: "${DEVELOPER_LINE}"`
    : `Do NOT include developer contact info unless the user asked for it.`;

  try {
    const response = await client.responses.create({
      model: "gpt-5",
      input: [
        { role: "system", content: SYSTEM_INSTRUCTIONS },
        { role: "system", content: citationModeNote },
        { role: "system", content: developerModeNote },
        { role: "user", content: message },
      ],
      tools: [
        {
          type: "file_search",
          vector_store_ids: [VECTOR_STORE_ID],
        },
      ],
    });

    let text = (response.output_text || "").trim();

    // Enforce exact refusal behavior
    if (text === REFUSAL) {
      return res.json({ answer: text });
    }

    // If user asked for developer info but the model forgot, append it.
    if (developerInfoRequested && !text.includes("steve@northeastforests.com")) {
      text = `${text}\n\n${DEVELOPER_LINE}`;
    }

    res.json({ answer: text });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// REQUIRED for deployment: hosts provide PORT; fall back to 3000 locally
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
