const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({limit: '10mb'}));
app.use(express.static(path.join(__dirname, 'public')));

// READ KEY FROM RENDER ENVIRONMENT
const GROQ_KEY = process.env.GROQ_KEY;

app.post('/api/generate', async (req, res) => {
  const { prompt } = req.body;
  
  // ===== DEBUG LOGS START =====
  console.log("DEBUG KEY EXISTS:", !!GROQ_KEY); 
  console.log("DEBUG KEY LENGTH:", GROQ_KEY?.length); // should be 56
  console.log("DEBUG KEY START:", GROQ_KEY?.substring(0,12)); // should be gsk_xxxxxx
  // ===== DEBUG LOGS END =====

  const fullPrompt = `You are an expert web developer. Generate a complete, beautiful, single-file HTML website based on this request: "${prompt}"
Rules:
1. Return ONLY the HTML code. No explanations, no \`\`\`html
2. Use TailwindCSS via CDN: <script src="https://cdn.tailwindcss.com"></script>
3. Make it modern, responsive, with animations, hero, features, pricing, and footer`;

  try {
    const aiRes = await fetch(`https://api.groq.com/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.1-70b-versatile",
        messages: [{ role: "user", content: fullPrompt }],
        temperature: 0.7,
        max_tokens: 4000
      })
    });

    console.log("DEBUG GROQ HTTP STATUS:", aiRes.status); // 200 = ok, 401 = bad key
    
    const aiData = await aiRes.json();
    console.log("DEBUG GROQ ERROR:",