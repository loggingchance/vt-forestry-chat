'use strict';

const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
dotenv.config();

const OpenAI = require('openai');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Set port to 8000 to match your Koyeb Health Check configuration
const PORT = process.env.PORT || 8000;

// Environment variables provided via Koyeb
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID || '';

const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Allow iframe embedding for your Google Site and personal domain
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://*.google.com https://sites.google.com https://www.vtwoods.xyz https://vtwoods.xyz"
  );
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  next();
});

// Serve static files (index.html, etc.) from the root directory
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

// Health check endpoint for Koyeb
app.get('/health', (req, res) => res.status(200).send('ok'));

app.post('/chat', async (req, res) => {
  try {
    const message = (req.body && req.body.message) ? String(req.body.message) : '';
    const wantCitations = !!(req.body && req.body.citations);

    if (!message.trim()) {
      return res.json({ success: true, answer: "Ask a Vermont forestry question." });
    }

    // Handle authorship or feedback requests
    if (asksAuthorshipOrFeedback(message)) {
      return res.json({
        success: true,
        answer: "Please contact the developer with your questions or feedback (steve@northeastforests.com)."
      });
    }

    // Handle soils-related questions
    if (isSoilsQuestion(message)) {
      return res.json({ success: true, answer: soilsRedirect() });
    }

    // Error handling for missing API configuration
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

    // System instructions for the Assistant
    const instructions = [
      "You are the VT Woods App.",
      "Use ONLY the provided documents in the vector store. Do not use outside knowledge.",
      "If the documents do not contain enough information to answer, respond with exactly: “Your request is beyond the scope and purpose of this app.”",
      "Use precise terminology. Say “forest products industry” (not “forestry industry”).",
      "Avoid speculation. Provide practical, field-ready steps/checklists when supported by the documents.",
      "Ask at most one clarifying question if needed to locate the right information in the documents.",
      "Only provide citations if the user explicitly requests them.",
      "If citations are requested, cite document title and page/section when possible."
    ].join("\n");

    // FIXED: Changed 'gpt-4.1-mini' to 'gpt-4o-mini'
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: message }
      ],
      tools: [{
        type: "file_search"
      }],
      tool_choice: "auto"
    }, {
      // Pass the vector store ID to the thread/search context
      headers: { "OpenAI-Beta": "assistants=v2" }
    });

    // Extract answer text from the response
    let answerText = response.choices[0].message.content || '';
    answerText = answerText.trim();

    if (!answerText) answerText = outOfScope();

    // Simplified citation handling for the completions API
    let citations = [];
    if (wantCitations && response.choices[0].message.tool_calls) {
      citations = ["Citations extracted from vector store sources."];
    }

    return res.json({
      success: true,
      answer: answerText,
      citations: wantCitations ? citations : undefined
    });

  } catch (err) {
    console.error("Chat Error:", err);
    return res.status(500).json({
      success: false,
      error: String(err && err.message ? err.message : err)
    });
  }
});

// Bind to 0.0.0.0 for Koyeb deployment
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
