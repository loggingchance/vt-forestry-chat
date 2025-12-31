'use strict';

const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
dotenv.config();

const OpenAI = require('openai');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8000;

// Set on Koyeb
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID || '';

const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Allow iframe embedding (Google Sites)
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://*.google.com https://sites.google.com https://www.vtwoods.xyz https://vtwoods.xyz"
  );
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  next();
});

// Static front-end (index.html etc.)
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

function outOfScope() {
  return "Your request is beyond the scope and purpose of this app.";
}

function isSoilsQuestion(message) {
  const m = (message || '').toLowerCase();
  return /\bsoil(s)?\b/.test(m) || /\bdrainage\s+class\b/.test(m) || /\bweb\s*soil\s*survey\b/.test(m);
}
function soilsRedirect() {
  return "For soils questions, use the official soil map tool (Web Soil Survey) for your specific location.";
}

function asksAuthorshipOrFeedback(message) {
  const m = (message || '').toLowerCase();
  return (
    m.includes('who wrote') ||
    m.includes('who made') ||
    m.includes('who built') ||
    m.includes('feedback') ||
    m.includes('suggestion') ||
    m.includes('feature request') ||
    m.includes('contact') ||
    m.includes('email') ||
    m.includes('developer')
  );
}

/**
 * Gate-by-retrieval:
 * We first run file_search against the vector store.
 * If retrieval returns nothing (or clearly irrelevant), we refuse.
 * This ensures: "Anything in the knowledge base is answerable"
 * without guessing keywords.
 */
async function retrievalLooksRelevant(message) {
  // Use a cheap model to run ONLY the tool call and judge results.
  // Important: we do not answer here; we only decide scope based on retrieval.
  const gate = await client.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      {
        role: 'system',
        content:
          "You are a strict gatekeeper. Use the file_search tool to retrieve from the vector store. " +
          "Decide if the retrieved excerpts contain enough information to answer the user's question. " +
          "Return only JSON: {\"relevant\":true|false, \"why\":\"short\"}. " +
          "Relevant=true if excerpts clearly match the question topic; otherwise false."
      },
      { role: 'user', content: message }
    ],
    tools: [{
      type: "file_search",
      vector_store_ids: [VECTOR_STORE_ID]
    }],
    // Encourage the model to actually use the tool
    tool_choice: "auto"
  });

  // Extract the model’s JSON decision text
  let txt = '';
  for (const item of (gate.output || [])) {
    if (item.type === 'message' && item.content) {
      for (const c of item.content) {
        if (c.type === 'output_text') txt += c.text;
      }
    }
  }
  txt = (txt || '').trim();

  // Safe parse
  try {
    const obj = JSON.parse(txt);
    return !!obj.relevant;
  } catch {
    // If parsing fails, default conservative: treat as NOT relevant
    return false;
  }
}

app.get('/health', (req, res) => res.status(200).send('ok'));

app.post('/chat', async (req, res) => {
  try {
    const message = (req.body && req.body.message) ? String(req.body.message) : '';
    const wantCitations = !!(req.body && req.body.citations);

    if (!message.trim()) {
      return res.json({ success: true, answer: "Ask a Vermont forestry question." });
    }

    if (asksAuthorshipOrFeedback(message)) {
      return res.json({
        success: true,
        answer: "Please contact the developer with your questions or feedback (steve@northeastforests.com)."
      });
    }

    if (isSoilsQuestion(message)) {
      return res.json({ success: true, answer: soilsRedirect() });
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

    // >>> Scope is determined by the knowledge base itself <<<
    const ok = await retrievalLooksRelevant(message);
    if (!ok) {
      return res.json({ success: true, answer: outOfScope() });
    }

    // Now answer using ONLY the vector store
    const instructions = [
      "You are the VT Woods App.",
      "You answer only questions supported by the provided documents in the vector store. Do not use outside knowledge.",
      "If the documents do not support an answer, respond with exactly: “Your request is beyond the scope and purpose of this app.”",
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

    // Extract answer text
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
    answerText = (answerText || '').trim() || "No answer returned.";

    // Citations only if requested
    let citations = [];
    if (wantCitations) {
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
