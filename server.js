// server.js - GROQ VERSION FIXED
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors({ origin: "*" })); // Allow Netlify to call Render
app.use(express.json());

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

app.get("/", (req, res) => res.send("✅ Walker Webs AI with GROQ Running"));

app.post("/api/generate", async (req, res) => {
  const { prompt } = req.body;
  if(!prompt) return res.status(400).json({error: "Prompt is required"});

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile", // <-- CHANGED THIS. New model
      messages: [
        { role: "system", content: "You are an expert web developer. Return ONLY a complete single-file HTML document with inline Tailwind CSS. No explanations, no markdown fences. Dark theme, modern, responsive, glassmorphism." },
        { role: "user", content: `Build me this website: ${prompt}` }
      ],
      temperature: 0.7,
      max_tokens: 3000
    });

    let html = completion.choices[0].message.content;
    html = html.replace(/```html/g, "").replace(/```/g, "").trim();
    res.json({ html });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Groq AI running on ${PORT}`));