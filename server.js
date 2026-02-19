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

// Environment variables from Koyeb
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID || '';

// REPLACE THIS with your actual asst_... ID from the OpenAI dashboard
const ASSISTANT_ID = process.env.ASSISTANT_ID || 'YOUR_ASSISTANT_ID_HERE';

const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Security headers for iframe embedding
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://*.google.com https://sites.google.com https://www.vtwoods.xyz https://vtwoods.xyz"
  );
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  next();
});

// Serve static front-end files
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

// Special scope helper functions
function isSoilsQuestion(message) {
  const m = (message || '').toLowerCase();
  return /\bsoil(s)?\b/.test(m) || /\bdrainage\s+class\b/.test(m) || /\bweb\s*soil\s*survey\b/.test(m);
}

function asksAuthorshipOrFeedback(message) {
  const m = (message || '').toLowerCase();
  return (
    m.includes('who wrote') || m.includes('who made') || m.includes('feedback') || m.includes('contact')
  );
}

app.get('/health', (req, res) => res.status(200).send('ok'));

app.post('/chat', async (req, res) => {
  try {
    const message = (req.body && req.body.message) ? String(req.body.message) : '';
    
    if (!message.trim()) return res.json({ success: true, answer: "Ask a Vermont forestry question." });

    if (asksAuthorshipOrFeedback(message)) {
      return res.json({ success: true, answer: "Contact the developer at steve@northeastforests.com." });
    }

    if (isSoilsQuestion(message)) {
      return res.json({ success: true, answer: "For soils, use the official Web Soil Survey tool." });
    }

    if (!client || !VECTOR_STORE_ID || !ASSISTANT_ID || ASSISTANT_ID === 'YOUR_ASSISTANT_ID_HERE') {
      return res.status(500).json({ success: false, error: "Missing API Key, Vector Store ID, or Assistant ID in Koyeb." });
    }

    // 1. Create a Thread with the Vector Store attached
    const thread = await client.beta.threads.create({
      tool_resources: { file_search: { vector_store_ids: [VECTOR_STORE_ID] } }
    });

    // 2. Add user message
    await client.beta.threads.messages.create(thread.id, { role: "user", content: message });

    // 3. Run the Assistant and poll for completion
    const run = await client.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: ASSISTANT_ID,
      instructions: "You are the VT Woods App. Use ONLY the provided documents. Use precise terminology like 'forest products industry'."
    });

    // 4. Retrieve results
    if (run.status === 'completed') {
      const messages = await client.beta.threads.messages.list(thread.id);
      const answer = messages.data[0].content[0].text.value;
      return res.json({ success: true, answer: answer });
    } else {
      return res.status(500).json({ success: false, error: "Run status: " + run.status });
    }

  } catch (err) {
    console.error("Chat Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
