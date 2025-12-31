'use strict';

const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
dotenv.config();

const OpenAI = require('openai');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// --- CONFIG ---
const PORT = process.env.PORT || 8000;

// Set these on Koyeb "Environment variables"
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID || '';

// Koyeb/Google Sites iframe embedding: allow being framed
// (Google Sites typically frames your URL. If blocked, it won't render.)
app.use((req, res, next) => {
  // Allow embedding from vtwoods.xyz and Google Sites
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://*.google.com https://sites.google.com https://www.vtwoods.xyz https://vtwoods.xyz"
  );
  // Avoid legacy frame blocking
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  next();
});

// Serve your static front-end
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

function outOfScope() {
  return "Your request is beyond the scope and purpose of this app.";
}

function isInScope(message) {
  // STRICT Vermont forestry scope gate.
  // If you want tighter/looser, say so and I’ll adjust.
  const m = (message || '').toLowerCase();

  // quick allowlist hints (VT + forestry related)
  const allow = [
    'vermont', 'vt ', ' vt', 'amps', 'acceptable management practice',
    'logging', 'forestry', 'silviculture', 'forest products', 'skid trail',
    'stream crossing', 'culvert', 'waterbar', 'turnout', 'erosion', 'rutting',
    'landing', 'haul road', 'timber', 'harvest', 'felling', 'forwarder',
    'skidder', 'sawmill', 'forest action plan', 'fia'
  ];

  // If it mentions Vermont explicitly, assume in-scope unless obviously unrelated.
  if (m.includes('vermont') || m.includes(' vt')) return true;

  // Otherwise must hit multiple allow terms to reduce “general questions” slipping in.
  let hits = 0;
  for (const k of allow) if (m.includes(k)) hits++;
  return hits >= 2;
}

function isSoilsQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('soil') || m.includes('soils') || m.includes('soil type') || m.includes('drainage');
}

function soilsRedirect() {
  return "For soils questions, use the official soil map tool (Web Soil Survey) for your specific location.";
}

const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Simple health endpoint for Koyeb
app.get('/health', (req, res) => res.status(200).send('ok'));

// Chat endpoint your UI calls
app.post('/chat', async (req, res) => {
  try {
    const message = (req.body && req.body.message) ? String(req.body.message) : '';
    const wantCitations = !!(req.body && req.body.citations);

    if (!message.trim()) {
      return res.json({ success: true, answer: "Ask a Vermont forestry question." });
    }

    if (isSoilsQuestion(message)) {
      return res.json({ success: true, answer: soilsRedirect() });
    }

    if (!isInScope(message)) {
      return res.json({ success: true, answer: outOfScope() });
    }

    // “who wrote this / feedback” behavior you specified
    const m = message.toLowerCase();
    const asksAuthorshipOrFeedback =
      m.includes('who wrote') ||
      m.includes('who made') ||
      m.includes('who built') ||
      m.includes('feedback') ||
      m.includes('suggestion') ||
      m.includes('feature request') ||
      m.includes('contact') ||
      m.includes('email');

    if (asksAuthorshipOrFeedback) {
      return res.json({
        success: true,
        answer: "Please contact the developer with your questions or feedback (steve@northeastforests.com)."
      });
    }

    if (!client) {
      return res.status(500).json({
        success: false,
        error: "Server is missing OPENAI_API_KEY. Set it in Koyeb environment variables."
      });
    }
    if (!VECTOR_STORE_ID) {
      return res.status(500).json({
        success: false,
        error: "Server is missing VECTOR_STORE_ID. Set it in Koyeb environment variables."
      });
    }

    // Use Responses API + file_search tool with your vector store.
    // (This keeps answers grounded in your uploaded PDFs.)
    const instructions = [
      "You are the VT Woods App.",
      "You answer only Vermont forestry and Vermont forest products industry questions, using ONLY the provided documents in the vector store.",
      "If the user asks anything out of scope, respond with exactly: “Your request is beyond the scope and purpose of this app.”",
      "Use precise terminology. Say “forest products industry” (not “forestry industry”).",
      "Avoid speculation. Provide practical, field-ready steps/checklists when supported by the documents.",
      "Ask at most one clarifying question if needed.",
      "Only provide citations if the user explicitly requests them.",
      "If citations are requested, cite document title and page/section when possible."
    ].join("\n");

    const response = await client.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        { role: 'system', content: instructions },
        { role: 'user', content: message }
      ],
      tools: [{
        type: "file_search",
        vector_store_ids: [VECTOR_STORE_ID]
      }],
    });

    // Extract text
    let answerText = '';
    if (response.output && Array.isArray(response.output)) {
      for (const item of response.output) {
        if (item.type === 'message' && item.content) {
          for (const c of item.content) {
            if (c.type === 'output_text') answerText += c.text;
          }
        }
      }
    }
    answerText = answerText.trim() || "No answer returned.";

    // Citations only if requested
    let citations = [];
    if (wantCitations) {
      // Newer responses can contain annotations; keep this simple:
      // Return whatever the API gives us in a safe envelope.
      citations = response.output?.[0]?.content?.[0]?.annotations || [];
    }

    return res.json({
      success: true,
      answer: answerText,
      citations: wantCitations ? citations : undefined
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: String(err && err.message ? err.message : err)
    });
  }
});

// IMPORTANT: Listen on PORT (Koyeb injects this); never hardcode 3000 on hosting.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
