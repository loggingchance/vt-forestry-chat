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

/**
 * Allow embedding in Google Sites + vtwoods.xyz
 * Note: X-Frame-Options: ALLOWALL is non-standard but harmless; CSP is the real control.
 */
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://*.google.com https://sites.google.com https://www.vtwoods.xyz https://vtwoods.xyz"
  );
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  next();
});

// Serve static front-end from repo root (index.html lives here)
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

// --- REQUIRED BEHAVIOR STRINGS ---
function outOfScope() {
  // MUST MATCH EXACTLY
  return "Your request is beyond the scope and purpose of this app.";
}

function soilsRedirect() {
  return "For soils questions, use the official soil map tool (Web Soil Survey) for your specific location.";
}

// --- INTENT DETECTORS ---
function isSoilsQuestion(message) {
  const m = (message || '').toLowerCase();
  // broad on purpose: any soils/drainage/site-index style question should go to WSS
  return /\bsoil(s)?\b/.test(m) || m.includes('drainage') || m.includes('site index');
}

function asksAuthorshipOrFeedback(message) {
  const m = (message || '').toLowerCase();
  return (
    m.includes('who wrote') ||
    m.includes('who made') ||
    m.includes('who built') ||
    m.includes('who created') ||
    m.includes('feedback') ||
    m.includes('suggestion') ||
    m.includes('feature request') ||
    m.includes('contact') ||
    m.includes('email') ||
    m.includes('developer')
  );
}

/**
 * Vermont-only forestry scope gate.
 *
 * Key change vs your previous version:
 * - Do NOT require "vermont" to appear in the user's question.
 * - Do NOT require 2+ keyword hits.
 * - Instead, allow if it matches any Vermont-forestry topic signal,
 *   OR if it explicitly mentions Vermont/VT.
 */
function isInScope(message) {
  const m = (message || '').toLowerCase().trim();
  if (!m) return true;

  // If they explicitly mention Vermont/VT, treat as in-scope unless clearly unrelated.
  // (We still keep a tiny “obviously unrelated” blocklist.)
  if (/\bvermont\b/.test(m) || /\bvt\b/.test(m)) {
    const obviouslyUnrelated = [
      'recipe', 'dating', 'movie', 'tv show', 'bitcoin', 'stock', 'fantasy football',
      'porn', 'celebrity', 'astrology', 'horoscope'
    ];
    for (const w of obviouslyUnrelated) {
      if (m.includes(w)) return false;
    }
    return true;
  }

  // Topic signals (forestry + water quality + climate adaptation + forest products industry + VT programs/docs)
  // This list is intentionally broad and practical.
  const topicSignals = [
    // VT AMPs & water quality
    'amp', 'acceptable management practice', 'waterbar', 'turnout', 'broad-based dip',
    'stream crossing', 'crossing', 'culvert', 'bridge', 'portable bridge',
    'silt fence', 'seed', 'mulch', 'stabilization', 'erosion', 'sediment', 'rut', 'rutting',
    'ditch', 'drainage', 'buffer', 'riparian', 'wetland',

    // Forestry operations & silviculture
    'silviculture', 'silvicultural', 'regeneration', 'thinning', 'clearcut', 'shelterwood',
    'selection', 'group selection', 'patch cut', 'release', 'crop tree', 'marking',
    'basal area', 'tpa', 'qmd', 'stand improvement',
    'harvest', 'timber', 'logging', 'skid trail', 'landing', 'haul road', 'forest road',
    'forwarder', 'skidder', 'feller-buncher', 'processor', 'chainsaw',

    // Vermont forests & climate adaptation
    'climate adaptation', 'resilience', 'invasive', 'invasive species', 'deer browse',
    'drought', 'flood', 'ice storm', 'windthrow', 'blowdown',

    // Forest products industry
    'sawmill', 'mill', 'lumber', 'pulp', 'biomass', 'firewood', 'chips', 'pellets',
    'log market', 'stumpage', 'delivered', 'scale', 'board feet', 'cord',

    // Vermont-specific data/initiatives named in your sources list
    'forest action plan', 'fia', 'forest inventory', 'analysis', 'tree owner',
    'tree owner’s manual', 'tree owners manual'
  ];

  for (const s of topicSignals) {
    if (m.includes(s)) return true;
  }

  // Otherwise out of scope
  return false;
}

const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Health endpoint for Koyeb
app.get('/health', (req, res) => res.status(200).send('ok'));

// Chat endpoint used by your UI
app.post('/chat', async (req, res) => {
  try {
    const message = (req.body && req.body.message) ? String(req.body.message) : '';
    const wantCitations = !!(req.body && req.body.citations);

    if (!message.trim()) {
      return res.json({ success: true, answer: "Ask a Vermont forestry question." });
    }

    // feedback/author questions: respond with your exact desired line
    if (asksAuthorshipOrFeedback(message)) {
      return res.json({
        success: true,
        answer: "Please contact the developer with your questions or feedback (steve@northeastforests.com)."
      });
    }

    // soils questions: always redirect to official tool
    if (isSoilsQuestion(message)) {
      return res.json({ success: true, answer: soilsRedirect() });
    }

    // scope gate
    if (!isInScope(message)) {
      return res.json({ success: true, answer: outOfScope() });
    }

    // Server config checks
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

    // System instructions (your spec)
    const instructions = [
      "You are the VT Woods App.",
      "You are a Vermont-only forestry and forest products industry assistant.",
      "Use ONLY the provided documents in the vector store. Do not use outside knowledge.",
      "If the user asks anything out of scope, respond with exactly: “Your request is beyond the scope and purpose of this app.”",
      "Use precise terminology. Use “forest products industry” (not “forestry industry”).",
      "Avoid speculation or nontechnical language.",
      "Ask at most one clarifying question when needed.",
      "Provide practical, field-ready outputs (steps, checklists, decision rules) only when supported by the documents.",
      "For soils-related questions, the app must refer the user to the official soil map tool (Web Soil Survey).",
      "Only provide citations when explicitly requested.",
      "If citations are requested, cite document titles and relevant sections/pages when possible."
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

    // Extract model text safely
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

    // Citations only if requested (pass through annotations if present)
    let citations;
    if (wantCitations) {
      const firstMsg = (response.output || []).find(x => x.type === 'message');
      const firstText = firstMsg?.content?.find(c => c.type === 'output_text');
      citations = firstText?.annotations || [];
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

// IMPORTANT: listen on injected PORT for hosting
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
