const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { exec } = require('child_process');
const app = express();

app.use(cors());
app.use(express.json({limit: '10mb'}));
app.use(express.static('public'));

app.get('/', (req, res) => res.send("Walker Webs AI Backend Running - Groq"));

// PASTE YOUR GROQ KEY HERE
const GROQ_KEY = process.env.GROQ_KEY;

app.post('/api/generate', async (req, res) => {
  const { prompt } = req.body;

  const fullPrompt = `You are an expert web developer. Generate a complete, beautiful, single-file HTML website based on this request: "${prompt}"
Rules:
1. Return ONLY the HTML code. No explanations, no \`\`html
2. Use TailwindCSS via CDN: <script src="https://cdn.tailwindcss.com"></script>
3. Make it modern, responsive, with animations, hero, features, and footer`;

  try {
    const aiRes = await fetch(`https://api.groq.com/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: "openai/gpt-oos-120b",
        messages: [{ role: "user", content: fullPrompt }],
        temperature: 0.7,
        max_tokens: 4000
      })
    });

    const aiData = await aiRes.json();

    console.log("Groq Response:", aiData); // DEBUG: check Render Logs

    // CHECK IF GROQ RETURNED AN ERROR
    if(aiData.error) {
      return res.status(500).json({error: aiData.error.message})
    }

    if(!aiData.choices ||!aiData.choices[0]) {
      return res.status(500).json({error: "Groq returned empty. Full response: " + JSON.stringify(aiData)})
    }

    let html = aiData.choices[0].message.content;
    html = html.replace(/```html/g, '').replace(/```/g, ''); // remove markdown

    res.json({html});

  } catch(e) {
    console.error(e);
    res.status(500).json({error: e.message})
  }
});

app.post('/api/publish', async (req, res) => {
  const { projectId, html } = req.body;
  try {
    const path = `./public/p/${projectId}`;
    fs.mkdirSync(path, { recursive: true });
    fs.writeFileSync(`${path}/index.html`, html);
    exec(`firebase deploy --only hosting --project walker --force`, (err, stdout, stderr) => {
      if(err) return res.status(500).json({error: stderr});
      res.json({url: `https://walker.web.app/p/${projectId}`});
    });
  } catch(e) {
    res.status(500).json({error: e.message})
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Running on ${port}`));